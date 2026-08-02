import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { closeDb, getDb, queryOne } from '../src/store/db.js';
import { EventStore, GLOBAL_LOCK_DEFAULT_LEASE_MS } from '../src/workflow/event-store.js';
import { acquireGlobalPipelineLock, releaseGlobalPipelineLock } from '../src/action/run-guard.js';

let tempDir: string | undefined;

async function store(): Promise<EventStore> {
  tempDir = tempDir ?? await mkdtemp(join(tmpdir(), 'global-lock-'));
  const dbPath = join(tempDir, `${randomUUID()}.db`);
  process.env.AWKN_DB_PATH = dbPath;
  closeDb();
  getDb();
  return new EventStore();
}

describe('global lock — 跨项目 pipeline 互斥（P95 遗留项）', () => {
  it('首持锁成功，异 owner 并发抢占失败', async () => {
    const es = await store();
    const first = es.acquireGlobalLock('pipeline-global', 'pipeline:a:abc');
    assert.equal(first.acquired, true);
    assert.equal(first.renewed, false);
    const second = es.acquireGlobalLock('pipeline-global', 'pipeline:b:def');
    assert.equal(second.acquired, false);
    assert.equal(second.leaseExpiresAt, first.leaseExpiresAt);
  });

  it('同 owner 重入幂等成功（renewed=true 且租期续延）', async () => {
    const es = await store();
    es.acquireGlobalLock('pipeline-global', 'owner-x', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const renew = es.acquireGlobalLock('pipeline-global', 'owner-x', 30_000);
    assert.equal(renew.acquired, true);
    assert.equal(renew.renewed, true);
    const row = queryOne<{ lease_expires_at: string }>(
      'SELECT lease_expires_at FROM global_locks WHERE lock_name = ?',
      ['pipeline-global'],
    );
    assert.ok(row!.lease_expires_at > new Date().toISOString());
  });

  it('lease 过期后自动接管', async () => {
    const es = await store();
    es.acquireGlobalLock('pipeline-global', 'stale-owner', 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const takeover = es.acquireGlobalLock('pipeline-global', 'new-owner', 30_000);
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.renewed, false);
  });

  it('release 仅释放匹配 owner 的锁', async () => {
    const es = await store();
    es.acquireGlobalLock('pipeline-global', 'owner-a', 30_000);
    assert.equal(es.releaseGlobalLock('pipeline-global', 'owner-b'), false);
    assert.equal(es.releaseGlobalLock('pipeline-global', 'owner-a'), true);
    const after = es.acquireGlobalLock('pipeline-global', 'owner-c', 30_000);
    assert.equal(after.acquired, true);
  });

  it('run-guard 包装函数与 store 一致', async () => {
    const es = await store();
    assert.equal(acquireGlobalPipelineLock(es, 'pipeline:ci:aaa'), true);
    assert.equal(acquireGlobalPipelineLock(es, 'pipeline:ci:bbb'), false);
    releaseGlobalPipelineLock(es, 'pipeline:ci:aaa');
    assert.equal(acquireGlobalPipelineLock(es, 'pipeline:ci:bbb'), true);
  });

  it('不同锁名互不阻塞', async () => {
    const es = await store();
    assert.equal(es.acquireGlobalLock('pipeline-global', 'owner-a').acquired, true);
    assert.equal(es.acquireGlobalLock('test-other', 'owner-a').acquired, true);
  });

  it('默认租期常量为 30s', () => {
    assert.equal(GLOBAL_LOCK_DEFAULT_LEASE_MS, 30_000);
  });
});
