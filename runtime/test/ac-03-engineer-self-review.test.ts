/**
 * AC-03 — Engineer Cannot Self-Review (Separation Policy v2 Step 4)
 *
 * 验收标准：同一 actor（或同一 session）不可同时承担 Engineer 与 Review 角色，
 * 因 INCOMPATIBLE_PAIRS_V2 含 ['Engineer', 'Review']。
 * 分离策略须在 step 4 拒绝并报告冲突角色与 actor。
 *
 * 对应源码: src/governor/separation-policy-v2.ts (step 4), contracts/workflow-v2.ts
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import {
  cleanupIsolatedTestDb,
  makeEnvelopeId,
  makeInstanceV2,
  makeMissionId,
  makeProfileV2,
  seedAuthorizationEnvelope,
  setupIsolatedTestDb,
  SHA256_HEX,
} from './_ac-helpers.js';
import { enforceSeparationV2, isIncompatiblePairV2 } from '../src/governor/separation-policy-v2.js';

describe('AC-03 — Engineer Cannot Self-Review (Step 4)', () => {
  let envelopeId: string;

  before(async () => {
    await setupIsolatedTestDb('wf-ac03-');
    const missionId = makeMissionId();
    envelopeId = makeEnvelopeId();
    seedAuthorizationEnvelope(envelopeId, missionId);
  });

  after(async () => {
    await cleanupIsolatedTestDb();
  });

  it('Engineer↔Review is in INCOMPATIBLE_PAIRS_V2 (bidirectional)', () => {
    assert.ok(isIncompatiblePairV2('Engineer', 'Review'));
    assert.ok(isIncompatiblePairV2('Review', 'Engineer')); // bidirectional
  });

  it('denies same actor assuming Engineer then Review (same actorId)', () => {
    const engineerProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-self');
    const reviewProfile = makeProfileV2('Review', 'CODE_REVIEW', 'prof-review-self');

    // Same actorId, different sessions (step 5 would pass; step 4 must catch)
    const priorInstance = makeInstanceV2(engineerProfile.profileId, 'actor-self', envelopeId, {
      sessionId: 'session-prior-eng',
    });
    const currentInstance = makeInstanceV2(reviewProfile.profileId, 'actor-self', envelopeId, {
      sessionId: 'session-current-review', // different session → step 5 passes
    });

    const result = enforceSeparationV2({
      currentProfile: reviewProfile,
      currentInstance,
      priorInstances: [priorInstance],
      priorProfiles: [engineerProfile],
      authorizationEnvelopeId: envelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: SHA256_HEX,
      stageFrozenHash: SHA256_HEX,
      availableBudget: 1000,
      availableConcurrency: 1,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.step, 4);
    assert.ok(result.reason?.includes('incompatible'), `reason: ${result.reason}`);
    assert.equal(result.conflictingActorId, 'actor-self');
    assert.equal(result.conflictingRole, 'Engineer');
  });

  it('denies same actor assuming Review then Engineer (reverse order)', () => {
    const reviewProfile = makeProfileV2('Review', 'CODE_REVIEW', 'prof-review-first');
    const engineerProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-after');

    const priorInstance = makeInstanceV2(reviewProfile.profileId, 'actor-rev-eng', envelopeId, {
      sessionId: 'session-prior-review',
    });
    const currentInstance = makeInstanceV2(engineerProfile.profileId, 'actor-rev-eng', envelopeId, {
      sessionId: 'session-current-eng',
    });

    const result = enforceSeparationV2({
      currentProfile: engineerProfile,
      currentInstance,
      priorInstances: [priorInstance],
      priorProfiles: [reviewProfile],
      authorizationEnvelopeId: envelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: SHA256_HEX,
      stageFrozenHash: SHA256_HEX,
      availableBudget: 1000,
      availableConcurrency: 1,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.step, 4);
    assert.equal(result.conflictingRole, 'Review');
  });

  it('denies same session even with different actorIds (session sharing caught at step 4 or 5)', () => {
    const engineerProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-sess');
    const reviewProfile = makeProfileV2('Review', 'CODE_REVIEW', 'prof-review-sess');

    const priorInstance = makeInstanceV2(engineerProfile.profileId, 'actor-eng-sess', envelopeId, {
      sessionId: 'shared-session-ac03',
    });
    const currentInstance = makeInstanceV2(reviewProfile.profileId, 'actor-review-sess', envelopeId, {
      sessionId: 'shared-session-ac03', // same session, different actor
    });

    const result = enforceSeparationV2({
      currentProfile: reviewProfile,
      currentInstance,
      priorInstances: [priorInstance],
      priorProfiles: [engineerProfile],
      authorizationEnvelopeId: envelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: SHA256_HEX,
      stageFrozenHash: SHA256_HEX,
      availableBudget: 1000,
      availableConcurrency: 1,
    });

    // Step 4 catches first (incompatible pair + same session); step 5 would also catch
    assert.equal(result.allowed, false);
    assert.ok(result.step === 4 || result.step === 5);
  });

  it('allows different actors with different sessions for Engineer then Review', () => {
    const engineerProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-allow');
    const reviewProfile = makeProfileV2('Review', 'CODE_REVIEW', 'prof-review-allow');

    const priorInstance = makeInstanceV2(engineerProfile.profileId, 'actor-eng-distinct', envelopeId);
    const currentInstance = makeInstanceV2(reviewProfile.profileId, 'actor-review-distinct', envelopeId);
    // Different actorId + different sessionId → separation passes

    const result = enforceSeparationV2({
      currentProfile: reviewProfile,
      currentInstance,
      priorInstances: [priorInstance],
      priorProfiles: [engineerProfile],
      authorizationEnvelopeId: envelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: SHA256_HEX,
      stageFrozenHash: SHA256_HEX,
      availableBudget: 1000,
      availableConcurrency: 1,
    });

    assert.equal(result.allowed, true);
  });

  it('also blocks Engineer↔Test (another incompatible pair, same actor)', () => {
    const engineerProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-test');
    const testProfile = makeProfileV2('Test', 'TEST', 'prof-test-eng');

    const priorInstance = makeInstanceV2(engineerProfile.profileId, 'actor-eng-test', envelopeId, {
      sessionId: 'session-eng-test-prior',
    });
    const currentInstance = makeInstanceV2(testProfile.profileId, 'actor-eng-test', envelopeId, {
      sessionId: 'session-eng-test-current',
    });

    const result = enforceSeparationV2({
      currentProfile: testProfile,
      currentInstance,
      priorInstances: [priorInstance],
      priorProfiles: [engineerProfile],
      authorizationEnvelopeId: envelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: SHA256_HEX,
      stageFrozenHash: SHA256_HEX,
      availableBudget: 1000,
      availableConcurrency: 1,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.step, 4);
  });

  it('also blocks Engineer↔Git (cannot self-commit)', () => {
    const engineerProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-git');
    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE', 'prof-git-eng');

    const priorInstance = makeInstanceV2(engineerProfile.profileId, 'actor-self-git', envelopeId, {
      sessionId: 'session-prior-git',
    });
    const currentInstance = makeInstanceV2(gitProfile.profileId, 'actor-self-git', envelopeId, {
      sessionId: 'session-current-git',
    });

    const result = enforceSeparationV2({
      currentProfile: gitProfile,
      currentInstance,
      priorInstances: [priorInstance],
      priorProfiles: [engineerProfile],
      authorizationEnvelopeId: envelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: SHA256_HEX,
      stageFrozenHash: SHA256_HEX,
      availableBudget: 1000,
      availableConcurrency: 1,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.step, 4);
  });
});
