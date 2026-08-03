/**
 * Hermes Provider 契约测试 — SHADOW 模式验证
 *
 * Spiral 5: 验证 HermesWorkerProvider 在 SHADOW 模式下（StubHermesCliPort）的
 * 接口契约完整性。不依赖真实 Hermes CLI。
 *
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 5
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HermesWorkerProvider } from '../src/worker/hermes/hermes-worker-provider.js';
import { StubHermesCliPort } from '../src/worker/hermes/hermes-cli-port.js';
import { HermesEventAdapter } from '../src/worker/hermes/hermes-event-adapter.js';
import type { WorkerSpawnRequest } from '../src/contracts/workflow-v2.js';
import type { HermesDeadLetterEntry } from '../src/worker/hermes/hermes-cli-port.js';

function makeSpawnRequest(): WorkerSpawnRequest {
  return {
    schema: 'awkn-worker-spawn-request/v1',
    stageRunId: 'stage-run-test-001',
    profileId: 'hermes-profile-001',
    frozenInputHash: 'a'.repeat(64),
    workspaceId: 'ws-test-001',
    toolPolicyRef: 'tool-policy-001',
    authorizationEnvelopeId: 'awkn-env-test0000000000000000000001',
    idempotencyKey: 'idem-key-001',
  };
}

describe('Hermes Provider 契约测试 (SHADOW 模式)', () => {
  it('probe 返回有效 CapabilityReceipt，providerId=hermes', async () => {
    const cli = new StubHermesCliPort();
    const provider = new HermesWorkerProvider(cli);
    const receipt = await provider.probe();
    assert.equal(receipt.schema, 'awkn-worker-capability/v1');
    assert.equal(receipt.providerId, 'hermes');
    assert.ok(receipt.maxConcurrentRuns > 0);
    assert.ok(receipt.supportedSpecialties.length > 0);
    assert.ok(receipt.supportedSpecialties.includes('IMPLEMENT'));
    assert.ok(receipt.heartbeatIntervalMs > 0);
  });

  it('spawn 返回有效 SpawnReceipt，providerRunId 非空', async () => {
    const cli = new StubHermesCliPort();
    const provider = new HermesWorkerProvider(cli);
    const receipt = await provider.spawn(makeSpawnRequest());
    assert.equal(receipt.schema, 'awkn-worker-spawn-receipt/v1');
    assert.equal(receipt.providerId, 'hermes');
    assert.ok(receipt.providerRunId.length > 0);
    assert.ok(receipt.actorId.length > 0);
    assert.ok(receipt.sessionId.length > 0);
    assert.ok(receipt.spawnedAt.length > 0);
  });

  it('inspect 返回映射后的 AWKN 状态', async () => {
    const cli = new StubHermesCliPort();
    const provider = new HermesWorkerProvider(cli);
    const spawnReceipt = await provider.spawn(makeSpawnRequest());
    const inspectResult = await provider.inspect(spawnReceipt.providerRunId);
    // SHADOW 模式下 Hermes 状态为 running → AWKN RUNNING
    assert.equal(inspectResult.state, 'RUNNING');
    assert.ok(inspectResult.lastHeartbeatAt.length > 0);
  });

  it('heartbeat 返回 alive 状态（SHADOW 模式）', async () => {
    const cli = new StubHermesCliPort();
    const provider = new HermesWorkerProvider(cli);
    const spawnReceipt = await provider.spawn(makeSpawnRequest());
    const hb = await provider.heartbeat(spawnReceipt.providerRunId);
    assert.equal(hb.schema, 'awkn-worker-heartbeat/v1');
    assert.equal(hb.providerRunId, spawnReceipt.providerRunId);
    assert.ok(hb.status === 'alive' || hb.status === 'busy' || hb.status === 'stale');
    assert.ok(hb.observedAt.length > 0);
  });

  it('cancel 返回有效 CancelReceipt（委托 reclaim）', async () => {
    const cli = new StubHermesCliPort();
    const provider = new HermesWorkerProvider(cli);
    const spawnReceipt = await provider.spawn(makeSpawnRequest());
    const cancelReceipt = await provider.cancel(spawnReceipt.providerRunId, 'test-cancel');
    assert.equal(cancelReceipt.schema, 'awkn-worker-cancel/v1');
    assert.equal(cancelReceipt.providerRunId, spawnReceipt.providerRunId);
    assert.equal(cancelReceipt.reason, 'test-cancel');
    assert.ok(cancelReceipt.cancelledAt.length > 0);
  });

  it('collect 返回 SUCCESS conclusion（SHADOW 模式无 dead-letter）', async () => {
    const cli = new StubHermesCliPort();
    const provider = new HermesWorkerProvider(cli);
    const spawnReceipt = await provider.spawn(makeSpawnRequest());
    const result = await provider.collect(spawnReceipt.providerRunId);
    assert.equal(result.schema, 'awkn-worker-result/v1');
    assert.equal(result.providerRunId, spawnReceipt.providerRunId);
    assert.equal(result.conclusion, 'SUCCESS');
    assert.ok(result.outputReceiptId.length > 0);
    assert.ok(result.completedAt.length > 0);
  });

  it('collect 有 dead-letter 时返回 FAILURE conclusion', async () => {
    const cli = new StubHermesCliPort();
    const provider = new HermesWorkerProvider(cli);
    const spawnReceipt = await provider.spawn(makeSpawnRequest());

    // 注入 dead-letter
    const deadLetter: HermesDeadLetterEntry = {
      hermesRunId: spawnReceipt.providerRunId,
      reason: 'max retries exceeded',
      deadLetteredAt: new Date().toISOString(),
      originalPrompt: 'test-prompt',
    };
    cli._injectDeadLetter(deadLetter);

    const result = await provider.collect(spawnReceipt.providerRunId);
    assert.equal(result.conclusion, 'FAILURE');
  });
});

describe('HermesEventAdapter 状态映射', () => {
  const adapter = new HermesEventAdapter();

  it('Hermes pending → AWKN ASSIGNED', () => {
    assert.equal(adapter.mapHermesStateToAwknState('pending'), 'ASSIGNED');
  });

  it('Hermes running → AWKN RUNNING', () => {
    assert.equal(adapter.mapHermesStateToAwknState('running'), 'RUNNING');
  });

  it('Hermes completed → AWKN PASSED', () => {
    assert.equal(adapter.mapHermesStateToAwknState('completed'), 'PASSED');
  });

  it('Hermes failed → AWKN FAILED', () => {
    assert.equal(adapter.mapHermesStateToAwknState('failed'), 'FAILED');
  });

  it('Hermes reclaimed → AWKN ROLLED_BACK', () => {
    assert.equal(adapter.mapHermesStateToAwknState('reclaimed'), 'ROLLED_BACK');
  });

  it('Hermes dead_lettered → AWKN QUARANTINED', () => {
    assert.equal(adapter.mapHermesStateToAwknState('dead_lettered'), 'QUARANTINED');
  });

  it('dead-letter 原因映射为 quarantine 原因', () => {
    const reason = adapter.mapDeadLetterReasonToQuarantineReason('timeout');
    assert.ok(reason.includes('hermes-dead-letter'));
    assert.ok(reason.includes('timeout'));
  });

  it('有 dead-letter 时 conclusion 强制为 FAILURE', () => {
    assert.equal(adapter.mapHermesConclusionToAwknConclusion('SUCCESS', true), 'FAILURE');
    assert.equal(adapter.mapHermesConclusionToAwknConclusion('PARTIAL', true), 'FAILURE');
  });

  it('无 dead-letter 时 conclusion 保持原值', () => {
    assert.equal(adapter.mapHermesConclusionToAwknConclusion('SUCCESS', false), 'SUCCESS');
    assert.equal(adapter.mapHermesConclusionToAwknConclusion('FAILURE', false), 'FAILURE');
    assert.equal(adapter.mapHermesConclusionToAwknConclusion('PARTIAL', false), 'PARTIAL');
  });
});

describe('StubHermesCliPort SHADOW 行为', () => {
  it('probe 返回 available=false, machineReadable=false', async () => {
    const cli = new StubHermesCliPort();
    const result = await cli.probe();
    assert.equal(result.available, false);
    assert.equal(result.machineReadable, false);
  });

  it('spawn/inspect/collect 完整流程不抛异常', async () => {
    const cli = new StubHermesCliPort();
    const spec = {
      profileName: 'test-profile',
      prompt: 'test-prompt',
      workspacePath: '/tmp/test',
      maxAttempts: 3,
      timeoutMs: 300_000,
      idempotencyKey: 'idem-001',
    };
    const spawnResult = await cli.spawn(spec);
    assert.ok(spawnResult.hermesRunId.length > 0);

    const inspectResult = await cli.inspect(spawnResult.hermesRunId);
    assert.equal(inspectResult.state, 'running');

    const collectResult = await cli.collect(spawnResult.hermesRunId);
    assert.equal(collectResult.conclusion, 'SUCCESS');
  });

  it('reclaim 后 inspect 返回 reclaimed 状态', async () => {
    const cli = new StubHermesCliPort();
    const spec = {
      profileName: 'test-profile',
      prompt: 'test-prompt',
      workspacePath: '/tmp/test',
      maxAttempts: 3,
      timeoutMs: 300_000,
      idempotencyKey: 'idem-002',
    };
    const spawnResult = await cli.spawn(spec);
    await cli.reclaim(spawnResult.hermesRunId, 'test-reclaim');
    const inspectResult = await cli.inspect(spawnResult.hermesRunId);
    assert.equal(inspectResult.state, 'reclaimed');
  });

  it('listDeadLetters 返回注入的条目', async () => {
    const cli = new StubHermesCliPort();
    cli._injectDeadLetter({
      hermesRunId: 'test-run',
      reason: 'timeout',
      deadLetteredAt: new Date().toISOString(),
      originalPrompt: 'test',
    });
    const deadLetters = await cli.listDeadLetters();
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0].reason, 'timeout');
  });
});
