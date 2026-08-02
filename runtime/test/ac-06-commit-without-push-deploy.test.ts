/**
 * AC-06 — Commit Allowed Without Push/Deploy
 *
 * 验收标准：授权信封可细粒度区分 git commit / git push / deploy 权限。
 * 当信封 allowGitCommit=true 但 allowGitPush=false、allowDeploy=false 时：
 *   - executeGitIntegration（commit）成功，产出 PASS GIT 回执
 *   - executeDeployment 被拒绝（allowDeploy=false），不创建 DeploymentRun
 *   - deployEnvironments 不包含目标环境时也被拒绝
 *
 * 这验证了授权信封的"最小权限"边界：commit 通过不代表 push/deploy 自动放行。
 *
 * 对应源码: src/git-agent/git-coordinator.ts, src/deploy/deploy-coordinator.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import {
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
  ARTIFACT_DIGEST,
} from './_ac-helpers.js';
import { executeGitIntegration } from '../src/git-agent/git-coordinator.js';
import { executeDeployment } from '../src/deploy/deploy-coordinator.js';
import { LocalCanaryProvider } from '../src/deploy/local-canary-provider.js';
import { queryRun } from '../src/store/db.js';

describe('AC-06 — Commit Allowed Without Push/Deploy', () => {
  let missionId: string;
  let envelopeId: string;

  before(async () => {
    await setupIsolatedTestDb('wf-ac06-');
    missionId = makeMissionId();
    envelopeId = makeEnvelopeId();
    // Envelope allows git commit ONLY; push and deploy are denied.
    seedAuthorizationEnvelope(envelopeId, missionId, {
      allowGitCommit: true,
      allowGitPush: false,
      allowDeploy: false,
      deployEnvironments: ['staging'],
    });
  });

  after(async () => {
    await cleanupIsolatedTestDb();
  });

  // Deploy coordinator requires AWKN_DEPLOY_AGENT_V1=enforce; sanitize per-test.
  beforeEach(() => {
    process.env.AWKN_DEPLOY_AGENT_V1 = 'enforce';
  });

  afterEach(() => {
    delete process.env.AWKN_DEPLOY_AGENT_V1;
  });

  it('executeGitIntegration succeeds when allowGitCommit=true', async () => {
    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE', 'prof-git-ac06');
    const gitInstance = makeInstanceV2(gitProfile.profileId, 'actor-git-ac06', envelopeId);

    const result = await executeGitIntegration({
      missionId,
      workItemId: makeWorkPackageId(),
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [],
      priorProfiles: [],
      commitSha: 'a'.repeat(40),
      commitVerified: true,
      filesChanged: ['src/index.ts'],
    });

    assert.equal(result.success, true, `commit should be allowed: ${result.reason}`);
    assert.equal(result.verdict, 'PASS');
    assert.ok(result.receiptId, 'commit must produce a GIT receipt');
  });

  it('executeDeployment is rejected when allowDeploy=false', async () => {
    // Seed a release bundle so the deploy failure is due to envelope, not missing bundle.
    const releaseBundleId = seedReleaseBundle(missionId, envelopeId);

    const deployProfile = makeProfileV2('Deploy', 'DEPLOY', 'prof-deploy-ac06-nod');
    const deployInstance = makeInstanceV2(deployProfile.profileId, 'actor-deploy-ac06-nod', envelopeId);

    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: deployInstance,
      actorProfile: deployProfile,
      priorInstances: [],
      priorProfiles: [],
      provider: new LocalCanaryProvider(),
    });

    assert.equal(result.success, false);
    assert.ok(result.reason, 'must provide a rejection reason');
    assert.match(result.reason!, /does not allow deploy/i);
    assert.equal(result.deploymentRun, undefined, 'no DeploymentRun should be created');
    assert.equal(result.rolledBack, undefined, 'no rollback should occur');
  });

  it('deploy is blocked even when a valid release bundle exists (envelope is the gate)', async () => {
    const releaseBundleId = seedReleaseBundle(missionId, envelopeId);

    const deployProfile = makeProfileV2('Deploy', 'DEPLOY', 'prof-deploy-ac06-bundle');
    const deployInstance = makeInstanceV2(deployProfile.profileId, 'actor-deploy-ac06-bundle', envelopeId);

    const provider = new LocalCanaryProvider();
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
    assert.match(result.reason!, /does not allow deploy/i);
    // Provider must never have been called (envelope gate runs before deploy)
    assert.equal(provider.getDeployCount(), 0, 'provider.deploy must not be called when envelope denies');
    assert.equal(provider.getRollbackCount(), 0);
  });

  it('a separate envelope WITH allowDeploy=true permits deploy (control case)', async () => {
    const deployEnvelope = makeEnvelopeId();
    seedAuthorizationEnvelope(deployEnvelope, missionId, {
      allowGitCommit: true,
      allowGitPush: false,
      allowDeploy: true,
      deployEnvironments: ['staging'],
    });
    const releaseBundleId = seedReleaseBundle(missionId, deployEnvelope);

    const deployProfile = makeProfileV2('Deploy', 'DEPLOY', 'prof-deploy-ac06-ok');
    const deployInstance = makeInstanceV2(deployProfile.profileId, 'actor-deploy-ac06-ok', deployEnvelope);

    const provider = new LocalCanaryProvider(); // default HEALTHY
    const result = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId: deployEnvelope,
      actorInstance: deployInstance,
      actorProfile: deployProfile,
      priorInstances: [],
      priorProfiles: [],
      provider,
    });

    assert.equal(result.success, true, `deploy should succeed with allowDeploy=true: ${result.reason}`);
    assert.equal(result.deploymentRun!.grayStage, 'COMPLETED');
    assert.equal(provider.getDeployCount(), 1);
  });

  it('commit and deploy use distinct actor/session (separation holds)', async () => {
    // Engineer actor must not be reused by Git or Deploy. Verify the envelope still
    // allows commit when Git actor is distinct, and deploy is still blocked by envelope.
    const engineerProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-ac06-sep');
    const engineerInstance = makeInstanceV2(
      engineerProfile.profileId,
      'actor-eng-ac06-sep',
      envelopeId,
      { sessionId: 'session-eng-ac06-sep' },
    );

    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE', 'prof-git-ac06-sep');
    const gitInstance = makeInstanceV2(
      gitProfile.profileId,
      'actor-git-ac06-sep',
      envelopeId,
      { sessionId: 'session-git-ac06-sep' },
    );

    const gitResult = await executeGitIntegration({
      missionId,
      workItemId: makeWorkPackageId(),
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [engineerInstance],
      priorProfiles: [engineerProfile],
      commitSha: 'b'.repeat(40),
      commitVerified: true,
      filesChanged: ['src/sep.ts'],
    });
    assert.equal(gitResult.success, true, 'commit allowed with distinct Git actor');

    // Deploy still blocked by envelope even with distinct actor
    const releaseBundleId = seedReleaseBundle(missionId, envelopeId);
    const deployProfile = makeProfileV2('Deploy', 'DEPLOY', 'prof-deploy-ac06-sep');
    const deployInstance = makeInstanceV2(
      deployProfile.profileId,
      'actor-deploy-ac06-sep',
      envelopeId,
      { sessionId: 'session-deploy-ac06-sep' },
    );
    const deployResult = await executeDeployment({
      releaseBundleId,
      targetEnvironment: 'staging',
      envelopeId,
      actorInstance: deployInstance,
      actorProfile: deployProfile,
      priorInstances: [engineerInstance],
      priorProfiles: [engineerProfile],
      provider: new LocalCanaryProvider(),
    });
    assert.equal(deployResult.success, false);
    assert.match(deployResult.reason!, /does not allow deploy/i);
  });
});

// ─── 辅助：播种 ReleaseBundle（AC-06 测试专用） ──────────

function seedReleaseBundle(missionId: string, envelopeId: string): string {
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
      'actor-release-ac06',
      envelopeId,
      now,
      now,
    ],
  );
  return releaseBundleId;
}
