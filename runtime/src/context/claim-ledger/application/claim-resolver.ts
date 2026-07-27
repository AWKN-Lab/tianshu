import {
  ClaimResolutionInputSchema,
  ClaimResolutionResultSchema,
  type Claim,
  type ClaimAssessment,
  type ClaimExclusion,
  type ClaimResolutionGroup,
  type ClaimResolutionInput,
  type ClaimResolutionResult,
  type ClaimStateTransition,
} from '../../../contracts/public.js';

interface Candidate {
  claim: Claim;
  assessment: ClaimAssessment;
  score: number;
}

const CONFIRMATION_SCORE: Record<Claim['confirmationLevel'], number> = {
  none: 0,
  direction: 0.33,
  option: 0.66,
  field: 1,
};

const FRESHNESS_SCORE: Record<ClaimAssessment['freshness'], number> = {
  VALID: 1,
  STALE: 0.35,
  EXPIRED: 0,
  UNKNOWN: 0,
};

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function candidateScore(candidate: Omit<Candidate, 'score'>): number {
  return roundScore(
    (0.50 * candidate.assessment.assessedAuthority)
      + (0.30 * candidate.claim.confidence)
      + (0.10 * CONFIRMATION_SCORE[candidate.claim.confirmationLevel])
      + (0.10 * FRESHNESS_SCORE[candidate.assessment.freshness]),
  );
}

function compareCandidate(left: Candidate, right: Candidate): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.assessment.freshness !== right.assessment.freshness) {
    return FRESHNESS_SCORE[right.assessment.freshness] - FRESHNESS_SCORE[left.assessment.freshness];
  }
  return left.claim.claimId.localeCompare(right.claim.claimId);
}

function exclusionFor(candidate: Omit<Candidate, 'score'>): ClaimExclusion['reason'] | undefined {
  if (candidate.assessment.permission === 'DENY') return 'PERMISSION_DENIED';
  if (candidate.assessment.permission === 'UNKNOWN') return 'PERMISSION_UNKNOWN';
  if (candidate.assessment.freshness === 'EXPIRED' || candidate.claim.epistemicStatus === 'expired') {
    return 'EXPIRED';
  }
  if (candidate.assessment.freshness === 'UNKNOWN') return 'FRESHNESS_UNKNOWN';
  return undefined;
}

function sortedIds(candidates: readonly Candidate[]): string[] {
  return candidates.map((candidate) => candidate.claim.claimId).sort();
}

function resolveGroup(
  fieldKey: string,
  candidates: readonly Candidate[],
  dominanceThreshold: number,
): {
  group: ClaimResolutionGroup;
  transitions: ClaimStateTransition[];
  usableClaimIds: string[];
} {
  if (candidates.length === 0) {
    return {
      group: {
        fieldKey,
        decision: 'NO_USABLE_CLAIM',
        equivalentClaimIds: [],
        supersededClaimIds: [],
        disputedClaimIds: [],
        reasonCodes: ['ALL_CANDIDATES_EXCLUDED'],
      },
      transitions: [],
      usableClaimIds: [],
    };
  }

  const ranked = [...candidates].sort(compareCandidate);
  if (ranked.length === 1) {
    return {
      group: {
        fieldKey,
        decision: 'SINGLE',
        selectedClaimId: ranked[0].claim.claimId,
        equivalentClaimIds: [],
        supersededClaimIds: [],
        disputedClaimIds: [],
        reasonCodes: ['SINGLE_USABLE_CLAIM'],
      },
      transitions: [],
      usableClaimIds: [ranked[0].claim.claimId],
    };
  }

  const contentHashes = new Set(ranked.map((candidate) => candidate.claim.contentHash));
  if (contentHashes.size === 1) {
    const selected = ranked[0];
    const equivalent = ranked.slice(1);
    return {
      group: {
        fieldKey,
        decision: 'COALESCED',
        selectedClaimId: selected.claim.claimId,
        equivalentClaimIds: sortedIds(equivalent),
        supersededClaimIds: [],
        disputedClaimIds: [],
        reasonCodes: ['EQUIVALENT_CONTENT', 'HIGHEST_SCORE_SELECTED'],
      },
      transitions: [],
      usableClaimIds: [selected.claim.claimId],
    };
  }

  const first = ranked[0];
  const second = ranked[1];
  const firstFreshness = FRESHNESS_SCORE[first.assessment.freshness];
  const secondFreshness = FRESHNESS_SCORE[second.assessment.freshness];
  const dominant = first.score - second.score >= dominanceThreshold
    && firstFreshness >= secondFreshness;

  if (dominant) {
    const superseded = ranked.slice(1);
    return {
      group: {
        fieldKey,
        decision: 'SUPERSEDE',
        selectedClaimId: first.claim.claimId,
        equivalentClaimIds: [],
        supersededClaimIds: sortedIds(superseded),
        disputedClaimIds: [],
        reasonCodes: ['AUTHORITY_FRESHNESS_DOMINANCE', 'SUPERSEDE_LOWER_SCORE'],
      },
      transitions: superseded.map((candidate) => ({
        claimId: candidate.claim.claimId,
        toStatus: 'superseded' as const,
        reasonCode: 'SUPERSEDED_BY_DOMINANT_CLAIM',
      })).sort((left, right) => left.claimId.localeCompare(right.claimId)),
      usableClaimIds: [first.claim.claimId],
    };
  }

  const impactHigh = ranked.some((candidate) => candidate.assessment.impact === 'HIGH');
  const disputedClaimIds = sortedIds(ranked);
  const transitions = disputedClaimIds.map((claimId) => ({
    claimId,
    toStatus: 'disputed' as const,
    reasonCode: impactHigh ? 'HIGH_IMPACT_CONFLICT' : 'LOW_IMPACT_CONFLICT',
  }));

  if (impactHigh) {
    return {
      group: {
        fieldKey,
        decision: 'ASK_USER',
        equivalentClaimIds: [],
        supersededClaimIds: [],
        disputedClaimIds,
        reasonCodes: ['CONFLICT_NOT_DETERMINISTIC', 'HIGH_IMPACT_REQUIRES_CONFIRMATION'],
      },
      transitions,
      usableClaimIds: [],
    };
  }

  const current = ranked.filter((candidate) => candidate.assessment.isCurrent);
  const selectedClaimId = current.length === 1 ? current[0].claim.claimId : undefined;
  return {
    group: {
      fieldKey,
      decision: 'RETAIN_CONFLICT',
      ...(selectedClaimId === undefined ? {} : { selectedClaimId }),
      equivalentClaimIds: [],
      supersededClaimIds: [],
      disputedClaimIds,
      reasonCodes: selectedClaimId === undefined
        ? ['CONFLICT_RETAINED', 'NO_UNIQUE_CURRENT_CLAIM']
        : ['CONFLICT_RETAINED', 'CURRENT_CLAIM_USED_CONSERVATIVELY'],
    },
    transitions,
    usableClaimIds: selectedClaimId === undefined ? [] : [selectedClaimId],
  };
}

export function resolveClaims(value: ClaimResolutionInput): ClaimResolutionResult {
  const input = ClaimResolutionInputSchema.parse(value);
  const assessmentByClaim = new Map(
    input.assessments.map((assessment) => [assessment.claimId, assessment]),
  );
  const exclusions: ClaimExclusion[] = [];
  const usableByField = new Map<string, Candidate[]>();
  const allFields = new Set<string>();

  for (const claim of input.claims) {
    const assessment = assessmentByClaim.get(claim.claimId);
    if (assessment === undefined) continue;
    allFields.add(assessment.fieldKey);
    const candidateBase = { claim, assessment };
    const reason = exclusionFor(candidateBase);
    if (reason !== undefined) {
      exclusions.push({ claimId: claim.claimId, reason });
      continue;
    }
    const candidate: Candidate = {
      ...candidateBase,
      score: candidateScore(candidateBase),
    };
    const group = usableByField.get(assessment.fieldKey) ?? [];
    group.push(candidate);
    usableByField.set(assessment.fieldKey, group);
  }

  const groups: ClaimResolutionGroup[] = [];
  const transitions: ClaimStateTransition[] = [];
  const usableClaimIds: string[] = [];
  for (const fieldKey of [...allFields].sort()) {
    const resolution = resolveGroup(
      fieldKey,
      usableByField.get(fieldKey) ?? [],
      input.dominanceThreshold,
    );
    groups.push(resolution.group);
    transitions.push(...resolution.transitions);
    usableClaimIds.push(...resolution.usableClaimIds);
  }

  return ClaimResolutionResultSchema.parse({
    schema: 'awkn-claim-resolution/v1',
    usableClaimIds: [...new Set(usableClaimIds)].sort(),
    exclusions: exclusions.sort((left, right) => left.claimId.localeCompare(right.claimId)),
    groups,
    transitions: transitions.sort((left, right) => left.claimId.localeCompare(right.claimId)),
    resolverVersion: input.resolverVersion,
    resolvedAt: input.resolvedAt,
  });
}
