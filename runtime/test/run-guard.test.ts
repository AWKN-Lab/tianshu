import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { closeDb, getDb } from '../src/store/db.js';
import { EventStore } from '../src/workflow/event-store.js';
import { acquirePipelineSlot, isActiveRunStatus, withPipelineMutex } from '../src/action/run-guard.js';
import { killProcessTree, runShellStep } from '../src/action/steps/shell-step.js';

let tempDir: string | undefined;

async function store(): Promise<EventStore> {
  tempDir = tempDir ?? await mkdtemp(join(tmpdir(), 'run-guard-'));
  const dbPath = join(tempDir, `${randomUUID()}.db`);
  process.env.AWKN_DB_PATH = dbPath;
  closeDb();
  getDb();
  return new EventStore();
}

describe('run-guard — 运行守卫（P0-5）', () => {
  it('同 SHA 旧活跃 run 被取代（取消），新 run 放行', async () => {
    const es = await store();
    const oldRun = es.createRun({ workflowName: 'action:ci', payload: { commitSha: 'a'.repeat(40) } });
    es.transitionRun(oldRun.id, 'running');
    const slot = acquirePipelineSlot(es, 'action:ci', 'a'.repeat(40));
    assert.equal(slot.decision, 'proceed');
    assert.deepEqual(slot.cancelled, [oldRun.id]);
    assert.equal(es.readRun(oldRun.id)?.status, 'cancelled');
  });

  it('不同 SHA 的活跃 run 触发并发锁 busy', async () => {
    const es = await store();
    const other = es.createRun({ workflowName: 'action:ci', payload: { commitSha: 'b'.repeat(40) } });
    es.transitionRun(other.id, 'running');
    const slot = acquirePipelineSlot(es, 'action:ci', 'a'.repeat(40));
    assert.equal(slot.decision, 'busy');
    assert.equal(slot.activeRunId, other.id);
  });

  it('无活跃 run 时直接放行', async () => {
    const es = await store();
    const slot = acquirePipelineSlot(es, 'action:ci', 'a'.repeat(40));
    assert.equal(slot.decision, 'proceed');
    assert.equal(slot.cancelled.length, 0);
  });

  it('已终止的 run 不阻塞新运行', async () => {
    const es = await store();
    const done = es.createRun({ workflowName: 'action:ci', payload: { commitSha: 'a'.repeat(40) } });
    es.transitionRun(done.id, 'running');
    es.transitionRun(done.id, 'succeeded');
    const slot = acquirePipelineSlot(es, 'action:ci', 'a'.repeat(40));
    assert.equal(slot.decision, 'proceed');
  });

  it('isActiveRunStatus 识别活跃状态', () => {
    assert.equal(isActiveRunStatus('running'), true);
    assert.equal(isActiveRunStatus('queued'), true);
    assert.equal(isActiveRunStatus('succeeded'), false);
    assert.equal(isActiveRunStatus('cancelled'), false);
  });

  it('进程内互斥串行执行同 workflow', async () => {
    const order: string[] = [];
    const first = withPipelineMutex('ci', async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('first-end');
    });
    const second = withPipelineMutex('ci', async () => {
      order.push('second-start');
      order.push('second-end');
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
  });
});

describe('shell-step — 超时与进程树清理（P0-5）', () => {
  it('普通命令成功执行', async () => {
    const result = await runShellStep({ name: 'echo', type: 'shell', command: 'echo hello' }, tmpdir());
    assert.equal(result.status, 'passed');
    assert.ok(result.output.includes('hello'));
  });

  it('失败命令返回 exitCode 与脱敏输出', async () => {
    const result = await runShellStep({ name: 'fail', type: 'shell', command: 'echo TOKEN=SuperSecret && exit 3' }, tmpdir());
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 3);
    assert.ok(!result.output.includes('SuperSecret'));
  });

  it('超时后失败并终止进程', async () => {
    const result = await runShellStep(
      { name: 'sleep', type: 'shell', command: process.platform === 'win32' ? 'ping -n 5 127.0.0.1' : 'sleep 5', timeout: 1 },
      tmpdir(),
    );
    assert.equal(result.status, 'failed');
    assert.ok((result.output + '').includes('timed out') || result.exitCode !== 0);
  });

  it('killProcessTree 对非法 PID 不抛错', () => {
    assert.doesNotThrow(() => killProcessTree(-1));
    assert.doesNotThrow(() => killProcessTree(0));
  });
});
