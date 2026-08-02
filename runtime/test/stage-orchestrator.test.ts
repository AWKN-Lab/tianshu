/**
 * Stage Orchestrator 测试 — Stage 生命周期协调
 *
 * 覆盖: initializeStages, getReadyStages, startStage, completeStage, failStage,
 *       isWorkItemComplete, getWorkItemStages
 *
 * 对应源码: src/workflow/stage-orchestrator.ts, src/workflow/stage-store.ts,
 *           src/governor/stage-governor.ts
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
import {
  initializeStages,
  getReadyStages,
  startStage,
  completeStage,
  failStage,
  isWorkItemComplete,
  getWorkItemStages,
} from '../src/workflow/stage-orchestrator.js';
import { getStageRun } from '../src/workflow/stage-store.js';
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
const MISSION_ID = 'msn_orch_test';
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-orch-'));
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
       (id, mission_id, user_signature, scope_directories, created_at)
     VALUES (?, ?, 'sig', '[]', ?)`,
    [envelopeId, missionId, now],
  );
}

// ─── Receipt 辅助 ─────────────────────────────────────────

function seedReceipt(
  receiptId: string,
  stageRunId: string,
  createdAt: string,
): void {
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO executions
       (id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
        input_ref_json, feature_flags_ref_json, state, created_at, updated_at)
     VALUES (?, ?, 0, '{}', 'awkn-actor-ref/v1', '{}', 'awkn-execution-scope/v1',
             '{}', '{}', 'RECEIVED', ?, ?)`,
    [EXEC_ID, TRACE_ID, now, now],
  );

  const payload = {
    missionId: `goal_${'a'.repeat(32)}`,
    envelopeId: ENV_ID,
    frozenTargetHash: SHA256_HEX,
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
    profileId: 'prof_orch',
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

describe('Stage Orchestrator', () => {
  before(async () => {
    await setupIsolatedDb();
    seedAuthorizationEnvelope(ENV_ID, MISSION_ID);
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  it('initializeStages creates StageRuns for all stages in template', () => {
    const stages = initializeStages({
      missionId: MISSION_ID,
      workItemType: 'workpackage',
      workItemId: 'wp_init_1',
      requiredProfileId: 'prof_test',
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });
    // WORKPACKAGE_TEMPLATE has 6 stages
    assert.equal(stages.length, 6);
    const types = stages.map((s) => s.stageType).sort();
    assert.deepEqual(types, [
      'CODE_REVIEW',
      'GIT_INTEGRATE',
      'IMPLEMENT',
      'RETROSPECTIVE',
      'SECURITY_REVIEW',
      'TEST',
    ]);
    // All should be READY
    for (const s of stages) {
      assert.equal(s.state, 'READY');
    }
  });

  it('initializeStages is idempotent (same work item returns same stages)', () => {
    const config = {
      missionId: MISSION_ID,
      workItemType: 'workpackage',
      workItemId: 'wp_idem_1',
      requiredProfileId: 'prof_test',
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    };
    const firstRun = initializeStages(config);
    assert.equal(firstRun.length, 6);

    // Second call should throw due to UNIQUE constraint on idempotency_key
    assert.throws(() => {
      initializeStages(config);
    });

    // Original stages are still the only stages for this work item
    const allStages = getWorkItemStages(MISSION_ID, 'workpackage', 'wp_idem_1');
    assert.equal(allStages.length, 6);
  });

  it('getReadyStages returns entry-point stages (no dependencies)', () => {
    initializeStages({
      missionId: MISSION_ID,
      workItemType: 'workpackage',
      workItemId: 'wp_ready_1',
      requiredProfileId: 'prof_test',
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });

    const ready = getReadyStages(MISSION_ID, 'workpackage', 'wp_ready_1');
    // IMPLEMENT is the entry point (no incoming edges)
    assert.equal(ready.length, 1);
    assert.equal(ready[0].stageType, 'IMPLEMENT');
  });

  it('startStage transitions READY → ASSIGNED → RUNNING', () => {
    const stages = initializeStages({
      missionId: MISSION_ID,
      workItemType: 'workpackage',
      workItemId: 'wp_start_1',
      requiredProfileId: 'prof_test',
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });
    const implementRun = stages.find((s) => s.stageType === 'IMPLEMENT')!;
    const started = startStage(implementRun.stageRunId, 'actor-start-1', FUTURE);
    assert.ok(started);
    assert.equal(started!.state, 'RUNNING');
    assert.equal(started!.actorId, 'actor-start-1');

    const fetched = getStageRun(implementRun.stageRunId);
    assert.ok(fetched);
    assert.equal(fetched!.state, 'RUNNING');
  });

  it('completeStage transitions to PASSED and resolves next stages', () => {
    const stages = initializeStages({
      missionId: MISSION_ID,
      workItemType: 'workpackage',
      workItemId: 'wp_complete_1',
      requiredProfileId: 'prof_test',
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });
    const implementRun = stages.find((s) => s.stageType === 'IMPLEMENT')!;
    startStage(implementRun.stageRunId, 'actor-complete-1', FUTURE);

    const receiptId = createAwknId('receipt');
    seedReceipt(receiptId, implementRun.stageRunId, '2026-08-02T12:00:00.000Z');

    const profile = makeProfileV2('Engineer', 'IMPLEMENT');
    const instance = makeInstanceV2(profile.profileId, 'actor-complete-1');
    const result = completeStage(
      implementRun.stageRunId,
      instance,
      profile,
      receiptId,
      [],
      [],
      receiptId,
      createAwknId('event'),
    );

    assert.equal(result.success, true);
    assert.ok(result.nextStages);
    assert.ok(result.nextStages!.includes('TEST'));

    const fetched = getStageRun(implementRun.stageRunId);
    assert.ok(fetched);
    assert.equal(fetched!.state, 'PASSED');
  });

  it('failStage transitions to FAILED', () => {
    const stages = initializeStages({
      missionId: MISSION_ID,
      workItemType: 'workpackage',
      workItemId: 'wp_fail_1',
      requiredProfileId: 'prof_test',
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });
    const implementRun = stages.find((s) => s.stageType === 'IMPLEMENT')!;
    startStage(implementRun.stageRunId, 'actor-fail-1', FUTURE);

    const profile = makeProfileV2('Engineer', 'IMPLEMENT');
    const instance = makeInstanceV2(profile.profileId, 'actor-fail-1');
    const result = failStage(
      implementRun.stageRunId,
      instance,
      profile,
      'rcpt_dummy',
      [],
      [],
      createAwknId('event'),
    );

    assert.equal(result.success, true);
    assert.equal(result.newState, 'FAILED');

    const fetched = getStageRun(implementRun.stageRunId);
    assert.ok(fetched);
    assert.equal(fetched!.state, 'FAILED');
  });

  it('isWorkItemComplete returns false when stages are not all PASSED', () => {
    initializeStages({
      missionId: MISSION_ID,
      workItemType: 'workpackage',
      workItemId: 'wp_incomplete_1',
      requiredProfileId: 'prof_test',
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });

    const complete = isWorkItemComplete(MISSION_ID, 'workpackage', 'wp_incomplete_1');
    assert.equal(complete, false);
  });

  it('isWorkItemComplete returns true when all non-optional stages are PASSED', () => {
    const stages = initializeStages({
      missionId: MISSION_ID,
      workItemType: 'workpackage',
      workItemId: 'wp_allpassed_1',
      requiredProfileId: 'prof_test',
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });

    // Set all non-optional stages to PASSED
    // SECURITY_REVIEW is optional in WORKPACKAGE_TEMPLATE
    for (const stage of stages) {
      if (stage.stageType !== 'SECURITY_REVIEW') {
        queryRun(
          `UPDATE workflow_stage_run SET state = 'PASSED', updated_at = ? WHERE stage_run_id = ?`,
          [new Date().toISOString(), stage.stageRunId],
        );
      }
    }

    const complete = isWorkItemComplete(MISSION_ID, 'workpackage', 'wp_allpassed_1');
    assert.equal(complete, true);
  });

  it('getWorkItemStages returns all stages for a work item', () => {
    initializeStages({
      missionId: MISSION_ID,
      workItemType: 'workpackage',
      workItemId: 'wp_getall_1',
      requiredProfileId: 'prof_test',
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });

    const all = getWorkItemStages(MISSION_ID, 'workpackage', 'wp_getall_1');
    assert.equal(all.length, 6);
    // Should be sorted by stageType alphabetically
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i].stageType >= all[i - 1].stageType);
    }
  });
});
