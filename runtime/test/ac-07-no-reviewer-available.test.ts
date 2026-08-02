/**
 * AC-07 — No Reviewer Available Blocks Work Item
 *
 * 验收标准：当没有任何 ACTIVE/CANARY 的 Review profile 可分配时，
 * CODE_REVIEW 阶段无法被 attemptAssignment 分配 worker，
 * 工作项因此无法完成（isWorkItemComplete 返回 false）。
 *
 * 覆盖场景：
 *   (a) 完全不注册 Review profile → assigned=false（"no active profile"）
 *   (b) 注册了 Review profile 但状态为 RETIRED/QUARANTINED → assigned=false
 *   (c) 注册了 ACTIVE Review profile 但无 provider 支持 CODE_REVIEW → assigned=false
 *   (d) 控制组：注册 ACTIVE Review profile + 支持 CODE_REVIEW 的 provider → assigned=true
 *   (e) CODE_REVIEW 无法分配 → 工作项 isWorkItemComplete=false
 *
 * 对应源码: src/worker/assignment-service.ts (attemptAssignment, collectCandidateProfiles)
 */
import assert from 'node:assert/strict';
import { describe, it, before, after, afterEach } from 'node:test';
import {
  cleanupIsolatedTestDb,
  completeStageSuccessfully,
  initWorkPackageStages,
  makeEnvelopeId,
  makeInstanceV2,
  makeMissionId,
  makeProfileV2,
  makeWorkPackageId,
  seedAuthorizationEnvelope,
  setupIsolatedTestDb,
  SHA256_HEX,
} from './_ac-helpers.js';
import { attemptAssignment } from '../src/worker/assignment-service.js';
import { registerProfile, updateProfileStatus } from '../src/worker/profile-registry.js';
import {
  registerProvider,
  unregisterProvider,
} from '../src/worker/provider-registry.js';
import { LocalAgentLoopProvider } from '../src/worker/local-agent-loop-provider.js';
import { isWorkItemComplete } from '../src/workflow/stage-orchestrator.js';
import { queryRun } from '../src/store/db.js';

describe('AC-07 — No Reviewer Available Blocks Work Item', () => {
  let missionId: string;
  let envelopeId: string;
  const provider = new LocalAgentLoopProvider();

  before(async () => {
    await setupIsolatedTestDb('wf-ac07-');
    missionId = makeMissionId();
    envelopeId = makeEnvelopeId();
    seedAuthorizationEnvelope(envelopeId, missionId);
  });

  after(async () => {
    unregisterProvider(provider.providerId);
    await cleanupIsolatedTestDb();
  });

  // Ensure clean provider and profile registry state between sub-cases.
  afterEach(() => {
    unregisterProvider(provider.providerId);
    queryRun('DELETE FROM workflow_agent_profile', []);
  });

  // Helper: build a fresh workpackage and return its CODE_REVIEW stageRun.
  function makeCodeReviewStageRun(): ReturnType<typeof initWorkPackageStages>[number] {
    const wp = makeWorkPackageId();
    const stages = initWorkPackageStages(missionId, wp, envelopeId, 'prof-ac07-wp');
    const codeReview = stages.find((s) => s.stageType === 'CODE_REVIEW');
    assert.ok(codeReview, 'CODE_REVIEW stage must exist in WORKPACKAGE_TEMPLATE');
    return codeReview!;
  }

  it('returns assigned=false when no Review profile is registered', async () => {
    registerProvider(provider); // provider supports CODE_REVIEW, but no profile registered

    const stageRun = makeCodeReviewStageRun();
    const result = await attemptAssignment(stageRun, [], [], envelopeId);

    assert.equal(result.assigned, false);
    assert.ok(result.reason, 'must provide a reason');
    assert.match(result.reason!, /no active profile/i);
  });

  it('returns assigned=false when Review profile is RETIRED (inactive)', async () => {
    registerProvider(provider);
    const reviewProfile = makeProfileV2('Review', 'CODE_REVIEW', 'prof-review-ac07-retired', {
      status: 'RETIRED',
    });
    registerProfile(reviewProfile);

    const stageRun = makeCodeReviewStageRun();
    const result = await attemptAssignment(stageRun, [], [], envelopeId);

    assert.equal(result.assigned, false);
    assert.match(result.reason!, /no active profile/i);
  });

  it('returns assigned=false when Review profile is QUARANTINED (inactive)', async () => {
    registerProvider(provider);
    const reviewProfile = makeProfileV2('Review', 'CODE_REVIEW', 'prof-review-ac07-quar', {
      status: 'QUARANTINED',
    });
    registerProfile(reviewProfile);

    const stageRun = makeCodeReviewStageRun();
    const result = await attemptAssignment(stageRun, [], [], envelopeId);

    assert.equal(result.assigned, false);
    assert.match(result.reason!, /no active profile/i);
  });

  it('returns assigned=false when Review profile exists but no provider supports CODE_REVIEW', async () => {
    // Register an ACTIVE Review profile, but DO NOT register any provider.
    // (provider registry is empty after afterEach cleanup.)
    const reviewProfile = makeProfileV2('Review', 'CODE_REVIEW', 'prof-review-ac07-noprovider');
    registerProfile(reviewProfile);

    const stageRun = makeCodeReviewStageRun();
    const result = await attemptAssignment(stageRun, [], [], envelopeId);

    assert.equal(result.assigned, false);
    assert.ok(result.reason);
    assert.match(result.reason!, /no provider/i);
  });

  it('returns assigned=true (control) when ACTIVE Review profile + supporting provider exist', async () => {
    registerProvider(provider);
    const reviewProfile = makeProfileV2('Review', 'CODE_REVIEW', 'prof-review-ac07-ok');
    registerProfile(reviewProfile);

    const stageRun = makeCodeReviewStageRun();
    const result = await attemptAssignment(stageRun, [], [], envelopeId);

    assert.equal(result.assigned, true, `control case should assign: ${result.reason}`);
    assert.ok(result.profile);
    assert.equal(result.profile!.role, 'Review');
    assert.equal(result.providerId, provider.providerId);
    assert.ok(result.spawnReceipt);
  });

  it('specialty mismatch: Review profile with non-CODE_REVIEW specialty cannot serve CODE_REVIEW', async () => {
    registerProvider(provider);
    // A "Review" role profile whose specialty is SECURITY_REVIEW, not CODE_REVIEW.
    const mismatchedProfile = makeProfileV2('Review', 'SECURITY_REVIEW', 'prof-review-ac07-mismatch');
    registerProfile(mismatchedProfile);

    const stageRun = makeCodeReviewStageRun();
    const result = await attemptAssignment(stageRun, [], [], envelopeId);

    assert.equal(result.assigned, false);
    assert.match(result.reason!, /no active profile/i);
  });

  it('a previously-ACTIVE profile that is later retired can no longer be assigned', async () => {
    registerProvider(provider);
    const reviewProfile = makeProfileV2('Review', 'CODE_REVIEW', 'prof-review-ac07-lifecycle');
    registerProfile(reviewProfile);

    // Initially assignable
    const stageRun1 = makeCodeReviewStageRun();
    const result1 = await attemptAssignment(stageRun1, [], [], envelopeId);
    assert.equal(result1.assigned, true, 'should assign while ACTIVE');

    // Retire the profile
    updateProfileStatus(reviewProfile.profileId, reviewProfile.version, 'RETIRED');

    // Now unassignable
    const stageRun2 = makeCodeReviewStageRun();
    const result2 = await attemptAssignment(stageRun2, [], [], envelopeId);
    assert.equal(result2.assigned, false);
    assert.match(result2.reason!, /no active profile/i);
  });

  it('CODE_REVIEW cannot be staffed → work item is not complete', async () => {
    registerProvider(provider);
    // No Review profile registered → CODE_REVIEW cannot be staffed.

    const wp = makeWorkPackageId();
    const stages = initWorkPackageStages(missionId, wp, envelopeId, 'prof-ac07-incomplete');
    const implementRun = stages.find((s) => s.stageType === 'IMPLEMENT')!;
    const testRun = stages.find((s) => s.stageType === 'TEST')!;

    // Complete IMPLEMENT and TEST successfully (distinct actors)
    const engProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-ac07-inc');
    const engInstance = makeInstanceV2(engProfile.profileId, 'actor-eng-ac07-inc', envelopeId);
    completeStageSuccessfully(implementRun, engInstance, engProfile, envelopeId);

    const testProfile = makeProfileV2('Test', 'TEST', 'prof-test-ac07-inc');
    const testInstance = makeInstanceV2(testProfile.profileId, 'actor-test-ac07-inc', envelopeId, {
      sessionId: 'session-test-ac07-inc',
    });
    completeStageSuccessfully(testRun, testInstance, testProfile, envelopeId, [engInstance], [engProfile]);

    // CODE_REVIEW is now ready but cannot be staffed (no Review profile)
    const codeReviewRun = stages.find((s) => s.stageType === 'CODE_REVIEW')!;
    const assignResult = await attemptAssignment(codeReviewRun, [engInstance, testInstance], [engProfile, testProfile], envelopeId);
    assert.equal(assignResult.assigned, false, 'CODE_REVIEW must not be assignable without a Review profile');

    // Work item cannot be complete because CODE_REVIEW (and downstream stages) are unfinished
    assert.equal(isWorkItemComplete(missionId, 'workpackage', wp), false);
  });
});
