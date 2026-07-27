import type { ContextUtilityFactors } from '../../../contracts/public.js';

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function contextUtilityScore(factors: ContextUtilityFactors): number {
  return roundScore(
    (0.30 * factors.decisionImpact)
      + (0.20 * factors.taskRelevance)
      + (0.15 * factors.sourceTrust)
      + (0.10 * factors.freshness)
      + (0.10 * factors.novelty)
      + (0.10 * factors.userExpectation)
      - (0.15 * factors.sensitivityRisk)
      - (0.10 * factors.tokenCost)
      - (0.10 * factors.contradictionRisk),
  );
}
