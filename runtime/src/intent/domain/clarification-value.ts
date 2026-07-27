import type {
  ClarificationDecision,
  MissingField,
} from '../../contracts/public.js';

export interface ClarificationEvaluation {
  decision: ClarificationDecision;
  value: number;
  mandatory: boolean;
  scoredFields: ReadonlyArray<{
    fieldId: string;
    value: number;
  }>;
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function clarificationValue(field: MissingField): number {
  const userEffortInverse = 1 - field.userEffort;
  return roundScore(
    (0.35 * field.answerImpact)
      + (0.25 * field.uncertaintyReduction)
      + (0.20 * field.safetyImpact)
      + (0.10 * field.irreversibility)
      + (0.10 * userEffortInverse),
  );
}

export function evaluateClarification(fields: readonly MissingField[]): ClarificationEvaluation {
  const scoredFields = fields
    .map((field) => ({ fieldId: field.fieldId, value: clarificationValue(field) }))
    .sort((left, right) => left.fieldId.localeCompare(right.fieldId));
  const value = scoredFields.reduce((maximum, field) => Math.max(maximum, field.value), 0);
  const mandatory = fields.some((field) => field.mandatoryReason !== undefined);

  if (mandatory || value >= 0.70) {
    return { decision: 'ASK_USER', value, mandatory, scoredFields };
  }
  if (value >= 0.40) {
    return {
      decision: 'CONTINUE_WITH_EXPLICIT_ASSUMPTION',
      value,
      mandatory,
      scoredFields,
    };
  }
  return { decision: 'CONTINUE', value, mandatory, scoredFields };
}
