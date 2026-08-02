/**
 * Retrospective Layering 测试 — Spiral 4
 *
 * 覆盖:
 *   (a) runRetrospective at WORKPACKAGE layer generates candidates with correct layer field
 *   (b) runRetrospective at MODULE layer generates candidates
 *   (c) runRetrospective at COMPONENT layer generates candidates
 *   (d) runRetrospective at MISSION layer generates candidates
 *   (e) Retrospective actor that was also the Evolution actor is REJECTED (separation violation)
 *
 * 约束验证:
 *   - 候选始终为 DRAFT（retrospective 不得 promote/activate/quarantine）
 *   - Retrospective actor ≠ Evolution actor (enforceSeparationV2, INCOMPATIBLE_PAIRS_V2)
 *
 * 对应源码: src/retrospective/retrospective-coordinator.ts, src/retrospective/contracts.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb, queryRun } from '../src/store/db.js';
import { runRetrospective, getRetrospectiveCandidates } from '../src/retrospective/retrospective-coordinator.js';
import type { AgentInstanceV2, AgentProfileV2, WorkflowStageType } from '../src/contracts/workflow-v2.js';
import type { AgentRole } from '../src/contracts/workflow.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const MISSION_ID = `goal_${'a'.repeat(32)}`;
const ENV_ID = `env_${'a'.repeat(32)}`;
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-retro-layer-'));
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

// ─── FK 辅助 ──────────────────────────────────────────────

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
       (id, mission_id, user_signature, scope_directories, scope_tools, created_at)
     VALUES (?, ?, 'sig', '[]', ?, ?)`,
    [envelopeId, missionId, JSON.stringify(['rule:write', 'policy:write', 'pattern:quarantine', 'escalate']), now],
  );
}

// ─── Receipt / Stage 辅助 ─────────────────────────────────

function seedExecutionAndReceipt(
  receiptId: string,
  workItemId: string,
): void {
  const now = new Date().toISOString();
  const execId = `exec_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  const traceId = `tr_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  const producer = {
    schema: 'awkn-actor-ref/v1',
    actorId: 'actor-engineer',
    actorType: 'assistant' as const,
  };

  queryRun(
    `INSERT OR IGNORE INTO executions
       (id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
        input_ref_json, feature_flags_ref_json, state, created_at, updated_at)
     VALUES (?, ?, 0, ?, 'awkn-actor-ref/v1', '{}', 'awkn-execution-scope/v1',
             '{}', '{}', 'DELIVERED', ?, ?)`,
    [execId, traceId, JSON.stringify(producer), now, now],
  );

  const payload = {
    schema: 'awkn-worker-result/v1',
    missionId: MISSION_ID,
    envelopeId: ENV_ID,
    frozenTargetHash: SHA256_HEX,
    verdict: 'PASS',
    toolsUsed: ['tool-1'],
    evidenceRefs: [`ev_${workItemId}`],
  };
  const payloadSchema = 'awkn-worker-result/v1';

  queryRun(
    `INSERT INTO receipts
       (id, receipt_type, payload_schema, execution_id, trace_id,
        aggregate_type, aggregate_id, producer_json, status,
        payload_json, payload_hash, artifact_refs_json, created_at)
     VALUES (?, 'WORKER_RESULT', ?, ?, ?, 'stage_run', ?, ?, 'SUCCESS', ?, ?, '[]', ?)`,
    [
      receiptId,
      payloadSchema,
      execId,
      traceId,
      workItemId,
      JSON.stringify(producer),
      JSON.stringify(payload),
      SHA256_HEX,
      now,
    ],
  );
}

function seedCompletedStage(
  workItemType: string,
  workItemId: string,
  receiptId: string,
): void {
  const now = new Date().toISOString();
  const stageRunId = `srun_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  queryRun(
    `INSERT INTO workflow_stage_run
       (stage_run_id, mission_id, work_item_type, work_item_id, stage_type, state,
        required_profile_id, frozen_input_hash, authorization_envelope_id,
        output_receipt_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'IMPLEMENT', 'PASSED', 'prof-eng', ?, ?, ?, ?, ?, ?)`,
    [stageRunId, MISSION_ID, workItemType, workItemId, SHA256_HEX, ENV_ID, receiptId, `idem-${workItemId}`, now, now],
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
    profileId: 'prof_test',
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
    timeoutMs: 60_000,
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

describe('Retrospective Layering — Spiral 4', () => {
  before(async () => {
    await setupIsolatedDb();
    seedAuthorizationEnvelope(ENV_ID, MISSION_ID);
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  // (a) WORKPACKAGE layer
  it('runRetrospective at WORKPACKAGE layer generates DRAFT candidates with correct layer field', () => {
    const workItemId = 'wp_layer_test_1';
    const receiptId = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedExecutionAndReceipt(receiptId, workItemId);
    seedCompletedStage('workpackage', workItemId, receiptId);

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', { profileId: 'prof-retro-wp' });
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-wp');

    const result = runRetrospective({
      missionId: MISSION_ID,
      layer: 'WORKPACKAGE',
      workItemId,
      actorInstance: retroInstance,
      actorProfile: retroProfile,
      priorInstances: [],
      priorProfiles: [],
      authorizationEnvelopeId: ENV_ID,
    });

    assert.equal(result.success, true, `expected success but: ${result.reason}`);
    assert.ok(result.candidates.length > 0, 'should generate at least one candidate');
    for (const candidate of result.candidates) {
      assert.equal(candidate.layer, 'WORKPACKAGE');
      assert.equal(candidate.workItemType, 'workpackage');
      assert.equal(candidate.workItemId, workItemId);
      assert.equal(candidate.missionId, MISSION_ID);
    }
    assert.ok(result.receiptId, 'should produce a RETROSPECTIVE receipt');
    assert.ok(result.receiptPayload);
    assert.equal(result.receiptPayload!.layer, 'WORKPACKAGE');

    // Verify persisted candidates are DRAFT
    const persisted = getRetrospectiveCandidates(MISSION_ID, 'WORKPACKAGE');
    assert.ok(persisted.length > 0);
    // Query DB directly to verify evolution_status
    const db = getDb();
    const rows = db.prepare(
      'SELECT evolution_status FROM workflow_retrospective_candidate WHERE mission_id = ? AND layer = ?',
    ).all(MISSION_ID, 'WORKPACKAGE') as Array<{ evolution_status: string }>;
    for (const row of rows) {
      assert.equal(row.evolution_status, 'DRAFT');
    }
  });

  // (b) MODULE layer
  it('runRetrospective at MODULE layer generates DRAFT candidates with correct layer field', () => {
    const workItemId = 'mod_layer_test_1';
    const receiptId = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedExecutionAndReceipt(receiptId, workItemId);
    seedCompletedStage('module', workItemId, receiptId);

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', { profileId: 'prof-retro-mod' });
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-mod');

    const result = runRetrospective({
      missionId: MISSION_ID,
      layer: 'MODULE',
      workItemId,
      actorInstance: retroInstance,
      actorProfile: retroProfile,
      priorInstances: [],
      priorProfiles: [],
      authorizationEnvelopeId: ENV_ID,
    });

    assert.equal(result.success, true, `expected success but: ${result.reason}`);
    assert.ok(result.candidates.length > 0);
    for (const candidate of result.candidates) {
      assert.equal(candidate.layer, 'MODULE');
      assert.equal(candidate.workItemType, 'module');
    }
    assert.equal(result.receiptPayload!.layer, 'MODULE');
  });

  // (c) COMPONENT layer
  it('runRetrospective at COMPONENT layer generates DRAFT candidates with correct layer field', () => {
    const workItemId = 'comp_layer_test_1';
    const receiptId = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedExecutionAndReceipt(receiptId, workItemId);
    seedCompletedStage('component', workItemId, receiptId);

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', { profileId: 'prof-retro-comp' });
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-comp');

    const result = runRetrospective({
      missionId: MISSION_ID,
      layer: 'COMPONENT',
      workItemId,
      actorInstance: retroInstance,
      actorProfile: retroProfile,
      priorInstances: [],
      priorProfiles: [],
      authorizationEnvelopeId: ENV_ID,
    });

    assert.equal(result.success, true, `expected success but: ${result.reason}`);
    assert.ok(result.candidates.length > 0);
    for (const candidate of result.candidates) {
      assert.equal(candidate.layer, 'COMPONENT');
      assert.equal(candidate.workItemType, 'component');
    }
    assert.equal(result.receiptPayload!.layer, 'COMPONENT');
  });

  // (d) MISSION layer
  it('runRetrospective at MISSION layer generates DRAFT candidates with correct layer field', () => {
    const workItemId = 'msn_layer_test_1';
    const receiptId = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedExecutionAndReceipt(receiptId, workItemId);
    seedCompletedStage('mission', workItemId, receiptId);

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', { profileId: 'prof-retro-msn' });
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-msn');

    const result = runRetrospective({
      missionId: MISSION_ID,
      layer: 'MISSION',
      workItemId,
      actorInstance: retroInstance,
      actorProfile: retroProfile,
      priorInstances: [],
      priorProfiles: [],
      authorizationEnvelopeId: ENV_ID,
    });

    assert.equal(result.success, true, `expected success but: ${result.reason}`);
    assert.ok(result.candidates.length > 0);
    for (const candidate of result.candidates) {
      assert.equal(candidate.layer, 'MISSION');
      assert.equal(candidate.workItemType, 'mission');
    }
    assert.equal(result.receiptPayload!.layer, 'MISSION');
  });

  // (e) Separation violation: Retrospective actor = Evolution actor
  it('Retrospective actor that was also the Evolution actor is REJECTED (separation violation)', () => {
    const workItemId = 'wp_sep_violation_1';
    const receiptId = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedExecutionAndReceipt(receiptId, workItemId);
    seedCompletedStage('workpackage', workItemId, receiptId);

    // Retrospective actor
    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', { profileId: 'prof-retro-sep' });
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-shared', {
      sessionId: 'session-shared',
    });

    // Prior Evolution actor — SAME actorId and sessionId as Retrospective
    const evolutionProfile = makeProfileV2('Evolution', 'EVOLUTION_VALIDATE', { profileId: 'prof-evo-sep' });
    const evolutionInstance = makeInstanceV2(evolutionProfile.profileId, 'actor-shared', {
      sessionId: 'session-shared',
    });

    const result = runRetrospective({
      missionId: MISSION_ID,
      layer: 'WORKPACKAGE',
      workItemId,
      actorInstance: retroInstance,
      actorProfile: retroProfile,
      priorInstances: [evolutionInstance],
      priorProfiles: [evolutionProfile],
      authorizationEnvelopeId: ENV_ID,
    });

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('separation policy denied'), `reason: ${result.reason}`);
    assert.equal(result.candidates.length, 0);
  });

  // Additional: Retrospective must NOT sign quality or release PASS
  // The receipt verdict should be PASS/PARTIAL/BLOCKED, never a quality/release verdict
  it('retrospective receipt verdict is never a quality or release PASS', () => {
    const workItemId = 'wp_verdict_check_1';
    const receiptId = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedExecutionAndReceipt(receiptId, workItemId);
    seedCompletedStage('workpackage', workItemId, receiptId);

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', { profileId: 'prof-retro-verdict' });
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-verdict');

    const result = runRetrospective({
      missionId: MISSION_ID,
      layer: 'WORKPACKAGE',
      workItemId,
      actorInstance: retroInstance,
      actorProfile: retroProfile,
      priorInstances: [],
      priorProfiles: [],
      authorizationEnvelopeId: ENV_ID,
    });

    assert.equal(result.success, true);
    assert.ok(result.receiptPayload);
    const verdict = result.receiptPayload!.verdict;
    assert.ok(
      verdict === 'PASS' || verdict === 'PARTIAL' || verdict === 'BLOCKED',
      `verdict must be PASS/PARTIAL/BLOCKED, got ${verdict}`,
    );
  });

  // Additional: no completed stages → failure
  it('runRetrospective fails when no completed stages exist for the work item', () => {
    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', { profileId: 'prof-retro-empty' });
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-empty');

    const result = runRetrospective({
      missionId: MISSION_ID,
      layer: 'WORKPACKAGE',
      workItemId: 'wp_no_stages_1',
      actorInstance: retroInstance,
      actorProfile: retroProfile,
      priorInstances: [],
      priorProfiles: [],
      authorizationEnvelopeId: ENV_ID,
    });

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('no completed stages'));
    assert.equal(result.candidates.length, 0);
  });

  // Additional: FAILED stage produces ERROR-severity candidate
  it('runRetrospective with a FAILED stage produces ERROR-severity candidate and BLOCKED verdict', () => {
    const workItemId = 'wp_failed_stage_1';
    const receiptId = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedExecutionAndReceipt(receiptId, workItemId);

    // Seed a FAILED stage instead of PASSED
    const now = new Date().toISOString();
    const stageRunId = `srun_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    queryRun(
      `INSERT INTO workflow_stage_run
         (stage_run_id, mission_id, work_item_type, work_item_id, stage_type, state,
          required_profile_id, frozen_input_hash, authorization_envelope_id,
          output_receipt_id, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'workpackage', ?, 'TEST', 'FAILED', 'prof-test', ?, ?, ?, ?, ?, ?)`,
      [stageRunId, MISSION_ID, workItemId, SHA256_HEX, ENV_ID, receiptId, `idem-failed-${workItemId}`, now, now],
    );

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', { profileId: 'prof-retro-failed' });
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-failed');

    const result = runRetrospective({
      missionId: MISSION_ID,
      layer: 'WORKPACKAGE',
      workItemId,
      actorInstance: retroInstance,
      actorProfile: retroProfile,
      priorInstances: [],
      priorProfiles: [],
      authorizationEnvelopeId: ENV_ID,
    });

    assert.equal(result.success, true);
    assert.ok(result.candidates.length > 0);
    const errorCandidates = result.candidates.filter((c) => c.severity === 'ERROR');
    assert.ok(errorCandidates.length > 0, 'should have at least one ERROR-severity candidate');
    assert.equal(result.receiptPayload!.verdict, 'BLOCKED');
  });
});
