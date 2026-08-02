/**
 * Evolution Auto-Promotion 测试 — Spiral 4
 *
 * 覆盖:
 *   (a) promoteCandidateToEvolution: DRAFT → VALIDATING → APPROVED → SHADOW → ACTIVE (happy path)
 *   (b) Evolution actor = Retrospective actor → REJECTED (separation violation)
 *   (c) Authorization scope expansion → REJECTED (candidate requires permission not in envelope)
 *   (d) Replay FAIL → candidate stays VALIDATING
 *   (e) Candidate not in DRAFT state → REJECTED
 *
 * 约束验证:
 *   - Evolution actor 必须与 Retrospective actor 分离 (enforceSeparationV2)
 *   - 授权范围不得扩张 (candidate required ⊆ envelope allowed)
 *   - 回放失败不激活
 *
 * 对应源码: src/evolve/retrospective-bridge.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb, queryRun } from '../src/store/db.js';
import { runRetrospective, getRetrospectiveCandidateById } from '../src/retrospective/retrospective-coordinator.js';
import { promoteCandidateToEvolution } from '../src/evolve/retrospective-bridge.js';
import type { ReplayRunner } from '../src/evolve/replay-evaluator.js';
import type { AgentInstanceV2, AgentProfileV2, WorkflowStageType } from '../src/contracts/workflow-v2.js';
import type { AgentRole } from '../src/contracts/workflow.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const MISSION_ID = `goal_${'b'.repeat(32)}`;
const ENV_ID = `env_${'b'.repeat(32)}`;
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-evo-promo-'));
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

function seedAuthorizationEnvelope(
  envelopeId: string,
  missionId: string,
  scopeTools: string[] = ['rule:write', 'policy:write', 'pattern:quarantine', 'escalate'],
): void {
  seedGoal(missionId);
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO authorization_envelope
       (id, mission_id, user_signature, scope_directories, scope_tools, created_at)
     VALUES (?, ?, 'sig', '[]', ?, ?)`,
    [envelopeId, missionId, JSON.stringify(scopeTools), now],
  );
}

// ─── Receipt / Stage 辅助 ─────────────────────────────────

function seedExecutionAndReceipt(receiptId: string, workItemId: string): void {
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

  queryRun(
    `INSERT INTO receipts
       (id, receipt_type, payload_schema, execution_id, trace_id,
        aggregate_type, aggregate_id, producer_json, status,
        payload_json, payload_hash, artifact_refs_json, created_at)
     VALUES (?, 'WORKER_RESULT', 'awkn-worker-result/v1', ?, ?, 'stage_run', ?, ?, 'SUCCESS', ?, ?, '[]', ?)`,
    [receiptId, execId, traceId, workItemId, JSON.stringify(producer), JSON.stringify(payload), SHA256_HEX, now],
  );
}

function seedCompletedStage(workItemId: string, receiptId: string): void {
  const now = new Date().toISOString();
  const stageRunId = `srun_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  queryRun(
    `INSERT INTO workflow_stage_run
       (stage_run_id, mission_id, work_item_type, work_item_id, stage_type, state,
        required_profile_id, frozen_input_hash, authorization_envelope_id,
        output_receipt_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, 'workpackage', ?, 'IMPLEMENT', 'PASSED', 'prof-eng', ?, ?, ?, ?, ?, ?)`,
    [stageRunId, MISSION_ID, workItemId, SHA256_HEX, ENV_ID, receiptId, `idem-${workItemId}`, now, now],
  );
}

// ─── AgentProfileV2 / AgentInstanceV2 辅助 ───────────────

function makeProfileV2(
  role: AgentRole,
  specialty: WorkflowStageType,
  profileId: string,
  overrides?: Partial<AgentProfileV2>,
): AgentProfileV2 {
  return {
    schema: 'awkn-agent-profile/v2',
    profileId,
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

// ─── 回放 Runner 辅助 ─────────────────────────────────────

const passingRunner: ReplayRunner = async () => ({
  successRate: 1,
  avgCycles: 1,
  tokenCount: 100,
  errorRate: 0,
  humanTakeoverRate: 0,
  securityViolationRate: 0,
});

const failingRunner: ReplayRunner = async (_testCase, candidate) => {
  if (candidate === null) {
    // Baseline — good metrics
    return { successRate: 1, avgCycles: 1, tokenCount: 100, errorRate: 0, humanTakeoverRate: 0, securityViolationRate: 0 };
  }
  // Candidate — regression
  return { successRate: 0, avgCycles: 10, tokenCount: 1000, errorRate: 1, humanTakeoverRate: 1, securityViolationRate: 0 };
};

// ─── 生成 DRAFT 候选的辅助 ────────────────────────────────

function generateDraftCandidate(workItemId: string): string {
  const receiptId = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  seedExecutionAndReceipt(receiptId, workItemId);
  seedCompletedStage(workItemId, receiptId);

  const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', `prof-retro-${workItemId}`);
  const retroInstance = makeInstanceV2(retroProfile.profileId, `actor-retro-${workItemId}`);

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

  if (!result.success || result.candidates.length === 0) {
    throw new Error(`failed to generate DRAFT candidate: ${result.reason}`);
  }
  return result.candidates[0]!.candidateId;
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Evolution Auto-Promotion — Spiral 4', () => {
  before(async () => {
    await setupIsolatedDb();
    seedAuthorizationEnvelope(ENV_ID, MISSION_ID);
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  // (a) Happy path: DRAFT → VALIDATING → APPROVED → SHADOW → ACTIVE
  it('promoteCandidateToEvolution transitions DRAFT → ACTIVE on replay PASS', async () => {
    const candidateId = generateDraftCandidate('wp_promo_success_1');

    // Verify candidate starts as DRAFT
    const before = getRetrospectiveCandidateById(candidateId);
    assert.equal(before?.evolution_status, 'DRAFT');

    // Evolution actor — different from Retrospective actor
    const evoProfile = makeProfileV2('Evolution', 'EVOLUTION_VALIDATE', 'prof-evo-success');
    const evoInstance = makeInstanceV2(evoProfile.profileId, 'actor-evo-success');

    // Retrospective actor as prior (for separation check)
    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', 'prof-retro-success');
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-success');

    const result = await promoteCandidateToEvolution({
      candidateId,
      evolutionActorInstance: evoInstance,
      evolutionActorProfile: evoProfile,
      priorInstances: [retroInstance],
      priorProfiles: [retroProfile],
      authorizationEnvelopeId: ENV_ID,
      replayRunner: passingRunner,
    });

    assert.equal(result.success, true, `expected success but: ${result.reason}`);
    assert.equal(result.finalStatus, 'ACTIVE');
    assert.equal(result.replayVerdict, 'PASS');
    assert.ok(result.linkedEvolutionCandidateId);

    // Verify persisted status
    const after = getRetrospectiveCandidateById(candidateId);
    assert.equal(after?.evolution_status, 'ACTIVE');
    assert.ok(after?.linked_evolution_candidate_id);
  });

  // (b) Separation violation: Evolution actor = Retrospective actor
  it('promoteCandidateToEvolution rejects when Evolution actor = Retrospective actor', async () => {
    const candidateId = generateDraftCandidate('wp_promo_sep_1');

    // Evolution and Retrospective share the same actorId and sessionId
    const evoProfile = makeProfileV2('Evolution', 'EVOLUTION_VALIDATE', 'prof-evo-sep');
    const evoInstance = makeInstanceV2(evoProfile.profileId, 'actor-shared-promo', {
      sessionId: 'session-shared-promo',
    });

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', 'prof-retro-sep');
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-shared-promo', {
      sessionId: 'session-shared-promo',
    });

    const result = await promoteCandidateToEvolution({
      candidateId,
      evolutionActorInstance: evoInstance,
      evolutionActorProfile: evoProfile,
      priorInstances: [retroInstance],
      priorProfiles: [retroProfile],
      authorizationEnvelopeId: ENV_ID,
      replayRunner: passingRunner,
    });

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('separation policy denied'), `reason: ${result.reason}`);
    // Candidate should remain DRAFT (promotion was rejected before any state change)
    const after = getRetrospectiveCandidateById(candidateId);
    assert.equal(after?.evolution_status, 'DRAFT');
  });

  // (c) Authorization scope expansion
  it('promoteCandidateToEvolution rejects when candidate requires permission not in envelope', async () => {
    const candidateId = generateDraftCandidate('wp_promo_auth_1');

    const evoProfile = makeProfileV2('Evolution', 'EVOLUTION_VALIDATE', 'prof-evo-auth');
    const evoInstance = makeInstanceV2(evoProfile.profileId, 'actor-evo-auth');

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', 'prof-retro-auth');
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-auth');

    // Pass empty envelope permissions — candidate requires 'rule:write' (PROMOTE_RULE)
    const result = await promoteCandidateToEvolution({
      candidateId,
      evolutionActorInstance: evoInstance,
      evolutionActorProfile: evoProfile,
      priorInstances: [retroInstance],
      priorProfiles: [retroProfile],
      authorizationEnvelopeId: ENV_ID,
      replayRunner: passingRunner,
      envelopePermissions: [],
    });

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('authorization scope expansion'), `reason: ${result.reason}`);
    // Candidate should remain DRAFT
    const after = getRetrospectiveCandidateById(candidateId);
    assert.equal(after?.evolution_status, 'DRAFT');
  });

  // (d) Replay FAIL → candidate stays VALIDATING
  it('promoteCandidateToEvolution keeps candidate in VALIDATING on replay FAIL', async () => {
    const candidateId = generateDraftCandidate('wp_promo_replay_fail_1');

    const evoProfile = makeProfileV2('Evolution', 'EVOLUTION_VALIDATE', 'prof-evo-replay-fail');
    const evoInstance = makeInstanceV2(evoProfile.profileId, 'actor-evo-replay-fail');

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', 'prof-retro-replay-fail');
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-replay-fail');

    const result = await promoteCandidateToEvolution({
      candidateId,
      evolutionActorInstance: evoInstance,
      evolutionActorProfile: evoProfile,
      priorInstances: [retroInstance],
      priorProfiles: [retroProfile],
      authorizationEnvelopeId: ENV_ID,
      replayRunner: failingRunner,
    });

    assert.equal(result.success, false);
    assert.equal(result.finalStatus, 'VALIDATING');
    assert.equal(result.replayVerdict, 'FAIL');
    assert.ok(result.reason?.includes('replay failed'));

    // Verify persisted status
    const after = getRetrospectiveCandidateById(candidateId);
    assert.equal(after?.evolution_status, 'VALIDATING');
  });

  // (e) Candidate not in DRAFT state → REJECTED
  it('promoteCandidateToEvolution rejects when candidate is not DRAFT', async () => {
    const candidateId = generateDraftCandidate('wp_promo_not_draft_1');

    // Manually transition to VALIDATING (simulating a previous promotion attempt)
    queryRun(
      `UPDATE workflow_retrospective_candidate SET evolution_status = 'VALIDATING', updated_at = ? WHERE candidate_id = ?`,
      [new Date().toISOString(), candidateId],
    );

    const evoProfile = makeProfileV2('Evolution', 'EVOLUTION_VALIDATE', 'prof-evo-not-draft');
    const evoInstance = makeInstanceV2(evoProfile.profileId, 'actor-evo-not-draft');

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', 'prof-retro-not-draft');
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-not-draft');

    const result = await promoteCandidateToEvolution({
      candidateId,
      evolutionActorInstance: evoInstance,
      evolutionActorProfile: evoProfile,
      priorInstances: [retroInstance],
      priorProfiles: [retroProfile],
      authorizationEnvelopeId: ENV_ID,
      replayRunner: passingRunner,
    });

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('must be DRAFT'));
    assert.equal(result.finalStatus, 'VALIDATING');
  });

  // (f) Candidate not found → REJECTED
  it('promoteCandidateToEvolution rejects when candidate does not exist', async () => {
    const evoProfile = makeProfileV2('Evolution', 'EVOLUTION_VALIDATE', 'prof-evo-not-found');
    const evoInstance = makeInstanceV2(evoProfile.profileId, 'actor-evo-not-found');

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', 'prof-retro-not-found');
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-retro-not-found');

    const result = await promoteCandidateToEvolution({
      candidateId: 'cand_nonexistent_0000000000000000000000000000',
      evolutionActorInstance: evoInstance,
      evolutionActorProfile: evoProfile,
      priorInstances: [retroInstance],
      priorProfiles: [retroProfile],
      authorizationEnvelopeId: ENV_ID,
      replayRunner: passingRunner,
    });

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('not found'));
    assert.equal(result.finalStatus, 'UNKNOWN');
  });
});
