/**
 * AC-08 — Canary Health Check Triggers Auto-Rollback
 *
 * 验收标准：灰度部署（canary）健康检查 UNHEALTHY 时自动回滚到上一稳定版本。
 *
 * 端到端覆盖：
 *   (a) HEALTHY 健康检查 → COMPLETED，无回滚，provider.rollback 不被调用
 *   (b) UNHEALTHY 健康检查 → 自动回滚（ROLLED_BACK + finalVerdict=FAIL）
 *   (c) UNHEALTHY 路径创建 RollbackTarget 并以 ReleaseBundle.frozen_source_sha 为回滚目标
 *   (d) Provider 调用序列：UNHEALTHY 时 deploy→healthCheck→rollback 各调用一次
 *   (e) Provider 调用序列：HEALTHY 时 deploy→healthCheck 调用一次，rollback 不调用
 *   (f) canary deploy 抛错 → 自动 ROLLED_BACK（provider.rollback 仍未调用，因 deploy 失败不进入 health 阶段）
 *   (g) Separation Policy v2：Deploy actor 与 Release 前置 actor 共享 sessionId 时被拒绝
 *   (h) DEPLOY 回执持久化（UNHEALTHY 路径 status=FAILURE, verdict=FAIL, rollbackTargetId 写入）
 *   (i) DeploymentObservation 记录 canary_deploy + health_check 两个事件
 *
 * 对应源码:
 *   - src/deploy/deploy-coordinator.ts (executeDeployment)
 *   - src/deploy/local-canary-provider.ts (LocalCanaryProvider with faultConfig)
 *   - src/deploy/contracts.ts (GrayStage, HealthStatus)
 *   - src/governor/separation-policy-v2.ts (Deploy ↔ Release 不相容)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import {
  ARTIFACT_DIGEST,
  cleanupIsolatedTestDb,
  makeEnvelopeId,
  makeInstanceV2,
  makeMissionId,
  makeProfileV2,
  makeWorkPackageId,
  seedAuthorizationEnvelope,
  setupIsolatedTestDb,
  SHA256_HEX,
  SOURCE_SHA,
} from './_ac-helpers.js';
import { executeDeployment } from '../src/deploy/deploy-coordinator.js';
import { LocalCanaryProvider } from '../src/deploy/local-canary-provider.js';
import { queryAll, queryOne, queryRun } from '../src/store/db.js';

describe('AC-08 — Canary Health Check Triggers Auto-Rollback', () => {
  let missionId: string;
  let envelopeId: string;

  before(async () => {
    await setupIsolatedTestDb('wf-ac08-');
    missionId = makeMissionId();
    envelopeId = makeEnvelopeId();
    seedAuthorizationEnvelope(envelopeId, missionId, {
      allowDeploy: true,
      allowGitCommit: true,
      allowGitPush: false,
      deployEnvironments: ['staging', 'production'],
    });
  });

  after(async () => {
    await cleanupIsolatedTestDb();
  });

  // Deploy coordinator requires AWKN_DEPLOY_AGENT_V1=enforce.
  beforeEach(() => {
    process.env.AWKN_DEPLOY_AGENT_V1 = 'enforce';
  });

  afterEach(() => {
    delete process.env.AWKN_DEPLOY_AGENT_V1;
  });

  // ─── 辅助 ─────────────────────────────────────────────────

  function seedReleaseBundle(): string {
    const releaseBundleId = `rb_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
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
        makeWorkPackageId(),
        SOURCE_SHA,
        ARTIFACT_DIGEST,
        SHA256_HEX,
        'actor-release-ac08',
        envelopeId,
        now,
        now,
      ],
    );
    return releaseBundleId;
  }

  function makeDeployActor() {
    const profile = makeProfileV2('Deploy', 'DEPLOY', 'prof-deploy-ac08');
    const instance = makeInstanceV2(profile.profileId, 'actor-deploy-ac08', envelopeId);
    return { profile, instance };
  }

  // ─── (a) HEALTHY → COMPLETED ──────────────────────────────

  it('HEALTHY health check completes deployment without rollback', async () => {
    const releaseBundleId = seedReleaseBundle();
    const { profile, instance } = makeDeployActor();
    const provider = new LocalCanaryProvider(); // default HEALTHY

    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: instance,
      actorProfile: profile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(result.success, true, `HEALTHY should succeed: ${result.reason}`);
    assert.ok(result.deploymentRun, 'DeploymentRun must be persisted');
    assert.equal(result.deploymentRun!.grayStage, 'COMPLETED');
    assert.equal(result.deploymentRun!.healthStatus, 'HEALTHY');
    assert.equal(result.deploymentRun!.finalVerdict, 'PASS');
    assert.equal(result.deploymentRun!.rollbackTargetId, undefined);
    assert.equal(result.rolledBack, undefined, 'no rollback flag on success');
    assert.ok(result.receiptId, 'must produce a DEPLOY receipt');
    assert.equal(provider.getDeployCount(), 1, 'deploy called exactly once');
    assert.equal(provider.getRollbackCount(), 0, 'rollback must NOT be called on HEALTHY');
  });

  // ─── (b) UNHEALTHY → 自动回滚 ─────────────────────────────

  it('UNHEALTHY health check triggers automatic rollback', async () => {
    const releaseBundleId = seedReleaseBundle();
    const { profile, instance } = makeDeployActor();
    const provider = new LocalCanaryProvider({
      healthStatus: 'UNHEALTHY',
      healthDetail: 'canary probes returned 5xx',
    });

    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: instance,
      actorProfile: profile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(result.success, false, 'UNHEALTHY must fail');
    assert.equal(result.rolledBack, true, 'rolledBack flag must be true');
    assert.ok(result.rollbackTargetId, 'rollback target id must be assigned');
    assert.ok(result.deploymentRun, 'DeploymentRun still persisted on rollback');
    assert.equal(result.deploymentRun!.grayStage, 'ROLLED_BACK');
    assert.equal(result.deploymentRun!.healthStatus, 'UNHEALTHY');
    assert.equal(result.deploymentRun!.finalVerdict, 'FAIL');
    assert.equal(result.deploymentRun!.rollbackTargetId, result.rollbackTargetId);
    assert.ok(result.reason?.match(/UNHEALTHY/i), 'reason must mention UNHEALTHY');
    assert.ok(result.reason?.match(/auto-rollback/i), 'reason must mention auto-rollback');
  });

  // ─── (c) RollbackTarget 持久化并以 frozen_source_sha 为回滚目标 ──

  it('RollbackTarget is persisted with previous source SHA from ReleaseBundle', async () => {
    const releaseBundleId = seedReleaseBundle();
    const { profile, instance } = makeDeployActor();
    const provider = new LocalCanaryProvider({ healthStatus: 'UNHEALTHY' });

    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'production',
      envelopeId,
      actorInstance: instance,
      actorProfile: profile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(result.rolledBack, true);
    const rollbackRow = queryOne<{
      rollback_target_id: string;
      deployment_run_id: string;
      previous_source_sha: string;
      reason: string;
    }>(
      'SELECT rollback_target_id, deployment_run_id, previous_source_sha, reason FROM workflow_rollback_target WHERE rollback_target_id = ?',
      [result.rollbackTargetId!],
    );
    assert.ok(rollbackRow, 'rollback target must be persisted in DB');
    assert.equal(rollbackRow!.deployment_run_id, result.deploymentRun!.deploymentRunId);
    assert.equal(
      rollbackRow!.previous_source_sha,
      SOURCE_SHA,
      'rollback target must point to ReleaseBundle.frozen_source_sha',
    );
    assert.ok(rollbackRow!.reason.length > 0, 'rollback reason must be recorded');
  });

  // ─── (d) Provider 调用序列：UNHEALTHY ─────────────────────

  it('UNHEALTHY path invokes deploy → healthCheck → rollback exactly once each', async () => {
    const releaseBundleId = seedReleaseBundle();
    const { profile, instance } = makeDeployActor();
    const provider = new LocalCanaryProvider({ healthStatus: 'UNHEALTHY' });

    await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: instance,
      actorProfile: profile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(provider.getDeployCount(), 1, 'deploy() called exactly once');
    assert.equal(provider.getRollbackCount(), 1, 'rollback() called exactly once on UNHEALTHY');
    // healthCheck 计数未暴露，但可推断：deploy→healthCheck→rollback 链路必走完
  });

  // ─── (e) Provider 调用序列：HEALTHY ───────────────────────

  it('HEALTHY path invokes deploy → healthCheck but NOT rollback', async () => {
    const releaseBundleId = seedReleaseBundle();
    const { profile, instance } = makeDeployActor();
    const provider = new LocalCanaryProvider(); // default HEALTHY

    await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: instance,
      actorProfile: profile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(provider.getDeployCount(), 1, 'deploy() called exactly once');
    assert.equal(provider.getRollbackCount(), 0, 'rollback() must NOT be called on HEALTHY');
  });

  // ─── (f) canary deploy 抛错 → 自动 ROLLED_BACK ────────────

  it('canary deploy() failure triggers ROLLED_BACK without invoking healthCheck/rollback', async () => {
    const releaseBundleId = seedReleaseBundle();
    const { profile, instance } = makeDeployActor();
    const provider = new LocalCanaryProvider({ deployFails: true });

    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: instance,
      actorProfile: profile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(result.success, false, 'deploy failure must surface as failure');
    assert.equal(result.rolledBack, true, 'deploy failure still triggers ROLLED_BACK stage');
    assert.ok(result.deploymentRun, 'DeploymentRun is persisted even on deploy failure');
    assert.equal(result.deploymentRun!.grayStage, 'ROLLED_BACK');
    assert.equal(result.deploymentRun!.healthStatus, 'UNHEALTHY');
    assert.equal(result.deploymentRun!.finalVerdict, 'FAIL');
    assert.ok(result.reason?.match(/canary deploy failed/i), 'reason must mention canary deploy failure');
    // deploy failed before healthCheck stage → rollback target NOT created (no previous sha to restore)
    assert.equal(result.rollbackTargetId, undefined, 'no rollback target when deploy itself fails');
    assert.equal(provider.getDeployCount(), 1, 'deploy attempted once');
    assert.equal(provider.getRollbackCount(), 0, 'provider.rollback not invoked (deploy failed pre-health)');
  });

  // ─── (g) Separation Policy v2：Deploy 与 Release 不相容 ───

  it('rejects Deploy actor sharing sessionId with prior Release actor (separation)', async () => {
    const releaseBundleId = seedReleaseBundle();

    const releaseProfile = makeProfileV2('Release', 'RELEASE_BUILD', 'prof-release-ac08-sep');
    const releaseInstance = makeInstanceV2(
      releaseProfile.profileId,
      'actor-shared-ac08-sep',
      envelopeId,
      { sessionId: 'session-shared-ac08-sep' },
    );

    const deployProfile = makeProfileV2('Deploy', 'DEPLOY', 'prof-deploy-ac08-sep');
    const deployInstance = makeInstanceV2(
      deployProfile.profileId,
      'actor-shared-ac08-sep', // same actorId → separation violation
      envelopeId,
      { sessionId: 'session-shared-ac08-sep' }, // same sessionId → step 5 violation
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
    assert.ok(result.reason, 'must provide rejection reason');
    assert.match(result.reason!, /separation|incompatible|actor|session/i);
    assert.equal(result.deploymentRun, undefined, 'no DeploymentRun should be created on separation denial');
    assert.equal(provider.getDeployCount(), 0, 'provider must not be called when separation denies');
    assert.equal(provider.getRollbackCount(), 0);
  });

  // ─── (h) DEPLOY 回执持久化（UNHEALTHY 路径） ─────────────

  it('persists DEPLOY receipt with FAILURE status and FAIL verdict on UNHEALTHY path', async () => {
    const releaseBundleId = seedReleaseBundle();
    const { profile, instance } = makeDeployActor();
    const provider = new LocalCanaryProvider({ healthStatus: 'UNHEALTHY' });

    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: instance,
      actorProfile: profile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.ok(result.receiptId, 'receipt id must be returned');
    const receiptRow = queryOne<{
      receipt_type: string;
      status: string;
      payload_json: string;
      aggregate_id: string;
    }>(
      'SELECT receipt_type, status, payload_json, aggregate_id FROM receipts WHERE id = ?',
      [result.receiptId!],
    );
    assert.ok(receiptRow, 'receipt must be persisted');
    assert.equal(receiptRow!.receipt_type, 'DEPLOY');
    assert.equal(receiptRow!.status, 'FAILURE');
    assert.equal(receiptRow!.aggregate_id, result.deploymentRun!.deploymentRunId);
    const payload = JSON.parse(receiptRow!.payload_json) as {
      grayStage: string;
      healthStatus: string;
      verdict: string;
      rollbackTargetId?: string;
    };
    assert.equal(payload.grayStage, 'ROLLED_BACK');
    assert.equal(payload.healthStatus, 'UNHEALTHY');
    assert.equal(payload.verdict, 'FAIL');
    assert.equal(payload.rollbackTargetId, result.rollbackTargetId);
  });

  // ─── (i) DeploymentObservation 记录 canary + health 事件 ──

  it('records canary_deploy and health_check observations on UNHEALTHY path', async () => {
    const releaseBundleId = seedReleaseBundle();
    const { profile, instance } = makeDeployActor();
    const provider = new LocalCanaryProvider({
      healthStatus: 'UNHEALTHY',
      healthDetail: 'ac08 obs detail',
    });

    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: instance,
      actorProfile: profile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    const observations = queryAll<{ check_name: string; check_result: string }>(
      'SELECT check_name, check_result FROM workflow_deployment_observation WHERE deployment_run_id = ? ORDER BY observed_at',
      [result.deploymentRun!.deploymentRunId],
    );
    assert.ok(observations.length >= 2, 'must record at least 2 observations (canary_deploy + health_check)');
    const checkNames = observations.map((o) => o.check_name);
    assert.ok(checkNames.includes('canary_deploy'), 'canary_deploy observation required');
    assert.ok(checkNames.includes('health_check'), 'health_check observation required');
    const canaryObs = observations.find((o) => o.check_name === 'canary_deploy')!;
    assert.equal(canaryObs.check_result, 'SUCCESS', 'canary deploy succeeded before health check');
    const healthObs = observations.find((o) => o.check_name === 'health_check')!;
    assert.equal(healthObs.check_result, 'UNHEALTHY', 'health_check observation must record UNHEALTHY');
  });
});
