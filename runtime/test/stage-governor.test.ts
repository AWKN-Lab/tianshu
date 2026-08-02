/**
 * Stage Governor 状态迁移门卫测试
 *
 * 覆盖: transitionStageState 的 9 个场景
 *   - 非法状态、不存在 stage run、终态拒绝
 *   - PASSED 成功迁移 (含 receipt 校验)
 *   - FAILED 迁移 (attempt < maxAttempts)
 *   - 超限 → ROLLED_BACK
 *   - 幂等性 (重复 key 拒绝)
 *   - DRAFT profile 拒绝
 *   - 职责隔离违反拒绝
 *
 * 对应源码: src/governor/stage-governor.ts, src/workflow/stage-store.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb, queryRun } from '../src/store/db.js';
import { createAwknId } from '../src/contracts/ids.js';
import { receiptPayloadHash } from '../src/contracts/receipts.js';
import { transitionStageState } from '../src/governor/stage-governor.js';
import {
  createStageRun,
  getStageRun,
  updateStageRunState,
} from '../src/workflow/stage-store.js';
import type {
  AgentInstanceV2,
  AgentProfileV2,
  AgentRole,
  WorkflowStageType,
} from '../src/contracts/workflow-v2.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const ENV_ID = `env_${'a'.repeat(32)}`;
const EXEC_ID = `exec_${'1'.repeat(32)}`;
const TRACE_ID = `tr_${'2'.repeat(32)}`;
const MISSION_ID = 'msn_gov_test';
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-gov-'));
  process.env.AWKN_DB_PATH = join(tempDir, `${randomUUID()}.db`);
  closeDb();
  getDb();
}

async function cleanupIsolatedDb(): Promise<void> {
  closeDb();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ─── FK 辅助：seed goals + authorization_envelope ────────

function seedGoal(missionId: string): void {
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO goals (id, title, description, created_at, updated_at)
     VALUES (?, ?, '', ?, ?)`,
    [missionId, `Test ${missionId}`, now, now],
  );
}

function seedAuthorizationEnvelope(envelopeId: string, missionId: string): void {
  seedGoal(missionId);
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO authorization_envelope
       (id, mission_id, user_signature, scope_directories, created_at)
     VALUES (?, ?, 'sig', '[]', ?)`,
    [envelopeId, missionId, now],
  );
}

// ─── Receipt 辅助 ─────────────────────────────────────────

function seedReceipt(
  receiptId: string,
  stageRunId: string,
  frozenInputHash: string,
  createdAt: string,
): void {
  // Seed execution for FK (receipts.execution_id → executions.id)
  // Must use proper AWKN IDs so StoredReceiptEnvelopeSchema validates.
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO executions
       (id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
        input_ref_json, feature_flags_ref_json, state, created_at, updated_at)
     VALUES (?, ?, 0, '{}', 'awkn-actor-ref/v1', '{}', 'awkn-execution-scope/v1',
             '{}', '{}', 'RECEIVED', ?, ?)`,
    [EXEC_ID, TRACE_ID, now, now],
  );

  // Build valid WorkflowReceiptPayload (used by step 8 if frozenSourceSha is set)
  const payload = {
    missionId: `goal_${'a'.repeat(32)}`,
    envelopeId: ENV_ID,
    frozenTargetHash: frozenInputHash,
    verdict: 'PASS',
    toolsUsed: ['tool-1'],
    evidenceRefs: ['ev-1'],
  };
  const payloadSchema = 'awkn-worker-result/v1';
  const payloadHash = receiptPayloadHash(payloadSchema, payload);
  const producer = {
    schema: 'awkn-actor-ref/v1',
    actorId: 'actor-test',
    actorType: 'assistant' as const,
  };

  queryRun(
    `INSERT INTO receipts
       (id, receipt_type, payload_schema, execution_id, trace_id,
        aggregate_type, aggregate_id, producer_json, status,
        payload_json, payload_hash, artifact_refs_json, created_at)
     VALUES (?, 'WORKER_RESULT', ?, ?, ?, 'stage_run', ?, ?, 'SUCCESS', ?, ?, '[]', ?)`,
    [
      receiptId,
      payloadSchema,
      EXEC_ID,
      TRACE_ID,
      stageRunId,
      JSON.stringify(producer),
      JSON.stringify(payload),
      payloadHash,
      createdAt,
    ],
  );
}

// ─── AgentProfileV2 / AgentInstanceV2 辅助 ───────────────

function makeProfileV2(
  role: AgentRole,
  specialty: WorkflowStageType,
  overrides?: Partial<AgentProfileV2>,
): AgentProfileV2 {
  return {
    schema: 'awkn-agent-profile/v2',
    profileId: 'prof_gov',
    version: '1.0.0',
    role,
    specialty,
    capabilities: [role.toLowerCase()],
    inputTypes: ['spec'],
    outputTypes: ['code'],
    toolPolicyRef: 'tool-policy-v1',
    independenceGroup: 'group-a',
    providerPolicy: 'ANY_APPROVED',
    maxConcurrentAssignments: 1,
    maxAttempts: 3,
    timeoutMs: 60000,
    memoryPolicy: 'SCOPED_READ_NO_WRITE',
    status: 'ACTIVE',
    sourceHash: SHA256_HEX,
    ...overrides,
  };
}

function makeInstanceV2(
  profileId: string,
  actorId: string,
  overrides?: Partial<AgentInstanceV2>,
): AgentInstanceV2 {
  return {
    schema: 'awkn-agent-instance/v2',
    actorId,
    profileId,
    providerId: 'trae',
    modelId: 'gpt-4',
    sessionId: 'session-' + actorId,
    workerProviderId: 'wpv-1',
    providerRunId: 'prun-' + actorId,
    workspaceId: 'ws-1',
    permissionSnapshotHash: SHA256_HEX,
    authorizationEnvelopeId: ENV_ID,
    leaseId: 'lease-' + actorId,
    leaseExpiresAt: FUTURE,
    createdAt: NOW,
    ...overrides,
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Stage Governor — transitionStageState', () => {
  before(async () => {
    await setupIsolatedDb();
    seedAuthorizationEnvelope(ENV_ID, MISSION_ID);
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  // ─── 1. 非法状态 ──────────────────────────────────────

  it('拒绝非法 toState', () => {
    const profile = makeProfileV2('Engineer', 'IMPLEMENT');
    const instance = makeInstanceV2(profile.profileId, 'actor-1');
    const result = transitionStageState({
      stageRunId: 'srun_nonexistent',
      toState: 'INVALID_STATE' as never,
      actorInstance: instance,
      actorProfile: profile,
      triggerReceiptId: 'rcpt_dummy',
      priorInstances: [],
      priorProfiles: [],
      idempotencyKey: createAwknId('event'),
    });
    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('valid StageRunState'));
  });

  // ─── 2. 不存在的 stage run ────────────────────────────

  it('拒绝不存在的 stage run', () => {
    const profile = makeProfileV2('Engineer', 'IMPLEMENT');
    const instance = makeInstanceV2(profile.profileId, 'actor-1');
    const result = transitionStageState({
      stageRunId: 'srun_does_not_exist',
      toState: 'FAILED',
      actorInstance: instance,
      actorProfile: profile,
      triggerReceiptId: 'rcpt_dummy',
      priorInstances: [],
      priorProfiles: [],
      idempotencyKey: createAwknId('event'),
    });
    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('not found'));
  });

  // ─── 3. 终态 stage run 拒绝迁移 ───────────────────────

  it('拒绝已处于终态 (PASSED) 的 stage run', () => {
    const stageRun = createStageRun(
      MISSION_ID,
      'workpackage',
      'wp_terminal',
      'IMPLEMENT',
      'prof_gov',
      SHA256_HEX,
      ENV_ID,
      [],
      createAwknId('event'),
    );
    // 手动设为 PASSED
    updateStageRunState(stageRun.stageRunId, 'PASSED', 'actor-prev', 'rcpt_prev');

    const profile = makeProfileV2('Engineer', 'IMPLEMENT');
    const instance = makeInstanceV2(profile.profileId, 'actor-1');
    const result = transitionStageState({
      stageRunId: stageRun.stageRunId,
      toState: 'FAILED',
      actorInstance: instance,
      actorProfile: profile,
      triggerReceiptId: 'rcpt_dummy',
      priorInstances: [],
      priorProfiles: [],
      idempotencyKey: createAwknId('event'),
    });
    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('terminal'));
  });

  // ─── 4. PASSED 成功迁移 ───────────────────────────────

  it('PASSED 迁移成功 (含合法 receipt)', () => {
    const stageRun = createStageRun(
      MISSION_ID,
      'workpackage',
      'wp_pass',
      'IMPLEMENT',
      'prof_gov',
      SHA256_HEX,
      ENV_ID,
      [],
      createAwknId('event'),
    );
    const receiptId = createAwknId('receipt');
    seedReceipt(receiptId, stageRun.stageRunId, SHA256_HEX, '2026-08-02T12:00:00.000Z');

    const profile = makeProfileV2('Engineer', 'IMPLEMENT');
    const instance = makeInstanceV2(profile.profileId, 'actor-pass');
    const idemKey = createAwknId('event');
    const result = transitionStageState({
      stageRunId: stageRun.stageRunId,
      toState: 'PASSED',
      actorInstance: instance,
      actorProfile: profile,
      triggerReceiptId: receiptId,
      priorInstances: [],
      priorProfiles: [],
      idempotencyKey: idemKey,
    });
    assert.equal(result.success, true);
    assert.equal(result.newState, 'PASSED');

    // 验证 DB 中状态已更新
    const fetched = getStageRun(stageRun.stageRunId);
    assert.ok(fetched);
    assert.equal(fetched!.state, 'PASSED');
    assert.equal(fetched!.actorId, 'actor-pass');
  });

  // ─── 5. FAILED 迁移 (attempt < maxAttempts) ──────────

  it('FAILED 迁移成功 (attempt < maxAttempts)', () => {
    const stageRun = createStageRun(
      MISSION_ID,
      'workpackage',
      'wp_fail',
      'IMPLEMENT',
      'prof_gov',
      SHA256_HEX,
      ENV_ID,
      [],
      createAwknId('event'),
    );

    const profile = makeProfileV2('Engineer', 'IMPLEMENT', { maxAttempts: 3 });
    const instance = makeInstanceV2(profile.profileId, 'actor-fail');
    const result = transitionStageState({
      stageRunId: stageRun.stageRunId,
      toState: 'FAILED',
      actorInstance: instance,
      actorProfile: profile,
      triggerReceiptId: 'rcpt_dummy',
      priorInstances: [],
      priorProfiles: [],
      idempotencyKey: createAwknId('event'),
    });
    assert.equal(result.success, true);
    assert.equal(result.newState, 'FAILED');

    const fetched = getStageRun(stageRun.stageRunId);
    assert.ok(fetched);
    assert.equal(fetched!.state, 'FAILED');
  });

  // ─── 6. 超限 attempt → ROLLED_BACK ───────────────────

  it('attempt >= maxAttempts 时 FAILED 被拒绝，ROLLED_BACK 成功', () => {
    const stageRun = createStageRun(
      MISSION_ID,
      'workpackage',
      'wp_rollback',
      'IMPLEMENT',
      'prof_gov',
      SHA256_HEX,
      ENV_ID,
      [],
      createAwknId('event'),
    );
    // 手动设 attempt = maxAttempts
    queryRun(
      'UPDATE workflow_stage_run SET attempt = 3 WHERE stage_run_id = ?',
      [stageRun.stageRunId],
    );

    const profile = makeProfileV2('Engineer', 'IMPLEMENT', { maxAttempts: 3 });
    const instance = makeInstanceV2(profile.profileId, 'actor-rb');

    // FAILED 应被拒绝
    const failResult = transitionStageState({
      stageRunId: stageRun.stageRunId,
      toState: 'FAILED',
      actorInstance: instance,
      actorProfile: profile,
      triggerReceiptId: 'rcpt_dummy',
      priorInstances: [],
      priorProfiles: [],
      idempotencyKey: createAwknId('event'),
    });
    assert.equal(failResult.success, false);
    assert.ok(failResult.reason?.includes('ROLLED_BACK'));

    // ROLLED_BACK 应成功
    const rbResult = transitionStageState({
      stageRunId: stageRun.stageRunId,
      toState: 'ROLLED_BACK',
      actorInstance: instance,
      actorProfile: profile,
      triggerReceiptId: 'rcpt_dummy',
      priorInstances: [],
      priorProfiles: [],
      idempotencyKey: createAwknId('event'),
    });
    assert.equal(rbResult.success, true);
    assert.equal(rbResult.newState, 'ROLLED_BACK');

    const fetched = getStageRun(stageRun.stageRunId);
    assert.ok(fetched);
    assert.equal(fetched!.state, 'ROLLED_BACK');
  });

  // ─── 7. 幂等性：重复 key 拒绝 ─────────────────────────

  it('相同 idempotencyKey 用于不同 toState → 拒绝', () => {
    // Stage run A: PASSED 迁移成功
    const stageRunA = createStageRun(
      MISSION_ID,
      'workpackage',
      'wp_idem_a',
      'IMPLEMENT',
      'prof_gov',
      SHA256_HEX,
      ENV_ID,
      [],
      createAwknId('event'),
    );
    const receiptId = createAwknId('receipt');
    seedReceipt(receiptId, stageRunA.stageRunId, SHA256_HEX, '2026-08-02T12:00:00.000Z');

    const profile = makeProfileV2('Engineer', 'IMPLEMENT');
    const instance = makeInstanceV2(profile.profileId, 'actor-idem');
    const idemKey = createAwknId('event');

    const resultA = transitionStageState({
      stageRunId: stageRunA.stageRunId,
      toState: 'PASSED',
      actorInstance: instance,
      actorProfile: profile,
      triggerReceiptId: receiptId,
      priorInstances: [],
      priorProfiles: [],
      idempotencyKey: idemKey,
    });
    assert.equal(resultA.success, true);

    // Stage run B: 使用相同 idemKey 但不同 toState → 应拒绝
    const stageRunB = createStageRun(
      MISSION_ID,
      'workpackage',
      'wp_idem_b',
      'IMPLEMENT',
      'prof_gov',
      SHA256_HEX,
      ENV_ID,
      [],
      createAwknId('event'),
    );
    const resultB = transitionStageState({
      stageRunId: stageRunB.stageRunId,
      toState: 'FAILED',
      actorInstance: instance,
      actorProfile: profile,
      triggerReceiptId: 'rcpt_dummy',
      priorInstances: [],
      priorProfiles: [],
      idempotencyKey: idemKey, // 相同 key
    });
    assert.equal(resultB.success, false);
    assert.ok(resultB.reason?.includes('idempotency key conflict'));
  });

  // ─── 8. DRAFT profile 拒绝 ────────────────────────────

  it('DRAFT profile actor 被拒绝', () => {
    const stageRun = createStageRun(
      MISSION_ID,
      'workpackage',
      'wp_draft',
      'IMPLEMENT',
      'prof_gov',
      SHA256_HEX,
      ENV_ID,
      [],
      createAwknId('event'),
    );

    const profile = makeProfileV2('Engineer', 'IMPLEMENT', { status: 'DRAFT' });
    const instance = makeInstanceV2(profile.profileId, 'actor-draft');
    const result = transitionStageState({
      stageRunId: stageRun.stageRunId,
      toState: 'PASSED',
      actorInstance: instance,
      actorProfile: profile,
      triggerReceiptId: 'rcpt_dummy',
      priorInstances: [],
      priorProfiles: [],
      idempotencyKey: createAwknId('event'),
    });
    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('DRAFT'));
  });

  // ─── 9. 职责隔离违反拒绝 ──────────────────────────────

  it('职责隔离违反 (同 actorId + Engineer↔Test) 阻止迁移', () => {
    const stageRun = createStageRun(
      MISSION_ID,
      'workpackage',
      'wp_sep',
      'TEST',
      'prof_test',
      SHA256_HEX,
      ENV_ID,
      [],
      createAwknId('event'),
    );

    // 前置实例: Engineer, 同 actorId
    const priorProfile = makeProfileV2('Engineer', 'IMPLEMENT');
    const priorInstance = makeInstanceV2(priorProfile.profileId, 'actor-same', {
      sessionId: 'session-prior',
    });

    // 当前 actor: Test, 同 actorId (Engineer↔Test 不相容)
    const currentProfile = makeProfileV2('Test', 'TEST');
    const currentInstance = makeInstanceV2(currentProfile.profileId, 'actor-same', {
      sessionId: 'session-current',
    });

    const result = transitionStageState({
      stageRunId: stageRun.stageRunId,
      toState: 'FAILED',
      actorInstance: currentInstance,
      actorProfile: currentProfile,
      triggerReceiptId: 'rcpt_dummy',
      priorInstances: [priorInstance],
      priorProfiles: [priorProfile],
      idempotencyKey: createAwknId('event'),
    });
    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('incompatible') || result.reason?.includes('separation'));
  });
});
