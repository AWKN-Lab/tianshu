import {
  LoopEligibilityDecisionSchema,
  LoopEligibilityInputSchema,
  LoopEligibilityReceiptPayloadSchema,
  type LoopEligibilityDecision,
  type LoopEligibilityInput,
  type LoopEligibilityReceiptPayload,
} from '../../contracts/public.js';

function reasonCodes(input: LoopEligibilityInput): string[] {
  const reasons = new Set<string>();
  const level = input.intent.executionLevel;

  if (level === 'L0' || level === 'L1') reasons.add('LOOP_NOT_REQUIRED');
  if (input.intent.clarificationDecision === 'ASK_USER') reasons.add('INTENT_REQUIRES_CLARIFICATION');
  if (input.clarityScore < 0.5) reasons.add('CLARITY_BELOW_THRESHOLD');
  if (input.unresolvedHighImpactFields.length > 0) reasons.add('HIGH_IMPACT_FIELDS_UNRESOLVED');
  if (input.evidenceAvailability <= 0) reasons.add('EVIDENCE_UNAVAILABLE');
  if (input.stopConditionDeterminism <= 0) reasons.add('STOP_CONDITION_NOT_DETERMINISTIC');
  if (input.requiresTools && input.toolCoverage <= 0) reasons.add('TOOL_COVERAGE_UNAVAILABLE');
  if (reasons.size === 0) reasons.add('LOOP_REQUIREMENTS_SATISFIED');

  return [...reasons].sort();
}

export function evaluateLoopEligibility(value: LoopEligibilityInput): LoopEligibilityDecision {
  const input = LoopEligibilityInputSchema.parse(value);
  const targetLevel = input.intent.executionLevel;
  const reasons = reasonCodes(input);

  if (targetLevel === 'L0' || targetLevel === 'L1') {
    return LoopEligibilityDecisionSchema.parse({
      schema: 'awkn-loop-eligibility/v1',
      intentId: input.intent.intentId,
      eligible: false,
      targetLevel,
      clarityScore: input.clarityScore,
      evidenceAvailability: input.evidenceAvailability,
      toolCoverage: input.toolCoverage,
      stopConditionDeterminism: input.stopConditionDeterminism,
      unresolvedHighImpactFields: input.unresolvedHighImpactFields,
      decision: 'HUMAN_LED',
      reasonCodes: reasons,
    });
  }

  if (
    input.intent.clarificationDecision === 'ASK_USER'
    || input.clarityScore < 0.5
    || input.unresolvedHighImpactFields.length > 0
  ) {
    return LoopEligibilityDecisionSchema.parse({
      schema: 'awkn-loop-eligibility/v1',
      intentId: input.intent.intentId,
      eligible: false,
      targetLevel,
      clarityScore: input.clarityScore,
      evidenceAvailability: input.evidenceAvailability,
      toolCoverage: input.toolCoverage,
      stopConditionDeterminism: input.stopConditionDeterminism,
      unresolvedHighImpactFields: input.unresolvedHighImpactFields,
      decision: 'ASK_USER',
      reasonCodes: reasons,
    });
  }

  if (
    input.evidenceAvailability <= 0
    || input.stopConditionDeterminism <= 0
    || (input.requiresTools && input.toolCoverage <= 0)
  ) {
    return LoopEligibilityDecisionSchema.parse({
      schema: 'awkn-loop-eligibility/v1',
      intentId: input.intent.intentId,
      eligible: false,
      targetLevel,
      clarityScore: input.clarityScore,
      evidenceAvailability: input.evidenceAvailability,
      toolCoverage: input.toolCoverage,
      stopConditionDeterminism: input.stopConditionDeterminism,
      unresolvedHighImpactFields: input.unresolvedHighImpactFields,
      decision: 'FREEZE_PLAN',
      reasonCodes: reasons,
    });
  }

  return LoopEligibilityDecisionSchema.parse({
    schema: 'awkn-loop-eligibility/v1',
    intentId: input.intent.intentId,
    eligible: true,
    targetLevel,
    clarityScore: input.clarityScore,
    evidenceAvailability: input.evidenceAvailability,
    toolCoverage: input.toolCoverage,
    stopConditionDeterminism: input.stopConditionDeterminism,
    unresolvedHighImpactFields: [],
    decision: 'RUN',
    reasonCodes: reasons,
  });
}

export function buildLoopEligibilityReceiptPayload(
  decision: LoopEligibilityDecision,
  evaluatedAt: string,
): LoopEligibilityReceiptPayload {
  const value = LoopEligibilityDecisionSchema.parse(decision);
  return LoopEligibilityReceiptPayloadSchema.parse({
    schema: 'awkn-loop-eligibility-receipt/v1',
    intentId: value.intentId,
    targetLevel: value.targetLevel,
    eligible: value.eligible,
    decision: value.decision,
    reasonCodes: value.reasonCodes,
    evaluatedAt,
  });
}
