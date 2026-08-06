/**
 * Cron Worker 失败指标单测 — 验证失败/重试路径更新 failed_count / last_attempt_at
 *
 * P1（plan-runtime-governance-loop-2026-08-06）：worker.ts 失败路径更新
 * `last_attempt_at`/`failed_count`（migration v22）；`run_count` 保持"成功次数"语义。
 *
 * 运行：node --import tsx --test test/cron-worker-metrics.test.ts
 *
 * 覆盖：
 * 1. 成功路径：run_count +1、last_attempt_at 更新、failed_count 不变
 * 2. 失败（非瞬时错误 → dead）：failed_count +1、last_attempt_at 更新、run_count 不变
 * 3. 重试（瞬时错误 → retry）：last_attempt_at 更新、failed_count 不变
 * 4. 重试耗尽 → dead：failed_count 累计一次
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getDb, closeDb } from '../src/store/db.js';
import { CronJobsManager } from '../src/cron/jobs-manager.js';
import { CronWorker } from '../src/cron/worker.js';
import { CronWorkStore } from '../src/cron/work-store.js';
import type { CronActionSnapshot } from '../src/cron/action-executor.js';
import type { CronJobRow } from '../src/store/schema.js';

const TEST_DB_PATH = resolve(
  mkdtempSync(resolve(tmpdir(), 'cron-metrics-test-')),
  `test-cron-metrics-${process.pid}.db`,
);

beforeEach(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }
  getDb(TEST_DB_PATH);
});

afterEach(() => {
  closeDb();
});

function addJob(name: string): CronJobRow {
  const manager = new CronJobsManager();
  const job = manager.add({
    name,
    cronExpr: '0 * * * *',
    actionType: 'http',
    actionPayload: { url: 'http://127.0.0.1:1/health', method: 'GET' },
  });
  return job;
}

function snapshot(): CronActionSnapshot {
  return {
    actionType: 'http',
    payload: { url: 'http://127.0.0.1:1/health', method: 'GET' },
  };
}

function workerStore(worker: CronWorker): CronWorkStore {
  return (worker as unknown as { store: CronWorkStore }).store;
}

function readJob(jobId: string): CronJobRow {
  const row = getDb().prepare('SELECT * FROM cron_jobs WHERE id = ?').get(jobId) as CronJobRow;
  assert.ok(row, 'job should exist');
  return row;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function runOnce(
  job: CronJobRow,
  executor: (s: CronActionSnapshot, k: string) => Promise<string>,
  maxAttempts = 1,
): Promise<{ ok: boolean }> {
  const worker = new CronWorker(getDb(), executor, `worker-test-${randomUUID()}`, 30_000);
  const store = workerStore(worker);
  const item = store.enqueue({
    jobId: job.id,
    idempotencyKey: `${job.id}:metrics-test:${randomUUID()}`,
    payload: snapshot(),
    maxAttempts,
  });
  return worker.processById(item.id);
}

describe('CronWorker 失败指标（P1: failed_count / last_attempt_at）', () => {
  it('成功路径：run_count +1、last_attempt_at 更新、failed_count 不变', async () => {
    const job = addJob('metrics-success');
    const before = readJob(job.id);
    assert.equal(before.run_count, 0);
    assert.equal(before.failed_count, 0);
    assert.equal(before.last_attempt_at, null);

    const result = await runOnce(job, async () => 'HTTP 200 ok');
    assert.equal(result.ok, true);

    const after = readJob(job.id);
    assert.equal(after.run_count, 1);
    assert.equal(after.failed_count, 0);
    assert.ok(after.last_attempt_at, 'last_attempt_at should be set');
    assert.ok(after.last_run_at, 'last_run_at should be set');
  });

  it('失败（非瞬时 → dead）：failed_count +1、last_attempt_at 更新、run_count 不变', async () => {
    const job = addJob('metrics-dead');
    const result = await runOnce(job, async () => {
      throw new Error('syntax error in payload');
    });
    assert.equal(result.ok, false);

    const after = readJob(job.id);
    assert.equal(after.run_count, 0, 'run_count stays 0 on failure');
    assert.equal(after.failed_count, 1, 'failed_count increments on dead');
    assert.ok(after.last_attempt_at, 'last_attempt_at should be set on failure');
    assert.equal(after.last_run_at, null, 'last_run_at stays null on failure');
  });

  it('重试（瞬时 → retry）：last_attempt_at 更新、failed_count 不变', async () => {
    const job = addJob('metrics-retry');
    const result = await runOnce(job, async () => {
      throw new Error('temporarily unavailable: upstream 503');
    }, 3);
    assert.equal(result.ok, false);

    const after = readJob(job.id);
    assert.equal(after.run_count, 0);
    assert.equal(after.failed_count, 0, 'retry is not a failure yet');
    assert.ok(after.last_attempt_at, 'last_attempt_at should be set on retry');
  });

  it('重试耗尽 → dead：failed_count 累计一次', async () => {
    const job = addJob('metrics-retry-exhausted');
    const worker = new CronWorker(getDb(), async () => {
      throw new Error('temporarily unavailable: upstream 503');
    }, `worker-test-${randomUUID()}`, 30_000);
    const store = workerStore(worker);
    const item = store.enqueue({
      jobId: job.id,
      idempotencyKey: `${job.id}:metrics-test:${randomUUID()}`,
      payload: snapshot(),
      maxAttempts: 3,
    });

    // attempt 1 → retry（backoff 1s），attempt 2 → retry（backoff 2s），attempt 3 → dead
    const deadline = Date.now() + 10_000;
    let attempts = 0;
    while (Date.now() < deadline) {
      const current = store.get(item.id);
      assert.ok(current, 'work item should exist');
      if (current.status === 'dead') break;
      if (current.status === 'queued' || new Date(current.available_at).getTime() <= Date.now()) {
        const result = await worker.processById(item.id);
        assert.equal(result.ok, false);
        attempts += 1;
      } else {
        await sleep(100);
      }
    }
    assert.equal(attempts, 3, `expected 3 attempts before dead, got ${attempts}`);

    const final = store.get(item.id);
    assert.equal(final?.status, 'dead', 'work item should be dead after exhausting retries');

    const after = readJob(job.id);
    assert.equal(after.failed_count, 1, 'dead after exhausting retries counts as one failure');
    assert.equal(after.run_count, 0);
    assert.ok(after.last_attempt_at, 'last_attempt_at set after exhaust');
  });
});
