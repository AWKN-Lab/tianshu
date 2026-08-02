/**
 * Workflow Runtime 测试 — Mission 级工作流启动、状态查询、取消与恢复
 *
 * 覆盖: startWorkflow, getWorkflowStatus, initializeWorkItemStages,
 *       cancelWorkflow, resumeWorkflow
 *
 * 对应源码: src/workflow/workflow-runtime.ts, src/workflow/stage-orchestrator.ts,
 *           src/workflow/stage-store.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb, queryRun } from '../src/store/db.js';
import {
  startWorkflow,
  getWorkflowStatus,
  initializeWorkItemStages,
  cancelWorkflow,
  resumeWorkflow,
} from '../src/workflow/workflow-runtime.js';
import { getStageRunsByMission } from '../src/workflow/stage-store.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const ENV_ID = `env_${'a'.repeat(32)}`;

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-runtime-'));
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

// ─── 测试用例 ─────────────────────────────────────────────

describe('Workflow Runtime', () => {
  before(async () => {
    await setupIsolatedDb();
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  it('startWorkflow initializes mission-level stages', () => {
    const missionId = 'msn_rt_start_1';
    seedAuthorizationEnvelope(ENV_ID, missionId);

    const result = startWorkflow({
      missionId,
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });

    assert.equal(result.success, true);
    assert.ok(result.missionInitStages);
    // MISSION_INIT_TEMPLATE has 6 stages
    assert.equal(result.missionInitStages!.length, 6);
    const types = result.missionInitStages!.map((s) => s.stageType).sort();
    assert.deepEqual(types, [
      'ARCHITECTURE_AUTHOR',
      'ARCHITECTURE_REVIEW',
      'PLAN_AUTHOR',
      'PLAN_REVIEW',
      'PRODUCT_AUTHOR',
      'REQUIREMENTS_REVIEW',
    ]);
  });

  it('getWorkflowStatus returns correct counts after start', () => {
    const missionId = 'msn_rt_status_1';
    seedAuthorizationEnvelope(ENV_ID, missionId);

    startWorkflow({
      missionId,
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });

    const status = getWorkflowStatus(missionId);
    assert.equal(status.missionId, missionId);
    assert.equal(status.totalStages, 6);
    assert.equal(status.readyStages, 6);
    assert.equal(status.passedStages, 0);
    assert.equal(status.failedStages, 0);
    assert.equal(status.blockedStages, 0);
    assert.equal(status.runningStages, 0);
    assert.equal(status.isComplete, false);
  });

  it('initializeWorkItemStages creates stages for a work package', () => {
    const missionId = 'msn_rt_wp_1';
    seedAuthorizationEnvelope(ENV_ID, missionId);

    const stages = initializeWorkItemStages(
      missionId,
      'workpackage',
      'wp_rt_1',
      'prof_test',
      ENV_ID,
      SHA256_HEX,
    );

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
  });

  it('getWorkflowStatus reflects new work item stages', () => {
    const missionId = 'msn_rt_wp_status_1';
    seedAuthorizationEnvelope(ENV_ID, missionId);

    // Start mission-level workflow (6 stages)
    startWorkflow({
      missionId,
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });

    // Initialize a work package (6 more stages)
    initializeWorkItemStages(
      missionId,
      'workpackage',
      'wp_rt_status_1',
      'prof_test',
      ENV_ID,
      SHA256_HEX,
    );

    const status = getWorkflowStatus(missionId);
    assert.equal(status.totalStages, 12); // 6 mission + 6 workpackage
    assert.equal(status.readyStages, 12);
    assert.equal(status.isComplete, false);
  });

  it('cancelWorkflow sets all non-terminal stages to ROLLED_BACK', () => {
    const missionId = 'msn_rt_cancel_1';
    seedAuthorizationEnvelope(ENV_ID, missionId);

    startWorkflow({
      missionId,
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });

    // All 6 stages are READY (non-terminal)
    const result = cancelWorkflow(missionId);
    assert.equal(result.success, true);
    assert.equal(result.cancelledCount, 6);

    // Verify all stages are now ROLLED_BACK
    const runs = getStageRunsByMission(missionId);
    assert.equal(runs.length, 6);
    for (const run of runs) {
      assert.equal(run.state, 'ROLLED_BACK');
    }
  });

  it('resumeWorkflow resets BLOCKED stages to READY if dependencies are met', () => {
    const missionId = 'msn_rt_resume_1';
    seedAuthorizationEnvelope(ENV_ID, missionId);

    startWorkflow({
      missionId,
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });

    // Get the REQUIREMENTS_REVIEW stage (depends on PRODUCT_AUTHOR via on_pass)
    const runs = getStageRunsByMission(missionId);
    const productAuthor = runs.find((r) => r.stageType === 'PRODUCT_AUTHOR')!;
    const requirementsReview = runs.find((r) => r.stageType === 'REQUIREMENTS_REVIEW')!;

    // Set PRODUCT_AUTHOR to PASSED (dependency satisfied)
    queryRun(
      `UPDATE workflow_stage_run SET state = 'PASSED', updated_at = ? WHERE stage_run_id = ?`,
      [new Date().toISOString(), productAuthor.stageRunId],
    );

    // Set REQUIREMENTS_REVIEW to BLOCKED
    queryRun(
      `UPDATE workflow_stage_run SET state = 'BLOCKED', updated_at = ? WHERE stage_run_id = ?`,
      [new Date().toISOString(), requirementsReview.stageRunId],
    );

    // Resume workflow — should reset BLOCKED stages whose on_pass deps are PASSED
    const result = resumeWorkflow(missionId);
    assert.equal(result.success, true);

    // REQUIREMENTS_REVIEW should now be READY (its predecessor PRODUCT_AUTHOR is PASSED)
    const afterRuns = getStageRunsByMission(missionId);
    const reqReviewAfter = afterRuns.find((r) => r.stageType === 'REQUIREMENTS_REVIEW')!;
    assert.equal(reqReviewAfter.state, 'READY');
  });

  it('getWorkflowStatus isComplete is false initially, true after all PASSED', () => {
    const missionId = 'msn_rt_complete_1';
    seedAuthorizationEnvelope(ENV_ID, missionId);

    startWorkflow({
      missionId,
      authorizationEnvelopeId: ENV_ID,
      frozenInputHash: SHA256_HEX,
    });

    // Initially not complete
    const initialStatus = getWorkflowStatus(missionId);
    assert.equal(initialStatus.isComplete, false);

    // Manually set all stages to PASSED
    const runs = getStageRunsByMission(missionId);
    for (const run of runs) {
      queryRun(
        `UPDATE workflow_stage_run SET state = 'PASSED', updated_at = ? WHERE stage_run_id = ?`,
        [new Date().toISOString(), run.stageRunId],
      );
    }

    // Now should be complete
    const finalStatus = getWorkflowStatus(missionId);
    assert.equal(finalStatus.isComplete, true);
    assert.equal(finalStatus.passedStages, 6);
    assert.equal(finalStatus.readyStages, 0);
    assert.equal(finalStatus.runningStages, 0);
    assert.equal(finalStatus.failedStages, 0);
    assert.equal(finalStatus.blockedStages, 0);
  });
});
