/**
 * Evolution Auto-Rollback 测试 — Spiral 4
 *
 * 覆盖:
 *   (a) autoRollbackOnRegression with regression metrics → QUARANTINED + restore previous ACTIVE
 *   (b) autoRollbackOnRegression without regression → no-op (candidate stays ACTIVE)
 *   (c) quarantineCandidate on ACTIVE candidate → QUARANTINED + restore previous
 *   (d) quarantineCandidate on non-ACTIVE candidate → REJECTED
 *   (e) quarantineCandidate with no previous ACTIVE → QUARANTINED without restore
 *
 * 约束验证:
 *   - SHADOW/ACTIVE 回归 → 自动 QUARANTINE + 恢复上一 ACTIVE
 *   - 回归判定：successRate < REGRESSION_SUCCESS_RATE_THRESHOLD (0.5)
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
import { runRetrospective, getRetrospectiveCandidateById, updateRetrospectiveCandidateStatus } from '../src/retrospective/retrospective-coordinator.js';
import { autoRollbackOnRegression, quarantineCandidate } from '../src/evolve/retrospective-bridge.js';
import type { ReplayMetrics } from '../src/evolve/replay-evaluator.js';
import type { AgentInstanceV2, AgentProfileV2, WorkflowStageType } from '../src/contracts/workflow-v2.js';
import type { AgentRole } from '../src/contracts/workflow.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const MISSION_ID = `goal_${'c'.repeat(32)}`;
const ENV_ID = `env_${'c'.repeat(32)}`;
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-evo-rollback-'));
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
  };
}

function makeInstanceV2(profileId: string, actorId: string): AgentInstanceV2 {
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
  };
}

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

// ─── 回归指标辅助 ─────────────────────────────────────────

const regressionMetrics: ReplayMetrics = {
  successRate: 0.1,
  avgCycles: 10,
  tokenCount: 1000,
  errorRate: 0.9,
  humanTakeoverRate: 0.5,
  securityViolationRate: 0,
};

const healthyMetrics: ReplayMetrics = {
  successRate: 1.0,
  avgCycles: 1,
  tokenCount: 100,
  errorRate: 0,
  humanTakeoverRate: 0,
  securityViolationRate: 0,
};

// ─── 测试用例 ─────────────────────────────────────────────

describe('Evolution Auto-Rollback — Spiral 4', () => {
  before(async () => {
    await setupIsolatedDb();
    seedAuthorizationEnvelope(ENV_ID, MISSION_ID);
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  // (a) autoRollbackOnRegression with regression → QUARANTINED + restore previous ACTIVE
  it('autoRollbackOnRegression quarantines current and restores previous ACTIVE on regression', () => {
    // Generate two DRAFT candidates
    const candidate1Id = generateDraftCandidate('wp_rollback_c1');
    const candidate2Id = generateDraftCandidate('wp_rollback_c2');

    // Set up: candidate1 is QUARANTINED (was ACTIVE, superseded by candidate2)
    // candidate2 is ACTIVE with previous_active = candidate1
    updateRetrospectiveCandidateStatus(candidate1Id, 'ACTIVE');
    updateRetrospectiveCandidateStatus(candidate1Id, 'QUARANTINED');
    updateRetrospectiveCandidateStatus(candidate2Id, 'ACTIVE', undefined, candidate1Id);

    // Verify initial state
    assert.equal(getRetrospectiveCandidateById(candidate1Id)?.evolution_status, 'QUARANTINED');
    assert.equal(getRetrospectiveCandidateById(candidate2Id)?.evolution_status, 'ACTIVE');

    // Trigger auto-rollback with regression metrics
    const result = autoRollbackOnRegression(candidate2Id, regressionMetrics);

    assert.equal(result.success, true);
    assert.equal(result.rolledBack, true);
    assert.equal(result.finalStatus, 'QUARANTINED');
    assert.equal(result.restoredCandidateId, candidate1Id);

    // Verify persisted state
    assert.equal(getRetrospectiveCandidateById(candidate2Id)?.evolution_status, 'QUARANTINED');
    assert.equal(getRetrospectiveCandidateById(candidate1Id)?.evolution_status, 'ACTIVE');
  });

  // (b) autoRollbackOnRegression without regression → no-op
  it('autoRollbackOnRegression is a no-op when metrics are healthy', () => {
    const candidateId = generateDraftCandidate('wp_rollback_healthy');
    updateRetrospectiveCandidateStatus(candidateId, 'ACTIVE');

    const result = autoRollbackOnRegression(candidateId, healthyMetrics);

    assert.equal(result.success, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.finalStatus, 'ACTIVE');
    assert.ok(result.reason?.includes('no regression'));

    // Verify persisted state unchanged
    assert.equal(getRetrospectiveCandidateById(candidateId)?.evolution_status, 'ACTIVE');
  });

  // (c) quarantineCandidate on ACTIVE candidate → QUARANTINED + restore previous
  it('quarantineCandidate quarantines ACTIVE candidate and restores previous ACTIVE', () => {
    const candidate1Id = generateDraftCandidate('wp_quarantine_c1');
    const candidate2Id = generateDraftCandidate('wp_quarantine_c2');

    // Set up: candidate1 QUARANTINED, candidate2 ACTIVE with previous = candidate1
    updateRetrospectiveCandidateStatus(candidate1Id, 'ACTIVE');
    updateRetrospectiveCandidateStatus(candidate1Id, 'QUARANTINED');
    updateRetrospectiveCandidateStatus(candidate2Id, 'ACTIVE', undefined, candidate1Id);

    const result = quarantineCandidate(candidate2Id, 'manual quarantine for testing');

    assert.equal(result.success, true);
    assert.equal(result.finalStatus, 'QUARANTINED');
    assert.equal(result.restoredCandidateId, candidate1Id);

    // Verify persisted state
    assert.equal(getRetrospectiveCandidateById(candidate2Id)?.evolution_status, 'QUARANTINED');
    assert.equal(getRetrospectiveCandidateById(candidate1Id)?.evolution_status, 'ACTIVE');
  });

  // (d) quarantineCandidate on non-ACTIVE candidate → REJECTED
  it('quarantineCandidate rejects when candidate is not ACTIVE or SHADOW', () => {
    const candidateId = generateDraftCandidate('wp_quarantine_reject');
    // Candidate is DRAFT (not ACTIVE or SHADOW)

    const result = quarantineCandidate(candidateId, 'should fail');

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('must be ACTIVE or SHADOW'));
    assert.equal(result.finalStatus, 'DRAFT');

    // Verify state unchanged
    assert.equal(getRetrospectiveCandidateById(candidateId)?.evolution_status, 'DRAFT');
  });

  // (e) quarantineCandidate with no previous ACTIVE → QUARANTINED without restore
  it('quarantineCandidate quarantines without restore when no previous ACTIVE exists', () => {
    const candidateId = generateDraftCandidate('wp_quarantine_no_prev');
    updateRetrospectiveCandidateStatus(candidateId, 'ACTIVE');
    // No previous_active_candidate_id set

    const result = quarantineCandidate(candidateId, 'no previous to restore');

    assert.equal(result.success, true);
    assert.equal(result.finalStatus, 'QUARANTINED');
    assert.equal(result.restoredCandidateId, undefined);
    assert.ok(result.reason?.includes('no previous ACTIVE'));

    // Verify state
    assert.equal(getRetrospectiveCandidateById(candidateId)?.evolution_status, 'QUARANTINED');
  });

  // (f) autoRollbackOnRegression on non-existent candidate → fails gracefully
  it('autoRollbackOnRegression fails gracefully for non-existent candidate', () => {
    const result = autoRollbackOnRegression(
      'cand_nonexistent_0000000000000000000000000000',
      regressionMetrics,
    );

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false);
    assert.equal(result.finalStatus, 'UNKNOWN');
    assert.ok(result.reason?.includes('not found'));
  });

  // (g) autoRollbackOnRegression on SHADOW candidate → quarantines
  it('autoRollbackOnRegression quarantines SHADOW candidate on regression', () => {
    const candidate1Id = generateDraftCandidate('wp_shadow_c1');
    const candidate2Id = generateDraftCandidate('wp_shadow_c2');

    // candidate1 QUARANTINED, candidate2 SHADOW with previous = candidate1
    updateRetrospectiveCandidateStatus(candidate1Id, 'ACTIVE');
    updateRetrospectiveCandidateStatus(candidate1Id, 'QUARANTINED');
    updateRetrospectiveCandidateStatus(candidate2Id, 'SHADOW', undefined, candidate1Id);

    const result = autoRollbackOnRegression(candidate2Id, regressionMetrics);

    assert.equal(result.success, true);
    assert.equal(result.rolledBack, true);
    assert.equal(result.finalStatus, 'QUARANTINED');
    assert.equal(result.restoredCandidateId, candidate1Id);

    // Verify
    assert.equal(getRetrospectiveCandidateById(candidate2Id)?.evolution_status, 'QUARANTINED');
    assert.equal(getRetrospectiveCandidateById(candidate1Id)?.evolution_status, 'ACTIVE');
  });

  // (h) Boundary: successRate exactly at threshold (0.5) → no regression
  it('autoRollbackOnRegression at exact threshold (successRate=0.5) → no regression', () => {
    const candidateId = generateDraftCandidate('wp_threshold');
    updateRetrospectiveCandidateStatus(candidateId, 'ACTIVE');

    const thresholdMetrics: ReplayMetrics = {
      ...regressionMetrics,
      successRate: 0.5, // exactly at threshold — NOT a regression (< 0.5 is regression)
    };

    const result = autoRollbackOnRegression(candidateId, thresholdMetrics);

    assert.equal(result.success, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.finalStatus, 'ACTIVE');
  });
});
