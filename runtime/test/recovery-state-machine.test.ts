/**
 * Recovery State Machine 测试 — 恢复协调器与死信队列
 *
 * 覆盖:
 *   (a) classifyFailure returns correct class+action for each failure type
 *   (b) attemptRecovery RETRY resets stage to READY
 *   (c) attempt >= maxAttempts → QUARANTINED
 *   (d) Recovery coordinator refuses to sign quality/release PASS
 *   (e) dead-letter store CRUD roundtrip
 *   (f) ROLLBACK action creates rollback target
 *
 * 对应源码: src/recovery/recovery-coordinator.ts, src/recovery/classifier.ts,
 *           src/recovery/dead-letter-store.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb, queryOne, queryRun } from '../src/store/db.js';
import { attemptRecovery, assertNotSigningQualityOrReleasePass } from '../src/recovery/recovery-coordinator.js';
import { classifyFailure } from '../src/recovery/classifier.js';
import {
  recordDeadLetter,
  getDeadLetter,
  getDeadLettersByMission,
  purgeDeadLetters,
} from '../src/recovery/dead-letter-store.js';
import type {
  AgentInstanceV2,
  AgentProfileV2,
} from '../src/contracts/workflow-v2.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-recovery-'));
  process.env.AWKN_DB_PATH = join(tempDir, `${randomUUID()}.db`);
  process.env.AWKN_RECOVERY_AGENT_V1 = 'enforce';
  closeDb();
  getDb();
}

async function cleanupIsolatedDb(): Promise<void> {
  closeDb();
  delete process.env.AWKN_RECOVERY_AGENT_V1;
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

function seedEnvelope(envelopeId: string, missionId: string): void {
  seedGoal(missionId);
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO authorization_envelope
       (id, mission_id, user_signature, scope_directories, created_at)
     VALUES (?, ?, 'sig', '[]', ?)`,
    [envelopeId, missionId, now],
  );
}

function seedStageRun(stageRunId: string, missionId: string, envelopeId: string, state: string = 'FAILED'): string {
  const now = new Date().toISOString();
  queryRun(
    `INSERT INTO workflow_stage_run
       (stage_run_id, mission_id, work_item_type, work_item_id, stage_type, state,
        required_profile_id, frozen_input_hash, authorization_envelope_id,
        input_receipt_ids_json, attempt, idempotency_key, created_at, updated_at)
     VALUES (?, ?, 'workpackage', ?, 'IMPLEMENT', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      stageRunId,
      missionId,
      `wp_${'a'.repeat(32)}`,
      state,
      'prof-test',
      SHA256_HEX,
      envelopeId,
      '[]',
      `idem-${stageRunId}`,
      now,
      now,
    ],
  );
  return stageRunId;
}

function seedReleaseBundle(releaseBundleId: string, missionId: string, envelopeId: string): void {
  const now = new Date().toISOString();
  queryRun(
    `INSERT INTO workflow_release_bundle
       (release_bundle_id, mission_id, work_item_id, frozen_source_sha,
        artifact_digest, sbom_digest, issued_actor_id,
        authorization_envelope_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?)`,
    [
      releaseBundleId,
      missionId,
      `wp_${'a'.repeat(32)}`,
      'b'.repeat(40),
      'd'.repeat(64),
      SHA256_HEX,
      'actor-release',
      envelopeId,
      now,
      now,
    ],
  );
}

function seedDeploymentRun(deploymentRunId: string, releaseBundleId: string, envelopeId: string): void {
  const now = new Date().toISOString();
  queryRun(
    `INSERT INTO workflow_deployment_run
       (deployment_run_id, release_bundle_id, target_environment,
        authorization_envelope_id, gray_stage, health_status, final_verdict,
        rollback_target_id, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, 'staging', ?, 'HEALTH_CHECK', 'UNHEALTHY', NULL, NULL, ?, NULL, ?, ?)`,
    [deploymentRunId, releaseBundleId, envelopeId, now, now, now],
  );
}

// ─── AgentProfileV2 / AgentInstanceV2 辅助 ───────────────

function makeRecoveryProfile(): AgentProfileV2 {
  return {
    schema: 'awkn-agent-profile/v2',
    profileId: `prof_recovery_${randomUUID().slice(0, 8)}`,
    version: '1.0.0',
    role: 'Recovery',
    specialty: 'RECOVERY',
    capabilities: ['recovery'],
    inputTypes: ['failure'],
    outputTypes: ['recovery'],
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

function makeRecoveryInstance(profileId: string, envelopeId: string): AgentInstanceV2 {
  const actorId = `actor-recovery-${randomUUID().slice(0, 8)}`;
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
    authorizationEnvelopeId: envelopeId,
    leaseId: 'lease-' + actorId,
    leaseExpiresAt: FUTURE,
    createdAt: NOW,
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Recovery State Machine', () => {
  let missionId: string;
  let envelopeId: string;

  before(async () => {
    await setupIsolatedDb();
    missionId = `goal_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    envelopeId = `env_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedEnvelope(envelopeId, missionId);
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  describe('classifyFailure', () => {
    it('returns correct class+action for each failure type', () => {
      // network/timeout → TRANSIENT/RETRY
      const network = classifyFailure({ errorMessage: 'connection timeout to database' });
      assert.equal(network.failureClass, 'TRANSIENT');
      assert.equal(network.recommendedAction, 'RETRY');

      // permission denied → SECURITY/ESCALATE
      const perm = classifyFailure({ errorMessage: 'permission denied: cannot write file' });
      assert.equal(perm.failureClass, 'SECURITY');
      assert.equal(perm.recommendedAction, 'ESCALATE');

      // assertion/test failure → PERMANENT/REASSIGN
      const test = classifyFailure({ errorMessage: 'assertion failed: expected 5 but got 3' });
      assert.equal(test.failureClass, 'PERMANENT');
      assert.equal(test.recommendedAction, 'REASSIGN');

      // health check fail → PERMANENT/ROLLBACK
      const health = classifyFailure({ errorMessage: 'health check failed: endpoint unhealthy' });
      assert.equal(health.failureClass, 'PERMANENT');
      assert.equal(health.recommendedAction, 'ROLLBACK');

      // unknown → UNKNOWN/ESCALATE
      const unknown = classifyFailure({ errorMessage: 'something unexpected happened' });
      assert.equal(unknown.failureClass, 'UNKNOWN');
      assert.equal(unknown.recommendedAction, 'ESCALATE');
    });
  });

  describe('attemptRecovery', () => {
    it('RETRY resets stage to READY', async () => {
      const stageRunId = `srun_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      seedStageRun(stageRunId, missionId, envelopeId, 'FAILED');

      const profile = makeRecoveryProfile();
      const instance = makeRecoveryInstance(profile.profileId, envelopeId);

      const result = await attemptRecovery({
        missionId,
        envelopeId,
        stageRunId,
        failureInfo: { errorMessage: 'connection timeout to database' },
        actorInstance: instance,
        actorProfile: profile,
        priorInstances: [],
        priorProfiles: [],
        attempt: 0,
      });

      assert.equal(result.success, true, result.reason);
      assert.ok(result.recoveryAttempt);
      assert.equal(result.recoveryAttempt!.recoveryAction, 'RETRY');

      // Verify stage was reset to READY
      const stageRow = queryOne<{ state: string }>(
        'SELECT state FROM workflow_stage_run WHERE stage_run_id = ?',
        [stageRunId],
      );
      assert.ok(stageRow);
      assert.equal(stageRow!.state, 'READY');
    });

    it('attempt >= maxAttempts → QUARANTINED', async () => {
      const stageRunId = `srun_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      seedStageRun(stageRunId, missionId, envelopeId, 'FAILED');

      const profile = makeRecoveryProfile();
      const instance = makeRecoveryInstance(profile.profileId, envelopeId);

      const result = await attemptRecovery({
        missionId,
        envelopeId,
        stageRunId,
        failureInfo: { errorMessage: 'connection timeout' },
        actorInstance: instance,
        actorProfile: profile,
        priorInstances: [],
        priorProfiles: [],
        attempt: 3, // >= maxAttempts (default 3)
        maxAttempts: 3,
      });

      assert.equal(result.success, false);
      assert.ok(result.recoveryAttempt);
      assert.equal(result.recoveryAttempt!.status, 'QUARANTINED');
      assert.equal(result.recoveryAttempt!.recoveryAction, 'QUARANTINE');

      // Verify stage was quarantined
      const stageRow = queryOne<{ state: string }>(
        'SELECT state FROM workflow_stage_run WHERE stage_run_id = ?',
        [stageRunId],
      );
      assert.ok(stageRow);
      assert.equal(stageRow!.state, 'QUARANTINED');
    });

    it('refuses to sign quality/release PASS', () => {
      // The guard must throw when asked to sign quality PASS
      assert.throws(
        () => assertNotSigningQualityOrReleasePass('quality', 'PASS'),
        /MUST NOT sign quality PASS/i,
      );
      // The guard must throw when asked to sign release PASS
      assert.throws(
        () => assertNotSigningQualityOrReleasePass('release', 'PASS'),
        /MUST NOT sign release PASS/i,
      );
      // The guard must NOT throw for non-PASS verdicts
      assert.doesNotThrow(() => assertNotSigningQualityOrReleasePass('quality', 'FAIL'));
      assert.doesNotThrow(() => assertNotSigningQualityOrReleasePass('release', 'BLOCKED'));
    });

    it('ROLLBACK action creates rollback target', async () => {
      const releaseBundleId = `rb_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      const deploymentRunId = `dt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      seedReleaseBundle(releaseBundleId, missionId, envelopeId);
      seedDeploymentRun(deploymentRunId, releaseBundleId, envelopeId);

      const profile = makeRecoveryProfile();
      const instance = makeRecoveryInstance(profile.profileId, envelopeId);

      const result = await attemptRecovery({
        missionId,
        envelopeId,
        deploymentRunId,
        failureInfo: { errorMessage: 'health check failed: endpoint unhealthy' },
        actorInstance: instance,
        actorProfile: profile,
        priorInstances: [],
        priorProfiles: [],
        attempt: 0,
      });

      assert.equal(result.success, true, result.reason);
      assert.ok(result.recoveryAttempt);
      assert.equal(result.recoveryAttempt!.recoveryAction, 'ROLLBACK');

      // Verify rollback target created in DB
      const rollbackRow = queryOne<{ rollback_target_id: string; deployment_run_id: string }>(
        'SELECT rollback_target_id, deployment_run_id FROM workflow_rollback_target WHERE deployment_run_id = ?',
        [deploymentRunId],
      );
      assert.ok(rollbackRow, 'rollback target should be created');
      assert.equal(rollbackRow!.deployment_run_id, deploymentRunId);

      // Verify deployment run was rolled back
      const deployRow = queryOne<{ gray_stage: string }>(
        'SELECT gray_stage FROM workflow_deployment_run WHERE deployment_run_id = ?',
        [deploymentRunId],
      );
      assert.ok(deployRow);
      assert.equal(deployRow!.gray_stage, 'ROLLED_BACK');
    });
  });

  describe('Dead Letter Store', () => {
    it('CRUD roundtrip', () => {
      const stageRunId = `srun_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      seedStageRun(stageRunId, missionId, envelopeId, 'FAILED');

      // Record
      const dlId = recordDeadLetter({
        stageRunId,
        missionId,
        reason: 'max retries exceeded',
        errorText: 'timeout after 3 attempts',
        attempts: 3,
        payload: { stage: 'IMPLEMENT', detail: 'test payload' },
      });
      assert.ok(dlId);

      // Read single
      const record = getDeadLetter(dlId);
      assert.ok(record);
      assert.equal(record!.reason, 'max retries exceeded');
      assert.equal(record!.attempts, 3);
      assert.equal(record!.errorText, 'timeout after 3 attempts');

      // Read by mission
      const byMission = getDeadLettersByMission(missionId);
      assert.ok(byMission.length >= 1);
      const found = byMission.find((r) => r.id === dlId);
      assert.ok(found);

      // Purge by mission
      const purged = purgeDeadLetters(missionId);
      assert.ok(purged >= 1);

      // Verify deleted
      const after = getDeadLetter(dlId);
      assert.equal(after, undefined);
    });
  });
});
