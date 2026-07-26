import { z } from 'zod';
import { ActorRefSchema, ObjectRefSchema } from './actors.js';
import { awknIdSchema } from './ids.js';
import { JsonValueSchema } from './json-value.js';
import { UtcTimestampSchema } from './time.js';

export const RiskLevelSchema = z.enum(['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);

export const DesiredStateSchema = z.object({
  description: z.string().min(1),
  successSignals: z.array(z.string().min(1)).min(1),
}).strict();

export const AcceptanceCriterionSchema = z.object({
  criterionId: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean(),
  evaluator: z.enum(['deterministic', 'model', 'human', 'external']),
  evidenceSourceIds: z.array(z.string().min(1)),
}).strict();

export const EvidenceSourceSchema = z.object({
  sourceId: z.string().min(1),
  sourceType: z.enum(['test', 'tool', 'artifact', 'external_state', 'human_confirmation', 'model_statement']),
  required: z.boolean(),
  minimumLevel: z.number().int().min(0).max(5),
  freshnessClass: z.enum(['STATIC', 'SLOW_CHANGING', 'TIME_SENSITIVE', 'REAL_TIME']).optional(),
}).strict();

export const ConstraintSchema = z.object({
  constraintId: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(['HARD', 'SOFT']),
  evaluator: z.enum(['deterministic', 'model', 'human', 'external']),
}).strict();

export const AssumptionSchema = z.object({
  assumptionId: z.string().min(1),
  description: z.string().min(1),
  status: z.enum(['UNVERIFIED', 'VERIFIED', 'REJECTED']),
}).strict();

export const GoalBudgetSchema = z.object({
  maxCycles: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
  maxCostMinorUnits: z.number().int().nonnegative().optional(),
}).strict();

export const StopPolicySchema = z.object({
  noGainCycleLimit: z.number().int().positive(),
  onBudgetExceeded: z.enum(['PAUSE', 'FAIL', 'ASK_USER']),
  onBlocked: z.enum(['PAUSE', 'FAIL', 'ASK_USER']),
  onUncertain: z.enum(['CONTINUE', 'PAUSE', 'ASK_USER', 'FAIL']),
}).strict();

export const GoalJudgePolicySchema = z.object({
  judgeVersion: z.string().min(1),
  minimumEvidenceLevel: z.number().int().min(0).max(5),
  requireAllAcceptanceCriteria: z.boolean(),
  requireAllHardConstraints: z.boolean(),
  requiredGateTypes: z.array(z.string().min(1)),
}).strict();

export const DeliveryModeSchema = z.enum([
  'CHAT',
  'FILE',
  'VISUAL',
  'ARTIFACT_APP',
  'CONNECTED_SYSTEM',
  'SCHEDULED_TASK',
]);

export const DeliveryExpectationSchema = z.object({
  modes: z.array(DeliveryModeSchema).min(1),
  primaryMode: DeliveryModeSchema,
  successPredicate: JsonValueSchema,
}).strict();

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

export const GoalSpecSchema = z.object({
  schema: z.literal('awkn-goal-spec/v3'),
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
  budget: GoalBudgetSchema,
  stopPolicy: StopPolicySchema,
  judgePolicy: GoalJudgePolicySchema,
  deliveryExpectation: DeliveryExpectationSchema,
  taskProfile: z.string().min(1),
  riskLevel: RiskLevelSchema,
  createdBy: ActorRefSchema,
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (!value.deliveryExpectation.modes.includes(value.deliveryExpectation.primaryMode)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryExpectation', 'primaryMode'],
      message: 'primaryMode must be included in modes',
    });
  }

  const duplicateChecks: Array<{ path: (string | number)[]; label: string; values: string[] }> = [
    { path: ['scope', 'included'], label: 'included scope', values: value.scope.included },
    { path: ['scope', 'excluded'], label: 'excluded scope', values: value.scope.excluded },
    { path: ['acceptanceCriteria'], label: 'criterionId', values: value.acceptanceCriteria.map((item) => item.criterionId) },
    { path: ['evidenceSources'], label: 'sourceId', values: value.evidenceSources.map((item) => item.sourceId) },
    { path: ['constraints'], label: 'constraintId', values: value.constraints.map((item) => item.constraintId) },
    { path: ['assumptions'], label: 'assumptionId', values: value.assumptions.map((item) => item.assumptionId) },
    { path: ['judgePolicy', 'requiredGateTypes'], label: 'requiredGateTypes', values: value.judgePolicy.requiredGateTypes },
    { path: ['deliveryExpectation', 'modes'], label: 'delivery modes', values: value.deliveryExpectation.modes },
  ];

  for (const check of duplicateChecks) {
    const duplicates = duplicateValues(check.values);
    if (duplicates.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: check.path,
        message: `duplicate ${check.label}: ${duplicates.join(', ')}`,
      });
    }
  }

  const excluded = new Set(value.scope.excluded);
  const overlap = value.scope.included.filter((item) => excluded.has(item));
  if (overlap.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scope'],
      message: `scope cannot be both included and excluded: ${[...new Set(overlap)].join(', ')}`,
    });
  }

  if (!value.evidenceSources.some((source) => source.required)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidenceSources'],
      message: 'at least one required evidence source is required',
    });
  }

  const sourceIds = new Set(value.evidenceSources.map((source) => source.sourceId));
  for (const [criterionIndex, criterion] of value.acceptanceCriteria.entries()) {
    if (criterion.required && criterion.evidenceSourceIds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptanceCriteria', criterionIndex, 'evidenceSourceIds'],
        message: 'required acceptance criteria need at least one evidence source',
      });
    }
    const duplicateSourceIds = duplicateValues(criterion.evidenceSourceIds);
    if (duplicateSourceIds.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptanceCriteria', criterionIndex, 'evidenceSourceIds'],
        message: `duplicate evidence source reference: ${duplicateSourceIds.join(', ')}`,
      });
    }
    for (const sourceId of criterion.evidenceSourceIds) {
      if (!sourceIds.has(sourceId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['acceptanceCriteria', criterionIndex, 'evidenceSourceIds'],
          message: `unknown evidence source: ${sourceId}`,
        });
      }
    }
  }
});

export type GoalSpec = z.infer<typeof GoalSpecSchema>;

export const LoopEligibilityDecisionSchema = z.object({
  schema: z.literal('awkn-loop-eligibility/v1'),
  intentId: z.string().min(1),
  eligible: z.boolean(),
  targetLevel: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']),
  clarityScore: z.number().min(0).max(1),
  evidenceAvailability: z.number().min(0).max(1),
  toolCoverage: z.number().min(0).max(1),
  stopConditionDeterminism: z.number().min(0).max(1),
  unresolvedHighImpactFields: z.array(z.string().min(1)),
  decision: z.enum(['RUN', 'ASK_USER', 'FREEZE_PLAN', 'HUMAN_LED']),
  reasonCodes: z.array(z.string().min(1)),
}).strict().superRefine((value, context) => {
  if (value.eligible && value.decision !== 'RUN') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['decision'],
      message: 'eligible loop decisions must be RUN',
    });
  }
  if (!value.eligible && value.decision === 'RUN') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['decision'],
      message: 'ineligible loop decisions cannot be RUN',
    });
  }
  if (value.eligible && ['L2', 'L3', 'L4'].includes(value.targetLevel)) {
    if (value.unresolvedHighImpactFields.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unresolvedHighImpactFields'],
        message: 'eligible L2-L4 loops cannot retain unresolved high-impact fields',
      });
    }
    if (value.evidenceAvailability <= 0 || value.stopConditionDeterminism <= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eligible'],
        message: 'eligible L2-L4 loops require evidence and deterministic stop conditions',
      });
    }
  }
});

export type LoopEligibilityDecision = z.infer<typeof LoopEligibilityDecisionSchema>;

export const GoalJudgementSchema = z.object({
  schema: z.literal('awkn-goal-judgement/v1'),
  goalId: awknIdSchema('goal'),
  runId: awknIdSchema('run'),
  verdict: z.enum(['ACHIEVED', 'NOT_ACHIEVED', 'BLOCKED', 'UNKNOWN']),
  acceptanceResults: z.array(ObjectRefSchema),
  constraintResults: z.array(ObjectRefSchema),
  gateReceiptIds: z.array(awknIdSchema('rcpt')),
  evidenceIds: z.array(awknIdSchema('ev')),
  deliveryPreconditionResults: z.array(ObjectRefSchema),
  judgeVersion: z.string().min(1),
  judgedAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.verdict === 'ACHIEVED' && value.acceptanceResults.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['acceptanceResults'],
      message: 'ACHIEVED requires acceptance evaluation results',
    });
  }
  if (value.verdict === 'ACHIEVED' && value.evidenceIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidenceIds'],
      message: 'ACHIEVED requires verified evidence',
    });
  }
});

export type GoalJudgement = z.infer<typeof GoalJudgementSchema>;
