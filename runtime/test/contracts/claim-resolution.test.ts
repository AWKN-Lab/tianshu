import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ClaimResolutionInputSchema,
  ClaimResolutionResultSchema,
  claimContentHash,
  type Claim,
  type ClaimAssessment,
  type ClaimResolutionInput,
} from '../../src/contracts/public.js';
import { resolveClaims } from '../../src/context/public.js';

const id = (digit: string): string => `clm_${digit.repeat(32)}`;
const now = '2026-07-27T04:00:00.000Z';

function claim(
  digit: string,
  content: string,
  overrides: Partial<Claim> = {},
): Claim {
  return {
    schema: 'awkn-claim/v3',
    claimId: id(digit),
    content,
    contentHash: claimContentHash(content),
    originator: 'human',
    speaker: 'human',
    claimType: 'fact',
    epistemicStatus: 'asserted',
    confirmationLevel: 'field',
    sourceRefs: [{
      schema: 'awkn-source-ref/v1',
      sourceKind: 'current_human_message',
      sourceId: `message-${digit}`,
      observedAt: now,
    }],
    derivedFrom: [],
    authority: 0.8,
    confidence: 0.8,
    sensitivityClass: 'internal',
    validFrom: now,
    ...overrides,
  };
}

function assessment(
  claimId: string,
  fieldKey: string,
  overrides: Partial<ClaimAssessment> = {},
): ClaimAssessment {
  return {
    claimId,
    fieldKey,
    impact: 'HIGH',
    permission: 'ALLOW',
    freshness: 'VALID',
    assessedAuthority: 0.8,
    isCurrent: false,
    assessedAt: now,
    ...overrides,
  };
}

function input(
  claims: Claim[],
  assessments: ClaimAssessment[],
  overrides: Partial<ClaimResolutionInput> = {},
): ClaimResolutionInput {
  return {
    schema: 'awkn-claim-resolution-input/v1',
    claims,
    assessments,
    dominanceThreshold: 0.2,
    resolverVersion: 'claim-resolver/v1',
    resolvedAt: now,
    ...overrides,
  };
}

describe('Claim intake gates', () => {
  it('excludes denied, unknown-permission, expired and unknown-freshness claims', () => {
    const claims = [
      claim('1', 'denied'),
      claim('2', 'permission unknown'),
      claim('3', 'expired'),
      claim('4', 'freshness unknown'),
    ];
    const assessments = [
      assessment(claims[0].claimId, 'field-a', { permission: 'DENY' }),
      assessment(claims[1].claimId, 'field-b', { permission: 'UNKNOWN' }),
      assessment(claims[2].claimId, 'field-c', { freshness: 'EXPIRED' }),
      assessment(claims[3].claimId, 'field-d', { freshness: 'UNKNOWN' }),
    ];
    const result = resolveClaims(input(claims, assessments));
    assert.equal(ClaimResolutionResultSchema.safeParse(result).success, true);
    assert.deepEqual(result.usableClaimIds, []);
    assert.deepEqual(result.exclusions.map((item) => item.reason), [
      'PERMISSION_DENIED',
      'PERMISSION_UNKNOWN',
      'EXPIRED',
      'FRESHNESS_UNKNOWN',
    ]);
    assert.equal(result.groups.every((group) => group.decision === 'NO_USABLE_CLAIM'), true);
  });
});

describe('Claim conflict resolution', () => {
  it('coalesces identical content and selects the strongest representative', () => {
    const first = claim('1', 'Budget is 200000');
    const second = claim('2', 'Budget is 200000', { confidence: 0.6, confirmationLevel: 'option' });
    const result = resolveClaims(input(
      [first, second],
      [
        assessment(first.claimId, 'budget', { assessedAuthority: 0.95 }),
        assessment(second.claimId, 'budget', { assessedAuthority: 0.6 }),
      ],
    ));
    assert.equal(result.groups[0].decision, 'COALESCED');
    assert.equal(result.groups[0].selectedClaimId, first.claimId);
    assert.deepEqual(result.groups[0].equivalentClaimIds, [second.claimId]);
    assert.deepEqual(result.transitions, []);
  });

  it('supersedes conflicting claims when authority and freshness dominance is sufficient', () => {
    const current = claim('1', 'Launch in September', { confidence: 1 });
    const old = claim('2', 'Launch in October', { confidence: 0.4, confirmationLevel: 'none' });
    const result = resolveClaims(input(
      [current, old],
      [
        assessment(current.claimId, 'launch-date', { assessedAuthority: 1 }),
        assessment(old.claimId, 'launch-date', { assessedAuthority: 0.2, freshness: 'STALE' }),
      ],
    ));
    assert.equal(result.groups[0].decision, 'SUPERSEDE');
    assert.equal(result.groups[0].selectedClaimId, current.claimId);
    assert.deepEqual(result.groups[0].supersededClaimIds, [old.claimId]);
    assert.deepEqual(result.transitions, [{
      claimId: old.claimId,
      toStatus: 'superseded',
      reasonCode: 'SUPERSEDED_BY_DOMINANT_CLAIM',
    }]);
    assert.equal(old.epistemicStatus, 'asserted');
  });

  it('asks the user when a high-impact conflict cannot be resolved deterministically', () => {
    const first = claim('1', 'Deploy to production A');
    const second = claim('2', 'Deploy to production B');
    const result = resolveClaims(input(
      [first, second],
      [
        assessment(first.claimId, 'production-target', { assessedAuthority: 0.8, impact: 'HIGH' }),
        assessment(second.claimId, 'production-target', { assessedAuthority: 0.8, impact: 'HIGH' }),
      ],
    ));
    assert.equal(result.groups[0].decision, 'ASK_USER');
    assert.equal(result.groups[0].selectedClaimId, undefined);
    assert.deepEqual(result.groups[0].disputedClaimIds, [first.claimId, second.claimId]);
    assert.equal(result.transitions.every((item) => item.toStatus === 'disputed'), true);
  });

  it('retains low-impact conflict and uses one current claim conservatively', () => {
    const current = claim('1', 'Use concise formatting');
    const historical = claim('2', 'Use detailed formatting');
    const result = resolveClaims(input(
      [current, historical],
      [
        assessment(current.claimId, 'format-style', {
          assessedAuthority: 0.8,
          impact: 'LOW',
          isCurrent: true,
        }),
        assessment(historical.claimId, 'format-style', {
          assessedAuthority: 0.8,
          impact: 'LOW',
          isCurrent: false,
        }),
      ],
    ));
    assert.equal(result.groups[0].decision, 'RETAIN_CONFLICT');
    assert.equal(result.groups[0].selectedClaimId, current.claimId);
    assert.deepEqual(result.usableClaimIds, [current.claimId]);
  });

  it('does not select a conservative value when multiple claims are marked current', () => {
    const first = claim('1', 'Format A');
    const second = claim('2', 'Format B');
    const result = resolveClaims(input(
      [first, second],
      [
        assessment(first.claimId, 'format-style', { impact: 'LOW', isCurrent: true }),
        assessment(second.claimId, 'format-style', { impact: 'LOW', isCurrent: true }),
      ],
    ));
    assert.equal(result.groups[0].decision, 'RETAIN_CONFLICT');
    assert.equal(result.groups[0].selectedClaimId, undefined);
    assert.deepEqual(result.usableClaimIds, []);
  });
});

describe('Claim resolution contract integrity', () => {
  it('requires one assessment for every claim and rejects unknown assessment claims', () => {
    const first = claim('1', 'A');
    const second = claim('2', 'B');
    assert.equal(ClaimResolutionInputSchema.safeParse(input(
      [first, second],
      [assessment(first.claimId, 'field')],
    )).success, false);

    assert.equal(ClaimResolutionInputSchema.safeParse(input(
      [first],
      [
        assessment(first.claimId, 'field'),
        assessment(second.claimId, 'field'),
      ],
    )).success, false);
  });
});
