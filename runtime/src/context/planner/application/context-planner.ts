import {
  ContextManifestSchema,
  ContextPlannerInputSchema,
  contextManifestHash,
  type ContextCandidate,
  type ContextConflict,
  type ContextItemDecision,
  type ContextManifest,
  type ContextPlannerInput,
  type ContextReasonCode,
  type ContextSection,
  type ContextSectionAllocation,
} from '../../../contracts/public.js';
import { contextUtilityScore } from '../domain/context-utility.js';

const SECTION_ORDER: readonly ContextSection[] = [
  'CORE_GOAL',
  'POLICY_SYSTEM',
  'HIGH_IMPACT_CLAIM',
  'KNOWLEDGE',
  'TOOL_SKILL',
];

const SECTION_RATIO: Record<ContextSection, number> = {
  CORE_GOAL: 0.20,
  POLICY_SYSTEM: 0.20,
  HIGH_IMPACT_CLAIM: 0.25,
  KNOWLEDGE: 0.20,
  TOOL_SKILL: 0.10,
};

interface EvaluatedCandidate {
  candidate: ContextCandidate;
  utilityScore: number;
  exclusionReasons: ContextReasonCode[];
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function hardFilterReasons(candidate: ContextCandidate, allowStale: boolean): ContextReasonCode[] {
  const reasons: ContextReasonCode[] = [];
  if (candidate.permission === 'DENY') reasons.push('PERMISSION_DENIED');
  if (candidate.permission === 'UNKNOWN') reasons.push('PERMISSION_UNKNOWN');
  if (!candidate.sensitivityAllowed) reasons.push('SENSITIVITY_BLOCKED');
  if (candidate.freshnessDecision === 'EXPIRED') reasons.push('FRESHNESS_EXPIRED');
  if (candidate.freshnessDecision === 'UNKNOWN') reasons.push('FRESHNESS_UNKNOWN');
  if (candidate.freshnessDecision === 'STALE' && !allowStale) reasons.push('STALE_NOT_ALLOWED');
  if (candidate.conflictRisk === 'HIGH') reasons.push('HIGH_IMPACT_CONFLICT');
  if (candidate.factors.decisionImpact === 0 && !candidate.required) reasons.push('NO_DECISION_IMPACT');
  return uniqueSorted(reasons);
}

function decision(
  item: EvaluatedCandidate,
  status: ContextItemDecision['status'],
  reasonCodes: ContextReasonCode[],
): ContextItemDecision {
  const candidate = item.candidate;
  return {
    itemId: candidate.itemId,
    itemType: candidate.itemType,
    section: candidate.section,
    ref: candidate.ref,
    ...(candidate.claimId === undefined ? {} : { claimId: candidate.claimId }),
    status,
    utilityScore: item.utilityScore,
    tokenCount: candidate.tokenCount,
    reasonCodes: uniqueSorted(reasonCodes),
    freshnessDecision: candidate.freshnessDecision,
    authority: candidate.factors.sourceTrust,
    sensitivityRisk: candidate.factors.sensitivityRisk,
    permission: candidate.permission,
    sourceReceiptIds: [...candidate.sourceReceiptIds].sort(),
    sourceVersion: candidate.sourceVersion,
  };
}

function compareEvaluated(left: EvaluatedCandidate, right: EvaluatedCandidate): number {
  if (left.utilityScore !== right.utilityScore) return right.utilityScore - left.utilityScore;
  const section = SECTION_ORDER.indexOf(left.candidate.section) - SECTION_ORDER.indexOf(right.candidate.section);
  if (section !== 0) return section;
  return left.candidate.itemId.localeCompare(right.candidate.itemId);
}

function sectionTargets(tokenBudget: number, safetyReserveTokens: number): Map<ContextSection, number> {
  const targets = new Map<ContextSection, number>();
  for (const section of SECTION_ORDER) targets.set(section, Math.floor(tokenBudget * SECTION_RATIO[section]));
  const assigned = [...targets.values()].reduce((total, current) => total + current, 0);
  const usable = tokenBudget - safetyReserveTokens;
  targets.set('CORE_GOAL', (targets.get('CORE_GOAL') ?? 0) + Math.max(0, usable - assigned));
  return targets;
}

function contextConflict(candidate: ContextCandidate): ContextConflict | undefined {
  if (candidate.conflictRisk === 'NONE') return undefined;
  return {
    itemId: candidate.itemId,
    ...(candidate.claimId === undefined ? {} : { claimId: candidate.claimId }),
    risk: candidate.conflictRisk,
    resolution: candidate.conflictRisk === 'HIGH' ? 'ASK_USER' : 'CONSERVATIVE_VALUE',
  };
}

export function planContext(value: ContextPlannerInput): ContextManifest {
  const input = ContextPlannerInputSchema.parse(value);
  const safetyReserveTokens = Math.ceil(input.plan.tokenBudget * 0.05);
  const usableBudget = input.plan.tokenBudget - safetyReserveTokens;
  const targets = sectionTargets(input.plan.tokenBudget, safetyReserveTokens);
  const consumed = new Map<ContextSection, number>(SECTION_ORDER.map((section) => [section, 0]));

  const evaluated: EvaluatedCandidate[] = input.candidates.map((candidate) => ({
    candidate,
    utilityScore: contextUtilityScore(candidate.factors),
    exclusionReasons: hardFilterReasons(candidate, input.plan.allowStale),
  }));
  const conflicts = evaluated
    .map((item) => contextConflict(item.candidate))
    .filter((item): item is ContextConflict => item !== undefined)
    .sort((left, right) => left.itemId.localeCompare(right.itemId));

  const requiredUnavailable = evaluated.filter((item) =>
    item.candidate.required && item.exclusionReasons.length > 0);
  const eligibleRequired = evaluated
    .filter((item) => item.candidate.required && item.exclusionReasons.length === 0)
    .sort((left, right) => left.candidate.itemId.localeCompare(right.candidate.itemId));
  const requiredTokens = eligibleRequired.reduce((total, item) => total + item.candidate.tokenCount, 0);

  if (requiredUnavailable.length > 0 || requiredTokens > usableBudget) {
    const blockingReasonCodes: ContextReasonCode[] = [];
    if (requiredUnavailable.length > 0) blockingReasonCodes.push('REQUIRED_ITEM_UNAVAILABLE');
    if (requiredTokens > usableBudget) blockingReasonCodes.push('REQUIRED_ITEM_TOO_LARGE');

    const excluded = evaluated
      .map((item) => decision(
        item,
        'EXCLUDED',
        item.candidate.required
          ? [...item.exclusionReasons, requiredTokens > usableBudget ? 'REQUIRED_ITEM_TOO_LARGE' : 'REQUIRED_ITEM_UNAVAILABLE']
          : item.exclusionReasons.length > 0
            ? item.exclusionReasons
            : ['TOKEN_BUDGET_EXCEEDED'],
      ))
      .sort((left, right) => left.itemId.localeCompare(right.itemId));
    const sectionAllocations: ContextSectionAllocation[] = SECTION_ORDER.map((section) => ({
      section,
      targetTokens: targets.get(section) ?? 0,
      consumedTokens: 0,
    }));
    const sourceReceipts = uniqueSorted(excluded.flatMap((item) => item.sourceReceiptIds));
    const base = {
      schema: 'awkn-context-manifest/v1' as const,
      contextId: input.plan.contextId,
      executionId: input.plan.executionId,
      query: input.plan.query,
      status: 'BLOCKED' as const,
      tokenBudget: input.plan.tokenBudget,
      safetyReserveTokens,
      selectedTokenCount: 0,
      sectionAllocations,
      included: [],
      excluded,
      conflicts,
      sourceReceipts,
      blockingReasonCodes: uniqueSorted(blockingReasonCodes),
      policyVersion: input.plan.policyVersion,
      plannerVersion: input.plan.plannerVersion,
      createdAt: input.plan.createdAt,
    };
    return ContextManifestSchema.parse({ ...base, manifestHash: contextManifestHash(base) });
  }

  const included: ContextItemDecision[] = [];
  const excluded: ContextItemDecision[] = [];
  let selectedTokenCount = 0;

  for (const item of eligibleRequired) {
    included.push(decision(item, 'INCLUDED', ['REQUIRED_ITEM']));
    selectedTokenCount += item.candidate.tokenCount;
    consumed.set(item.candidate.section, (consumed.get(item.candidate.section) ?? 0) + item.candidate.tokenCount);
  }

  for (const item of evaluated.filter((candidate) => candidate.exclusionReasons.length > 0)) {
    excluded.push(decision(item, 'EXCLUDED', item.exclusionReasons));
  }

  const optional = evaluated
    .filter((item) => !item.candidate.required && item.exclusionReasons.length === 0)
    .sort(compareEvaluated);
  const deferred: EvaluatedCandidate[] = [];
  for (const item of optional) {
    const sectionRemaining = Math.max(
      0,
      (targets.get(item.candidate.section) ?? 0) - (consumed.get(item.candidate.section) ?? 0),
    );
    const totalRemaining = usableBudget - selectedTokenCount;
    if (item.candidate.tokenCount <= sectionRemaining && item.candidate.tokenCount <= totalRemaining) {
      included.push(decision(item, 'INCLUDED', ['UTILITY_SELECTED']));
      selectedTokenCount += item.candidate.tokenCount;
      consumed.set(item.candidate.section, (consumed.get(item.candidate.section) ?? 0) + item.candidate.tokenCount);
    } else {
      deferred.push(item);
    }
  }

  for (const item of deferred) {
    if (item.candidate.tokenCount <= usableBudget - selectedTokenCount) {
      included.push(decision(item, 'INCLUDED', ['UTILITY_SELECTED']));
      selectedTokenCount += item.candidate.tokenCount;
      consumed.set(item.candidate.section, (consumed.get(item.candidate.section) ?? 0) + item.candidate.tokenCount);
    } else {
      excluded.push(decision(item, 'EXCLUDED', ['TOKEN_BUDGET_EXCEEDED']));
    }
  }

  included.sort((left, right) => left.itemId.localeCompare(right.itemId));
  excluded.sort((left, right) => left.itemId.localeCompare(right.itemId));
  const sectionAllocations: ContextSectionAllocation[] = SECTION_ORDER.map((section) => ({
    section,
    targetTokens: targets.get(section) ?? 0,
    consumedTokens: consumed.get(section) ?? 0,
  }));
  const sourceReceipts = uniqueSorted([
    ...included.flatMap((item) => item.sourceReceiptIds),
    ...excluded.flatMap((item) => item.sourceReceiptIds),
  ]);
  const base = {
    schema: 'awkn-context-manifest/v1' as const,
    contextId: input.plan.contextId,
    executionId: input.plan.executionId,
    query: input.plan.query,
    status: 'READY' as const,
    tokenBudget: input.plan.tokenBudget,
    safetyReserveTokens,
    selectedTokenCount,
    sectionAllocations,
    included,
    excluded,
    conflicts,
    sourceReceipts,
    blockingReasonCodes: [],
    policyVersion: input.plan.policyVersion,
    plannerVersion: input.plan.plannerVersion,
    createdAt: input.plan.createdAt,
  };
  return ContextManifestSchema.parse({ ...base, manifestHash: contextManifestHash(base) });
}
