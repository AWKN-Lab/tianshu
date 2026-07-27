import { z } from 'zod';
import { awknIdSchema } from './ids.js';
import { SafeNonNegativeIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ScoreSchema = z.number().min(0).max(1);

export const ExecutionLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);
export type ExecutionLevel = z.infer<typeof ExecutionLevelSchema>;

export const TimeDependencySchema = z.enum(['none', 'deadline', 'scheduled', 'condition_watch']);
export type TimeDependency = z.infer<typeof TimeDependencySchema>;

export const ClarificationDecisionSchema = z.enum([
  'ASK_USER',
  'CONTINUE_WITH_EXPLICIT_ASSUMPTION',
  'CONTINUE',
]);
export type ClarificationDecision = z.infer<typeof ClarificationDecisionSchema>;

export const TaskProfileIdSchema = z.enum([
  'analysis',
  'research',
  'engineering',
  'repository_review',
  'document_creation',
  'automation',
  'scheduled_check',
  'multi_agent_orchestration',
]);
export type TaskProfileId = z.infer<typeof TaskProfileIdSchema>;

export const IntentOperationSchema = z.enum([
  'READ',
  'ANALYZE',
  'WRITE',
  'SEND',
  'DELETE',
  'SCHEDULE',
  'MONITOR',
  'ORCHESTRATE',
]);
export type IntentOperation = z.infer<typeof IntentOperationSchema>;

export const MandatoryClarificationReasonSchema = z.enum([
  'RECIPIENT_REQUIRED',
  'AMOUNT_REQUIRED',
  'PRODUCTION_TARGET_REQUIRED',
  'AMBIGUOUS_RESOURCE',
  'MUTUALLY_EXCLUSIVE_INTENT',
  'AUTHORIZATION_SCOPE_REQUIRED',
  'TIME_OR_CONDITION_REQUIRED',
  'GOAL_BOUNDARY_REQUIRED',
  'ACCEPTANCE_CRITERIA_REQUIRED',
]);
export type MandatoryClarificationReason = z.infer<typeof MandatoryClarificationReasonSchema>;

export const MissingFieldSchema = z.object({
  fieldId: z.string().min(1),
  description: z.string().min(1),
  answerImpact: ScoreSchema,
  uncertaintyReduction: ScoreSchema,
  safetyImpact: ScoreSchema,
  irreversibility: ScoreSchema,
  userEffort: ScoreSchema,
  mandatoryReason: MandatoryClarificationReasonSchema.optional(),
}).strict();
export type MissingField = z.infer<typeof MissingFieldSchema>;

export const IntentAssumptionSchema = z.object({
  fieldId: z.string().min(1),
  description: z.string().min(1),
  confidence: ScoreSchema,
}).strict();
export type IntentAssumption = z.infer<typeof IntentAssumptionSchema>;

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) result.add(value);
    seen.add(value);
  }
  return [...result].sort();
}

function rejectDuplicates(
  context: z.RefinementCtx,
  path: (string | number)[],
  label: string,
  values: readonly string[],
): void {
  const found = duplicates(values);
  if (found.length === 0) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `duplicate ${label}: ${found.join(', ')}`,
  });
}

export const IntentRouterInputSchema = z.object({
  schema: z.literal('awkn-intent-router-input/v1'),
  inputId: awknIdSchema('in'),
  sourceHash: z.string().regex(SHA256_HEX_PATTERN),
  primaryIntent: z.string().min(1),
  secondaryIntents: z.array(z.string().min(1)),
  requestedOutcome: z.string().min(1),
  deliverableTypes: z.array(z.string().min(1)),
  taskKind: TaskProfileIdSchema,
  operations: z.array(IntentOperationSchema).min(1),
  toolCountHint: SafeNonNegativeIntegerSchema,
  dependencyCount: SafeNonNegativeIntegerSchema,
  iterative: z.boolean(),
  deterministicAcceptance: z.boolean(),
  multiAgent: z.boolean(),
  externalSideEffects: z.boolean(),
  timeDependency: TimeDependencySchema,
  confidence: ScoreSchema,
  knownFields: z.array(z.string().min(1)),
  missingFields: z.array(MissingFieldSchema),
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  rejectDuplicates(context, ['secondaryIntents'], 'secondary intent', value.secondaryIntents);
  rejectDuplicates(context, ['deliverableTypes'], 'deliverable type', value.deliverableTypes);
  rejectDuplicates(context, ['operations'], 'operation', value.operations);
  rejectDuplicates(context, ['knownFields'], 'known field', value.knownFields);
  rejectDuplicates(context, ['missingFields'], 'missing field', value.missingFields.map((field) => field.fieldId));

  const known = new Set(value.knownFields);
  const overlap = value.missingFields.map((field) => field.fieldId).filter((fieldId) => known.has(fieldId));
  if (overlap.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['missingFields'],
      message: `field cannot be both known and missing: ${[...new Set(overlap)].join(', ')}`,
    });
  }

  if (value.timeDependency !== 'none' && !value.operations.some((operation) =>
    operation === 'SCHEDULE' || operation === 'MONITOR')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operations'],
      message: 'time-dependent intents require SCHEDULE or MONITOR operation',
    });
  }

  if (value.multiAgent && !value.operations.includes('ORCHESTRATE')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operations'],
      message: 'multi-agent intents require ORCHESTRATE operation',
    });
  }
});
export type IntentRouterInput = z.infer<typeof IntentRouterInputSchema>;

export const IntentDecisionSchema = z.object({
  schema: z.literal('awkn-intent-decision/v1'),
  intentId: awknIdSchema('intent'),
  inputId: awknIdSchema('in'),
  executionLevel: ExecutionLevelSchema,
  primaryIntent: z.string().min(1),
  secondaryIntents: z.array(z.string().min(1)),
  requestedOutcome: z.string().min(1),
  deliverableTypes: z.array(z.string().min(1)),
  externalSideEffects: z.boolean(),
  timeDependency: TimeDependencySchema,
  taskProfile: TaskProfileIdSchema,
  confidence: ScoreSchema,
  assumptions: z.array(IntentAssumptionSchema),
  missingFields: z.array(MissingFieldSchema),
  clarificationDecision: ClarificationDecisionSchema,
  clarificationValue: ScoreSchema,
  goalRequired: z.boolean(),
  persistentRunRequired: z.boolean(),
  reasonCodes: z.array(z.string().min(1)).min(1),
  routerVersion: z.literal('awkn-intent-router/v1'),
  routedAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  rejectDuplicates(context, ['reasonCodes'], 'reason code', value.reasonCodes);
  rejectDuplicates(context, ['assumptions'], 'assumption field', value.assumptions.map((item) => item.fieldId));

  const persistentLevel = value.executionLevel === 'L2'
    || value.executionLevel === 'L3'
    || value.executionLevel === 'L4';
  if (value.persistentRunRequired !== persistentLevel) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['persistentRunRequired'],
      message: 'persistentRunRequired must match L2-L4 execution levels',
    });
  }
  if (value.goalRequired !== persistentLevel) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['goalRequired'],
      message: 'goalRequired must match L2-L4 execution levels',
    });
  }
  if (value.clarificationDecision === 'CONTINUE_WITH_EXPLICIT_ASSUMPTION' && value.assumptions.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assumptions'],
      message: 'explicit-assumption continuation requires at least one assumption',
    });
  }
  if (value.clarificationDecision === 'ASK_USER' && value.missingFields.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['missingFields'],
      message: 'ASK_USER requires at least one missing field',
    });
  }
});
export type IntentDecision = z.infer<typeof IntentDecisionSchema>;

export const IntentReceiptPayloadSchema = z.object({
  schema: z.literal('awkn-intent-receipt/v1'),
  intentId: awknIdSchema('intent'),
  inputId: awknIdSchema('in'),
  level: ExecutionLevelSchema,
  taskProfile: TaskProfileIdSchema,
  externalSideEffects: z.boolean(),
  clarification: ClarificationDecisionSchema,
  clarificationValue: ScoreSchema,
  goalRequired: z.boolean(),
  reasonCodes: z.array(z.string().min(1)).min(1),
  routerVersion: z.literal('awkn-intent-router/v1'),
  createdAt: UtcTimestampSchema,
}).strict();
export type IntentReceiptPayload = z.infer<typeof IntentReceiptPayloadSchema>;
