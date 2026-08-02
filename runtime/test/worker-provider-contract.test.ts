/**
 * WorkerProviderPort 契约测试 — 通过 LocalAgentLoopProvider 验证
 *
 * 覆盖: probe / spawn / inspect / heartbeat / cancel / collect 六个方法,
 *       以及 provider-registry 的 register / get / unregister / findProvidersForSpecialty。
 *
 * 对应源码: src/worker/local-agent-loop-provider.ts, src/worker/provider-registry.ts
 * 对应契约: contracts/workflow-v2.ts — WorkerProviderPort
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { LocalAgentLoopProvider } from '../src/worker/local-agent-loop-provider.js';
import {
  registerProvider,
  unregisterProvider,
  getProvider,
  getRegisteredProviders,
  findProvidersForSpecialty,
} from '../src/worker/provider-registry.js';
import { createAwknId } from '../src/contracts/ids.js';
import type {
  WorkerProviderPort,
  WorkerSpawnRequest,
} from '../src/contracts/workflow-v2.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const ENV_ID = `env_${'a'.repeat(32)}`;

// ─── 辅助：构造合法 WorkerSpawnRequest ───────────────────

function makeSpawnRequest(): WorkerSpawnRequest {
  return {
    schema: 'awkn-worker-spawn-request/v1',
    stageRunId: 'srun_test',
    profileId: 'prof_test',
    frozenInputHash: SHA256_HEX,
    workspaceId: 'ws-test',
    toolPolicyRef: 'tool-policy-v1',
    authorizationEnvelopeId: ENV_ID,
    idempotencyKey: createAwknId('event'),
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('WorkerProviderPort contract via LocalAgentLoopProvider', () => {
  let provider: LocalAgentLoopProvider;

  before(() => {
    provider = new LocalAgentLoopProvider();
  });

  it('probe() returns capability receipt with providerId and supportedSpecialties', async () => {
    const receipt = await provider.probe();
    assert.equal(receipt.schema, 'awkn-worker-capability/v1');
    assert.equal(receipt.providerId, 'local-agent-loop');
    assert.ok(receipt.supportedSpecialties.length > 0);
    assert.ok(receipt.maxConcurrentRuns > 0);
    assert.ok(receipt.heartbeatIntervalMs > 0);
  });

  it('spawn() returns WorkerSpawnReceipt with providerRunId, actorId, sessionId', async () => {
    const receipt = await provider.spawn(makeSpawnRequest());
    assert.equal(receipt.schema, 'awkn-worker-spawn-receipt/v1');
    assert.equal(receipt.providerId, 'local-agent-loop');
    assert.ok(receipt.providerRunId);
    assert.ok(receipt.actorId);
    assert.ok(receipt.sessionId);
    assert.ok(receipt.spawnedAt);
  });

  it('inspect() returns state and lastHeartbeatAt for existing run', async () => {
    const spawnReceipt = await provider.spawn(makeSpawnRequest());
    const info = await provider.inspect(spawnReceipt.providerRunId);
    assert.ok(info.state);
    assert.ok(info.lastHeartbeatAt);
  });

  it('heartbeat() returns WorkerHeartbeatReceipt with status=alive', async () => {
    const spawnReceipt = await provider.spawn(makeSpawnRequest());
    const receipt = await provider.heartbeat(spawnReceipt.providerRunId);
    assert.equal(receipt.schema, 'awkn-worker-heartbeat/v1');
    assert.equal(receipt.providerRunId, spawnReceipt.providerRunId);
    assert.equal(receipt.status, 'alive');
    assert.ok(receipt.observedAt);
  });

  it('cancel() returns WorkerCancelReceipt with reason', async () => {
    const spawnReceipt = await provider.spawn(makeSpawnRequest());
    const reason = 'test cancellation';
    const receipt = await provider.cancel(spawnReceipt.providerRunId, reason);
    assert.equal(receipt.schema, 'awkn-worker-cancel/v1');
    assert.equal(receipt.providerRunId, spawnReceipt.providerRunId);
    assert.equal(receipt.reason, reason);
    assert.ok(receipt.cancelledAt);
  });

  it('collect() returns WorkerResultEnvelope with conclusion=SUCCESS', async () => {
    const spawnReceipt = await provider.spawn(makeSpawnRequest());
    const envelope = await provider.collect(spawnReceipt.providerRunId);
    assert.equal(envelope.schema, 'awkn-worker-result/v1');
    assert.equal(envelope.providerRunId, spawnReceipt.providerRunId);
    assert.equal(envelope.conclusion, 'SUCCESS');
    assert.ok(envelope.actorId);
    assert.ok(envelope.outputReceiptId);
    assert.ok(Array.isArray(envelope.evidenceRefs));
    assert.ok(envelope.completedAt);
  });
});

describe('Provider registry', () => {
  after(() => {
    for (const p of getRegisteredProviders()) {
      unregisterProvider(p.providerId);
    }
  });

  it('register, get, unregister', () => {
    const p = new LocalAgentLoopProvider();
    registerProvider(p);
    const got = getProvider(p.providerId);
    assert.ok(got);
    assert.equal(got!.providerId, p.providerId);
    unregisterProvider(p.providerId);
    assert.equal(getProvider(p.providerId), undefined);
  });

  it('findProvidersForSpecialty returns matching providers', async () => {
    const p = new LocalAgentLoopProvider();
    registerProvider(p);
    const found = await findProvidersForSpecialty('IMPLEMENT');
    assert.ok(found.length >= 1);
    assert.ok(found.some((fp) => fp.providerId === p.providerId));
    unregisterProvider(p.providerId);
  });

  it('unregister removes provider', () => {
    const p = new LocalAgentLoopProvider();
    registerProvider(p);
    assert.ok(getProvider(p.providerId));
    unregisterProvider(p.providerId);
    assert.equal(getProvider(p.providerId), undefined);
  });
});

describe('LocalAgentLoopProvider implements WorkerProviderPort interface', () => {
  it('exposes all required WorkerProviderPort members', () => {
    const provider: WorkerProviderPort = new LocalAgentLoopProvider();
    assert.equal(typeof provider.providerId, 'string');
    assert.equal(typeof provider.probe, 'function');
    assert.equal(typeof provider.spawn, 'function');
    assert.equal(typeof provider.inspect, 'function');
    assert.equal(typeof provider.heartbeat, 'function');
    assert.equal(typeof provider.cancel, 'function');
    assert.equal(typeof provider.collect, 'function');
  });
});
