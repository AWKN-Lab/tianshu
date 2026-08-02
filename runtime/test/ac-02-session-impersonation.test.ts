/**
 * AC-02 — Session Impersonation Denied (Separation Policy v2 Step 5)
 *
 * 验收标准：两个 actor 共享同一 sessionId 时，无论角色是否相容，
 * 分离策略必须在 step 5 拒绝（session 不可与任何前置实例共享）。
 *
 * 对应源码: src/governor/separation-policy-v2.ts (step 5)
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
import { enforceSeparationV2 } from '../src/governor/separation-policy-v2.js';

describe('AC-02 — Session Impersonation Denied (Step 5)', () => {
  let envelopeId: string;

  before(async () => {
    await setupIsolatedTestDb('wf-ac02-');
    const missionId = makeMissionId();
    envelopeId = makeEnvelopeId();
    seedAuthorizationEnvelope(envelopeId, missionId);
  });

  after(async () => {
    await cleanupIsolatedTestDb();
  });

  it('denies when two actors share the same sessionId (different actorIds, compatible roles)', () => {
    // Two different actors (different actorId) but SAME sessionId → impersonation
    // Use compatible roles (Product↔Architect) so step 4 passes and step 5 catches session sharing
    const productProfile = makeProfileV2('Product', 'PRODUCT_AUTHOR', 'prof-prod-ac02');
    const archProfile = makeProfileV2('Architect', 'ARCHITECTURE_AUTHOR', 'prof-arch-ac02');

    const priorInstance = makeInstanceV2(
      productProfile.profileId,
      'actor-prod-prior',
      envelopeId,
    );
    const currentInstance = makeInstanceV2(
      archProfile.profileId,
      'actor-arch-current',
      envelopeId,
      { sessionId: priorInstance.sessionId }, // SAME session → impersonation
    );

    const result = enforceSeparationV2({
      currentProfile: archProfile,
      currentInstance,
      priorInstances: [priorInstance],
      priorProfiles: [productProfile],
      authorizationEnvelopeId: envelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: SHA256_HEX,
      stageFrozenHash: SHA256_HEX,
      availableBudget: 1000,
      availableConcurrency: 1,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.step, 5);
    assert.ok(result.reason?.includes('session'), `reason should mention session: ${result.reason}`);
    assert.equal(result.conflictingActorId, 'actor-prod-prior');
  });

  it('denies session sharing even when roles are identical (same role, different actors)', () => {
    const profile1 = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-same-role-1');
    const profile2 = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-same-role-2');

    const priorInstance = makeInstanceV2(profile1.profileId, 'actor-eng-1', envelopeId);
    const currentInstance = makeInstanceV2(
      profile2.profileId,
      'actor-eng-2',
      envelopeId,
      { sessionId: priorInstance.sessionId },
    );

    const result = enforceSeparationV2({
      currentProfile: profile2,
      currentInstance,
      priorInstances: [priorInstance],
      priorProfiles: [profile1],
      authorizationEnvelopeId: envelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: SHA256_HEX,
      stageFrozenHash: SHA256_HEX,
      availableBudget: 1000,
      availableConcurrency: 1,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.step, 5);
  });

  it('allows when actors have different sessions (no impersonation)', () => {
    const engineerProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-ok');
    const testProfile = makeProfileV2('Test', 'TEST', 'prof-test-ok');

    const priorInstance = makeInstanceV2(engineerProfile.profileId, 'actor-eng-ok', envelopeId);
    const currentInstance = makeInstanceV2(testProfile.profileId, 'actor-test-ok', envelopeId);
    // Default makeInstanceV2 generates unique sessionId per actorId → no sharing

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

    assert.equal(result.allowed, true);
  });

  it('denies when session shared with second prior actor (multi-prior)', () => {
    // Use compatible roles so step 4 passes and step 5 catches session sharing
    const engProfile = makeProfileV2('Engineer', 'IMPLEMENT', 'prof-eng-multi');
    const prodProfile = makeProfileV2('Product', 'PRODUCT_AUTHOR', 'prof-prod-multi');
    const archProfile = makeProfileV2('Architect', 'ARCHITECTURE_AUTHOR', 'prof-arch-multi');

    const prior1 = makeInstanceV2(engProfile.profileId, 'actor-eng-multi', envelopeId);
    const prior2 = makeInstanceV2(prodProfile.profileId, 'actor-prod-multi', envelopeId);
    // Current shares session with prior2 (Product) — not prior1
    // Engineer↔Architect and Product↔Architect are both compatible pairs
    const current = makeInstanceV2(
      archProfile.profileId,
      'actor-arch-multi',
      envelopeId,
      { sessionId: prior2.sessionId },
    );

    const result = enforceSeparationV2({
      currentProfile: archProfile,
      currentInstance: current,
      priorInstances: [prior1, prior2],
      priorProfiles: [engProfile, prodProfile],
      authorizationEnvelopeId: envelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: SHA256_HEX,
      stageFrozenHash: SHA256_HEX,
      availableBudget: 1000,
      availableConcurrency: 1,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.step, 5);
    assert.equal(result.conflictingActorId, 'actor-prod-multi');
  });

  it('reports the impersonated prior actor id in denial', () => {
    const priorProfile = makeProfileV2('Planner', 'PLAN_AUTHOR', 'prof-plan-imp');
    const currentProfile = makeProfileV2('Architect', 'ARCHITECTURE_AUTHOR', 'prof-arch-imp');

    const priorInstance = makeInstanceV2(priorProfile.profileId, 'actor-victim', envelopeId);
    const currentInstance = makeInstanceV2(
      currentProfile.profileId,
      'actor-impersonator',
      envelopeId,
      { sessionId: priorInstance.sessionId },
    );

    const result = enforceSeparationV2({
      currentProfile,
      currentInstance,
      priorInstances: [priorInstance],
      priorProfiles: [priorProfile],
      authorizationEnvelopeId: envelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: SHA256_HEX,
      stageFrozenHash: SHA256_HEX,
      availableBudget: 1000,
      availableConcurrency: 1,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.conflictingActorId, 'actor-victim');
    assert.equal(result.conflictingRole, 'Planner');
  });
});
