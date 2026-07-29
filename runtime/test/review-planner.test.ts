import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REVIEW_SCOPE_SPEC_SCHEMA,
  stableHash,
  type ActorRef,
  type ReviewScopeSpec,
} from '../src/contracts/public.js';
import { buildReviewPlan, createReviewTarget, ReviewPlanningError } from '../src/review/public.js';

const now = '2026-07-28T08:00:00.000Z';
const actor: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'builder', actorType: 'assistant' };

function scope(root = 'D:\\repo'): ReviewScopeSpec {
  const files = [
    ['src/user.service.ts', 'MODIFIED'],
    ['src/user.test.ts', 'MODIFIED'],
    ['src/routes/user.ts', 'MODIFIED'],
    ['src/auth/policy.ts', 'MODIFIED'],
  ].map(([path, status], index) => ({
    path: path!,
    status: status!,
    insertions: 2,
    deletions: 1,
    diffFingerprint: String(index + 1).repeat(64),
    willReview: true,
    ruleGroupIds: [],
  }));
  return {
    schema: REVIEW_SCOPE_SPEC_SCHEMA,
    provider: 'native-git',
    providerVersion: 'native-git/v1',
    repositoryRoot: root,
    baseRef: '1'.repeat(40),
    headRef: 'WORKTREE',
    mergeBase: '1'.repeat(40),
    diffFingerprint: stableHash('awkn-review-test-scope/v1', files),
    files: files as ReviewScopeSpec['files'],
    ruleGroups: [],
  };
}

describe('review planner', () => {
  it('plans file, test-abuse, cross-file, and spec units', () => {
    const currentScope = scope();
    const target = createReviewTarget(currentScope, {
      mode: 'WORKTREE',
      initiator: actor,
      implementer: actor,
      createdAt: now,
      specRefs: [{
        schema: 'awkn-object-ref/v1',
        objectType: 'spec',
        objectId: 'SPEC-1',
        schemaId: 'awkn-spec/v1',
      }],
    });
    const plan = buildReviewPlan(target, currentScope, now);
    assert.equal(plan.files.length, 4);
    assert.ok(plan.units.some((unit) => unit.type === 'TEST_ABUSE'));
    assert.ok(plan.units.some((unit) => unit.type === 'CROSS_FILE' && unit.purpose.includes('test consistency')));
    assert.ok(plan.units.some((unit) => unit.type === 'CROSS_FILE' && unit.purpose.includes('Permission')));
    assert.ok(plan.units.some((unit) => unit.type === 'SPEC'));
  });

  it('keeps planHash stable across actor/time metadata and binds it to the repository root', () => {
    const leftScope = scope('D:\\left');
    const sameRootScope = { ...scope('D:\\left'), diffFingerprint: leftScope.diffFingerprint };
    const otherRootScope = { ...scope('/srv/right'), diffFingerprint: leftScope.diffFingerprint };
    const leftTarget = createReviewTarget(leftScope, {
      mode: 'WORKTREE', initiator: actor, implementer: actor, createdAt: now,
    });
    const sameRootTarget = createReviewTarget(sameRootScope, {
      mode: 'WORKTREE',
      initiator: { ...actor, actorId: 'other' },
      implementer: { ...actor, actorId: 'other-builder' },
      createdAt: '2026-07-28T09:00:00.000Z',
    });
    const left = buildReviewPlan(leftTarget, leftScope, now);
    const sameRoot = buildReviewPlan(sameRootTarget, sameRootScope, '2026-07-28T10:00:00.000Z');
    const otherRootTarget = createReviewTarget(otherRootScope, {
      mode: 'WORKTREE', initiator: actor, implementer: actor, createdAt: now,
    });
    const otherRoot = buildReviewPlan(otherRootTarget, otherRootScope, now);
    assert.equal(left.planHash, sameRoot.planHash);
    assert.notEqual(left.planHash, otherRoot.planHash);
  });

  it('rejects empty and stale provider scopes', () => {
    const currentScope = scope();
    const target = createReviewTarget(currentScope, {
      mode: 'WORKTREE', initiator: actor, implementer: actor, createdAt: now,
    });
    assert.throws(() => buildReviewPlan(target, { ...currentScope, files: [] }, now), ReviewPlanningError);
    assert.throws(() => buildReviewPlan(target, { ...currentScope, diffFingerprint: 'f'.repeat(64) }, now), ReviewPlanningError);
  });
});
