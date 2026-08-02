/**
 * AC-04 — TEST Failure Blocks Downstream Stages
 *
 * 验收标准：当 TEST 阶段失败（FAILED）时，依赖它的 CODE_REVIEW（on_pass 边）
 * 不可变为 READY，即 getReadyStages 不返回 CODE_REVIEW。
 * 工作项完成判定（isWorkItemComplete）须返回 false。
 *
 * 对应源码: src/workflow/stage-orchestrator.ts, src/workflow/stage-graph.ts
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
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
import { createAwknId } from '../src/contracts/ids.js';
import {
  completeStage,
  failStage,
  getReadyStages,
  getWorkItemStages,
  initializeStages,
  isWorkItemComplete,
  startStage,
} from '../src/workflow/stage-orchestrator.js';
import { getStageRun } from '../src/workflow/stage-store.js';
import { queryRun } from '../src/store/db.js';

describe('AC-04 — TEST Failure Blocks Downstream', () => {
  let missionId: string;
  let envelopeId: string;

  before(async () => {
    await setupIsolatedTestDb('wf-ac04-');
    missionId = makeMissionId();
    envelopeId = makeEnvelopeId();
    seedAuthorizationEnvelope(envelopeId, missionId);
  });

  after(async () => {
    await cleanupIsolatedTestDb();
  });

  it('TEST FAILED → CODE_REVIEW not ready (on_pass edge unsatisfied)', () => {
    const wp = makeWorkPackageId();
    const stages = initWorkPackageStages(missionId, wp, envelopeId, 'prof-ac04-fail');
    const implementRun = stages.find((s) => s.stageType === 'IMPLEMENT')!;
    const testRun = stages.find((s) => s.stageType === 'TEST')!;

    // Complete IMPLEMENT successfully
    const engProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-ac04-fail');
    const engInstance = makeInstanceV2(engProfile.profileId, 'actor-eng-ac04-fail', envelopeId);
    completeStageSuccessfully(implementRun, engInstance, engProfile, envelopeId);

    // Now TEST should be ready
    const readyAfterImpl = getReadyStages(missionId, 'workpackage', wp);
    assert.equal(readyAfterImpl.length, 1);
    assert.equal(readyAfterImpl[0]!.stageType, 'TEST');

    // Start TEST
    startStage(testRun.stageRunId, 'actor-test-ac04-fail', '2026-12-31T23:59:59.000Z');

    // Fail TEST (attempt 0 < maxAttempts 3 → FAILED, not ROLLED_BACK)
    const testProfile = makeProfileV2('Test', 'TEST', 'prof-test-ac04-fail');
    const testInstance = makeInstanceV2(testProfile.profileId, 'actor-test-ac04-fail', envelopeId);
    const failResult = failStage(
      testRun.stageRunId,
      testInstance,
      testProfile,
      'rcpt-test-fail',
      [],
      [],
      createAwknId('event'),
    );
    assert.equal(failResult.success, true);
    assert.equal(failResult.newState, 'FAILED');

    // Verify TEST is FAILED
    const testFetched = getStageRun(testRun.stageRunId);
    assert.equal(testFetched!.state, 'FAILED');

    // CODE_REVIEW must NOT be ready (on_pass from TEST unsatisfied)
    const readyAfterFail = getReadyStages(missionId, 'workpackage', wp);
    const codeReviewReady = readyAfterFail.find((s) => s.stageType === 'CODE_REVIEW');
    assert.equal(codeReviewReady, undefined, 'CODE_REVIEW must not be ready when TEST failed');

    // Only RETROSPECTIVE-independent or already-ready stages may appear; with FAILED TEST,
    // no new stages should become ready (IMPLEMENT already PASSED, TEST is terminal FAILED)
    // SECURITY_REVIEW depends on CODE_REVIEW; GIT_INTEGRATE depends on SECURITY_REVIEW; etc.
    // So no downstream stage should be ready.
    assert.equal(readyAfterFail.length, 0, 'no downstream stages should be ready after TEST fails');
  });

  it('isWorkItemComplete returns false when TEST is FAILED', () => {
    const wp = makeWorkPackageId();
    const stages = initWorkPackageStages(missionId, wp, envelopeId, 'prof-ac04-incomplete');
    const implementRun = stages.find((s) => s.stageType === 'IMPLEMENT')!;
    const testRun = stages.find((s) => s.stageType === 'TEST')!;

    // Complete IMPLEMENT, fail TEST
    const engProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-inc');
    const engInstance = makeInstanceV2(engProfile.profileId, 'actor-eng-inc', envelopeId);
    completeStageSuccessfully(implementRun, engInstance, engProfile, envelopeId);

    startStage(testRun.stageRunId, 'actor-test-inc', '2026-12-31T23:59:59.000Z');
    const testProfile = makeProfileV2('Test', 'TEST', 'prof-test-inc');
    const testInstance = makeInstanceV2(testProfile.profileId, 'actor-test-inc', envelopeId);
    failStage(
      testRun.stageRunId,
      testInstance,
      testProfile,
      'rcpt-test-inc-fail',
      [],
      [],
      createAwknId('event'),
    );

    assert.equal(isWorkItemComplete(missionId, 'workpackage', wp), false);
  });

  it('TEST PASSED → CODE_REVIEW becomes ready (control: happy path)', () => {
    const wp = makeWorkPackageId();
    const stages = initWorkPackageStages(missionId, wp, envelopeId, 'prof-ac04-ok');
    const implementRun = stages.find((s) => s.stageType === 'IMPLEMENT')!;
    const testRun = stages.find((s) => s.stageType === 'TEST')!;

    // Complete IMPLEMENT
    const engProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-ok');
    const engInstance = makeInstanceV2(engProfile.profileId, 'actor-eng-ok', envelopeId);
    const engPriorInstances = [engInstance];
    const engPriorProfiles = [engProfile];
    completeStageSuccessfully(implementRun, engInstance, engProfile, envelopeId);

    // Complete TEST (with Test actor distinct from Engineer)
    const testProfile = makeProfileV2('Test', 'TEST', 'prof-test-ok');
    const testInstance = makeInstanceV2(testProfile.profileId, 'actor-test-ok', envelopeId, {
      sessionId: 'session-test-ok',
    });
    startStage(testRun.stageRunId, testInstance.actorId, '2026-12-31T23:59:59.000Z');
    completeStageSuccessfully(
      testRun,
      testInstance,
      testProfile,
      envelopeId,
      engPriorInstances,
      engPriorProfiles,
    );

    // CODE_REVIEW should now be ready
    const ready = getReadyStages(missionId, 'workpackage', wp);
    const codeReview = ready.find((s) => s.stageType === 'CODE_REVIEW');
    assert.ok(codeReview, 'CODE_REVIEW should be ready when TEST passed');
  });

  it('TEST ROLLED_BACK (maxAttempts exceeded) also blocks downstream', () => {
    const wp = makeWorkPackageId();
    const stages = initWorkPackageStages(missionId, wp, envelopeId, 'prof-ac04-rb');
    const implementRun = stages.find((s) => s.stageType === 'IMPLEMENT')!;
    const testRun = stages.find((s) => s.stageType === 'TEST')!;

    // Complete IMPLEMENT
    const engProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-rb');
    const engInstance = makeInstanceV2(engProfile.profileId, 'actor-eng-rb', envelopeId);
    completeStageSuccessfully(implementRun, engInstance, engProfile, envelopeId);

    // Fail TEST with attempt already at maxAttempts → ROLLED_BACK (not FAILED)
    startStage(testRun.stageRunId, 'actor-test-rb', '2026-12-31T23:59:59.000Z');
    // Manually set attempt=1 so that attempt(1) >= maxAttempts(1) triggers ROLLED_BACK
    queryRun('UPDATE workflow_stage_run SET attempt = 1 WHERE stage_run_id = ?', [testRun.stageRunId]);
    const testProfile = makeProfileV2('Test', 'TEST', 'prof-test-rb', { maxAttempts: 1 });
    const testInstance = makeInstanceV2(testProfile.profileId, 'actor-test-rb', envelopeId);
    const failResult = failStage(
      testRun.stageRunId,
      testInstance,
      testProfile,
      'rcpt-test-rb',
      [],
      [],
      createAwknId('event'),
    );
    assert.equal(failResult.newState, 'ROLLED_BACK');

    // CODE_REVIEW must not be ready
    const ready = getReadyStages(missionId, 'workpackage', wp);
    assert.equal(ready.find((s) => s.stageType === 'CODE_REVIEW'), undefined);
  });

  it('all work item stages reflect correct state after TEST failure', () => {
    const wp = makeWorkPackageId();
    const stages = initWorkPackageStages(missionId, wp, envelopeId, 'prof-ac04-state');
    const implementRun = stages.find((s) => s.stageType === 'IMPLEMENT')!;
    const testRun = stages.find((s) => s.stageType === 'TEST')!;

    const engProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-state');
    const engInstance = makeInstanceV2(engProfile.profileId, 'actor-eng-state', envelopeId);
    completeStageSuccessfully(implementRun, engInstance, engProfile, envelopeId);

    startStage(testRun.stageRunId, 'actor-test-state', '2026-12-31T23:59:59.000Z');
    const testProfile = makeProfileV2('Test', 'TEST', 'prof-test-state');
    const testInstance = makeInstanceV2(testProfile.profileId, 'actor-test-state', envelopeId);
    failStage(testRun.stageRunId, testInstance, testProfile, 'rcpt-state', [], [], createAwknId('event'));

    const all = getWorkItemStages(missionId, 'workpackage', wp);
    const byType = new Map(all.map((s) => [s.stageType, s.state]));
    assert.equal(byType.get('IMPLEMENT'), 'PASSED');
    assert.equal(byType.get('TEST'), 'FAILED');
    // Downstream stages remain READY (initial state, never started)
    assert.equal(byType.get('CODE_REVIEW'), 'READY');
    assert.equal(byType.get('SECURITY_REVIEW'), 'READY');
    assert.equal(byType.get('GIT_INTEGRATE'), 'READY');
    assert.equal(byType.get('RETROSPECTIVE'), 'READY');
  });
});
