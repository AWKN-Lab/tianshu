import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import {
  AcceptanceCriterionSchema,
  AssumptionSchema,
  ConstraintSchema,
  DeliveryExpectationSchema,
  DesiredStateSchema,
  EvidenceSourceSchema,
  GoalBudgetSchema,
  GoalJudgePolicySchema,
  GoalSpecSchema,
  LoopEligibilityDecisionSchema,
  RiskLevelSchema,
  StopPolicySchema,
} from './goal.js';
import { awknIdSchema } from './ids.js';
import { IntentDecisionSchema } from './intent.js';
import { UtcTimestampSchema } from './time.js';

const ScoreSchema = z.number().min(0).max(1);

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

export const LoopEligibilityInputSchema = z.object({
  schema: z.literal('awkn-loop-eligibility-input/v1'),
  intent: IntentDecisionSchema,
  clarityScore: ScoreSchema,
  evidenceAvailability: ScoreSchema,
  toolCoverage: ScoreSchema,
  stopConditionDeterminism: ScoreSchema,
  requiresTools: z.boolean(),
  unresolvedHighImpactFields: z.array(z.string().min(1)),
  evaluatedAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  const repeated = duplicates(value.unresolvedHighImpactFields);
  if (repeated.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unresolvedHighImpactFields'],
      message: `duplicate unresolved field: ${repeated.join(', ')}`,
    });
  }
});
export type LoopEligibilityInput = z.infer<typeof LoopEligibilityInputSchema>;

export const LoopEligibilityReceiptPayloadSchema = z.object({
  schema: z.literal('awkn-loop-eligibility-receipt/v1'),
  intentId: awknIdSchema('intent'),
  targetLevel: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']),
  eligible: z.boolean(),
  decision: z.enum(['RUN', 'ASK_USER', 'FREEZE_PLAN', 'HUMAN_LED']),
  reasonCodes: z.array(z.string().min(1)).min(1),
  evaluatedAt: UtcTimestampSchema,
}).strict();
export type LoopEligibilityReceiptPayload = z.infer<typeof LoopEligibilityReceiptPayloadSchema>;

export const GoalAssumptionBindingSchema = z.object({
  fieldId: z.string().min(1),
  assumptionId: z.string().min(1),
}).strict();
export type GoalAssumptionBinding = z.infer<typeof GoalAssumptionBindingSchema>;

export const GoalFactoryInputSchema = z.object({
  schema: z.literal('awkn-goal-factory-input/v1'),
  intent: IntentDecisionSchema,
  eligibility: LoopEligibilityDecisionSchema,
  goalId: awknIdSchema('goal'),
  title: z.string().min(1),
  desiredState: DesiredStateSchema,
  scope: z.object({
    included: z.array(z.string().min(1)).min(1),
    excluded: z.array(z.string().min(1)),
  }).strict(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  evidenceSources: z.array(EvidenceSourceSchema).min(1),
  constraints: z.array(ConstraintSchema),
  assumptions: z.array(AssumptionSchema),
  assumptionBindings: z.array(GoalAssumptionBindingSchema),
  budget: GoalBudgetSchema,
  stopPolicy: StopPolicySchema,
  judgePolicy: GoalJudgePolicySchema,
  deliveryExpectation: DeliveryExpectationSchema,
  riskLevel: RiskLevelSchema,
  createdBy: ActorRefSchema,
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.intent.intentId !== value.eligibility.intentId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['eligibility', 'intentId'],
      message: 'eligibility intentId must match intent decision',
    });
  }
  if (value.intent.executionLevel !== value.eligibility.targetLevel) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['eligibility', 'targetLevel'],
      message: 'eligibility targetLevel must match intent executionLevel',
    });
  }
  if (!value.intent.goalRequired) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intent', 'goalRequired'],
      message: 'L0/L1 intent cannot create a GoalSpec',
    });
  }
  if (value.intent.clarificationDecision === 'ASK_USER') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intent', 'clarificationDecision'],
      message: 'ASK_USER intent cannot create a GoalSpec',
    });
  }
  if (!value.eligibility.eligible || value.eligibility.decision !== 'RUN') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['eligibility'],
      message: 'GoalSpec requires an eligible RUN decision',
    });
  }

  const assumptionIds = new Set(value.assumptions.map((item) => item.assumptionId));
  const boundFields = new Set<string>();
  const boundAssumptions = new Set<string>();
  for (const [index, binding] of value.assumptionBindings.entries()) {
    if (boundFields.has(binding.fieldId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assumptionBindings', index, 'fieldId'],
        message: `duplicate assumption binding field: ${binding.fieldId}`,
      });
    }
    boundFields.add(binding.fieldId);
    if (boundAssumptions.has(binding.assumptionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assumptionBindings', index, 'assumptionId'],
        message: `duplicate assumption binding target: ${binding.assumptionId}`,
      });
    }
    boundAssumptions.add(binding.assumptionId);
    if (!assumptionIds.has(binding.assumptionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assumptionBindings', index, 'assumptionId'],
        message: `unknown Goal assumption: ${binding.assumptionId}`,
      });
    }
  }

  for (const assumption of value.intent.assumptions) {
    if (!boundFields.has(assumption.fieldId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assumptionBindings'],
        message: `intent assumption is not represented in GoalSpec: ${assumption.fieldId}`,
      });
    }
  }

  const candidateGoal = {
    schema: 'awkn-goal-spec/v3' as const,
    goalId: value.goalId,
    title: value.title,
    desiredState: value.desiredState,
    scope: value.scope,
    acceptanceCriteria: value.acceptanceCriteria,
    evidenceSources: value.evidenceSources,
    constraints: value.constraints,
    assumptions: value.assumptions,
    budget: value.budget,
    stopPolicy: value.stopPolicy,
    judgePolicy: value.judgePolicy,
    deliveryExpectation: value.deliveryExpectation,
    taskProfile: value.intent.taskProfile,
    riskLevel: value.riskLevel,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
  };
  const goalResult = GoalSpecSchema.safeParse(candidateGoal);
  if (!goalResult.success) {
    for (const issue of goalResult.error.issues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['goal', ...issue.path],
        message: issue.message,
      });
    }
  }
});
export type GoalFactoryInput = z.infer<typeof GoalFactoryInputSchema>;
