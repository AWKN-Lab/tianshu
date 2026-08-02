/**
 * Deploy Rollback 测试 — 部署运行协调器与自动回滚
 *
 * 覆盖:
 *   (a) executeDeployment succeeds with HEALTHY canary → COMPLETED
 *   (b) UNHEALTHY canary triggers auto-rollback → ROLLED_BACK + rollbackTarget created
 *   (c) rejects when actor was Release engineer (separation)
 *   (d) rejects when envelope lacks allowDeploy
 *   (e) rejects when targetEnvironment not in deployEnvironments
 *
 * 对应源码: src/deploy/deploy-coordinator.ts, src/deploy/local-canary-provider.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb, queryOne, queryRun } from '../src/store/db.js';
import { executeDeployment } from '../src/deploy/deploy-coordinator.js';
import { LocalCanaryProvider } from '../src/deploy/local-canary-provider.js';
import type {
  AgentInstanceV2,
  AgentProfileV2,
  AgentRole,
  WorkflowStageType,
} from '../src/contracts/workflow-v2.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const SOURCE_SHA = 'b'.repeat(40);
const ARTIFACT_DIGEST = 'd'.repeat(64);
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-deploy-'));
  process.env.AWKN_DB_PATH = join(tempDir, `${randomUUID()}.db`);
  process.env.AWKN_DEPLOY_AGENT_V1 = 'enforce';
  closeDb();
  getDb();
}

async function cleanupIsolatedDb(): Promise<void> {
  closeDb();
  delete process.env.AWKN_DEPLOY_AGENT_V1;
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

function seedEnvelope(
  envelopeId: string,
  missionId: string,
  opts: { allowDeploy?: boolean; deployEnvironments?: string[] } = {},
): void {
  seedGoal(missionId);
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO authorization_envelope
       (id, mission_id, user_signature, scope_directories, allow_deploy,
        deploy_environments, created_at)
     VALUES (?, ?, 'sig', '[]', ?, ?, ?)`,
    [
      envelopeId,
      missionId,
      opts.allowDeploy ? 1 : 0,
      opts.deployEnvironments ? JSON.stringify(opts.deployEnvironments) : null,
      now,
    ],
  );
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
      SOURCE_SHA,
      ARTIFACT_DIGEST,
      SHA256_HEX,
      'actor-release',
      envelopeId,
      now,
      now,
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
    profileId: `prof_${role.toLowerCase()}_${randomUUID().slice(0, 8)}`,
    version: '1.0.0',
    role,
    specialty,
    capabilities: [role.toLowerCase()],
    inputTypes: ['release'],
    outputTypes: ['deploy'],
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
  envelopeId: string,
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
    authorizationEnvelopeId: envelopeId,
    leaseId: 'lease-' + actorId,
    leaseExpiresAt: FUTURE,
    createdAt: NOW,
    ...overrides,
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Deploy Rollback', () => {
  let missionId: string;
  let envelopeId: string;
  let releaseBundleId: string;

  before(async () => {
    await setupIsolatedDb();
    missionId = `goal_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    envelopeId = `env_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    releaseBundleId = `rb_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedEnvelope(envelopeId, missionId, {
      allowDeploy: true,
      deployEnvironments: ['staging', 'production'],
    });
    seedReleaseBundle(releaseBundleId, missionId, envelopeId);
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  it('succeeds with HEALTHY canary → COMPLETED', async () => {
    const deployProfile = makeProfileV2('Deploy', 'DEPLOY');
    const deployInstance = makeInstanceV2(deployProfile.profileId, 'actor-deploy-ok', envelopeId);
    const provider = new LocalCanaryProvider(); // default HEALTHY

    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: deployInstance,
      actorProfile: deployProfile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(result.success, true, result.reason);
    assert.ok(result.deploymentRun);
    assert.equal(result.deploymentRun!.grayStage, 'COMPLETED');
    assert.equal(result.deploymentRun!.healthStatus, 'HEALTHY');
    assert.ok(result.receiptId);
    assert.equal(provider.getDeployCount(), 1);
    assert.equal(provider.getRollbackCount(), 0);
  });

  it('UNHEALTHY canary triggers auto-rollback → ROLLED_BACK + rollbackTarget created', async () => {
    const deployProfile = makeProfileV2('Deploy', 'DEPLOY');
    const deployInstance = makeInstanceV2(deployProfile.profileId, 'actor-deploy-unhealthy', envelopeId);
    const provider = new LocalCanaryProvider({ healthStatus: 'UNHEALTHY' });

    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: deployInstance,
      actorProfile: deployProfile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true);
    assert.ok(result.rollbackTargetId);
    assert.ok(result.deploymentRun);
    assert.equal(result.deploymentRun!.grayStage, 'ROLLED_BACK');
    assert.equal(result.deploymentRun!.healthStatus, 'UNHEALTHY');
    assert.equal(provider.getRollbackCount(), 1);

    // Verify rollback target persisted in DB
    const rollbackRow = queryOne<{ rollback_target_id: string; deployment_run_id: string }>(
      'SELECT rollback_target_id, deployment_run_id FROM workflow_rollback_target WHERE rollback_target_id = ?',
      [result.rollbackTargetId],
    );
    assert.ok(rollbackRow);
    assert.equal(rollbackRow!.deployment_run_id, result.deploymentRun!.deploymentRunId);
  });

  it('rejects when actor was Release engineer (separation)', async () => {
    const releaseProfile = makeProfileV2('Release', 'RELEASE_BUILD');
    const releaseInstance = makeInstanceV2(
      releaseProfile.profileId,
      'actor-shared-release',
      envelopeId,
      { sessionId: 'session-release-sep' },
    );

    const deployProfile = makeProfileV2('Deploy', 'DEPLOY');
    const deployInstance = makeInstanceV2(
      deployProfile.profileId,
      'actor-shared-release', // same actorId → separation violation
      envelopeId,
      { sessionId: 'session-deploy-sep' },
    );

    const provider = new LocalCanaryProvider();
    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: deployInstance,
      actorProfile: deployProfile,
      priorInstances: [releaseInstance],
      priorProfiles: [releaseProfile],
      provider,
    });

    assert.equal(result.success, false);
    assert.ok(result.reason);
    assert.match(result.reason!, /separation|incompatible|actor/i);
  });

  it('rejects when envelope lacks allowDeploy', async () => {
    const noDeployEnvId = `env_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedEnvelope(noDeployEnvId, missionId, { allowDeploy: false });

    const deployProfile = makeProfileV2('Deploy', 'DEPLOY');
    const deployInstance = makeInstanceV2(deployProfile.profileId, 'actor-deploy-noallow', noDeployEnvId);

    const provider = new LocalCanaryProvider();
    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId: noDeployEnvId,
      actorInstance: deployInstance,
      actorProfile: deployProfile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(result.success, false);
    assert.ok(result.reason);
    assert.match(result.reason!, /does not allow deploy/i);
  });

  it('rejects when targetEnvironment not in deployEnvironments', async () => {
    const deployProfile = makeProfileV2('Deploy', 'DEPLOY');
    const deployInstance = makeInstanceV2(deployProfile.profileId, 'actor-deploy-badenv', envelopeId);

    const provider = new LocalCanaryProvider();
    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'prod-external', // not in ['staging', 'production']
      envelopeId,
      actorInstance: deployInstance,
      actorProfile: deployProfile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(result.success, false);
    assert.ok(result.reason);
    assert.match(result.reason!, /not in deploy environments/i);
  });
});
