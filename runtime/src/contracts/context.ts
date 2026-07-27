import { z } from 'zod';
import { ObjectRefSchema } from './actors.js';
import { stableHash } from './canonical-json.js';
import { FreshnessContractSchema } from './sources.js';
import { awknIdSchema } from './ids.js';
import { JsonValueSchema, type JsonValue } from './json-value.js';
import { SafeNonNegativeIntegerSchema, SafePositiveIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ScoreSchema = z.number().min(0).max(1);
const UtilityScoreSchema = z.number().min(-0.35).max(0.95);

export const ContextSectionSchema = z.enum([
  'CORE_GOAL',
  'POLICY_SYSTEM',
  'HIGH_IMPACT_CLAIM',
  'KNOWLEDGE',
  'TOOL_SKILL',
]);
export type ContextSection = z.infer<typeof ContextSectionSchema>;

export const ContextItemTypeSchema = z.enum([
  'identity',
  'goal',
  'constraint',
  'authorization',
  'policy',
  'claim',
  'document',
  'runtime_state',
  'tool_schema',
  'skill_summary',
  'failure_evidence',
]);
export type ContextItemType = z.infer<typeof ContextItemTypeSchema>;

export const ContextPermissionDecisionSchema = z.enum(['ALLOW', 'DENY', 'UNKNOWN']);
export const ContextFreshnessDecisionSchema = z.enum(['VALID', 'STALE', 'EXPIRED', 'UNKNOWN']);
export const ContextConflictRiskSchema = z.enum(['NONE', 'LOW', 'HIGH']);

export const ContextUtilityFactorsSchema = z.object({
  decisionImpact: ScoreSchema,
  taskRelevance: ScoreSchema,
  sourceTrust: ScoreSchema,
  freshness: ScoreSchema,
  novelty: ScoreSchema,
  userExpectation: ScoreSchema,
  sensitivityRisk: ScoreSchema,
  tokenCost: ScoreSchema,
  contradictionRisk: ScoreSchema,
}).strict();
export type ContextUtilityFactors = z.infer<typeof ContextUtilityFactorsSchema>;

export const ContextCandidateSchema = z.object({
  schema: z.literal('awkn-context-candidate/v1'),
  itemId: z.string().min(1),
  itemType: ContextItemTypeSchema,
  section: ContextSectionSchema,
  ref: ObjectRefSchema,
  claimId: awknIdSchema('clm').optional(),
  tokenCount: SafeNonNegativeIntegerSchema,
  required: z.boolean(),
  permission: ContextPermissionDecisionSchema,
  sensitivityAllowed: z.boolean(),
  freshnessDecision: ContextFreshnessDecisionSchema,
  freshness: FreshnessContractSchema.optional(),
  conflictRisk: ContextConflictRiskSchema,
  factors: ContextUtilityFactorsSchema,
  sourceReceiptIds: z.array(awknIdSchema('rcpt')),
  sourceVersion: z.string().min(1),
}).strict().superRefine((value, context) => {
  if (value.itemType === 'claim' && value.claimId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['claimId'],
      message: 'claim context candidate requires claimId',
    });
  }
  if (new Set(value.sourceReceiptIds).size !== value.sourceReceiptIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceReceiptIds'],
      message: 'sourceReceiptIds cannot contain duplicates',
    });
  }
});
export type ContextCandidate = z.infer<typeof ContextCandidateSchema>;

export const ContextQueryPlanSchema = z.object({
  schema: z.literal('awkn-context-query-plan/v1'),
  contextId: awknIdSchema('ctx'),
  executionId: awknIdSchema('exec'),
  query: z.string().min(1),
  tokenBudget: SafePositiveIntegerSchema,
  allowStale: z.boolean(),
  allowedSensitivityClasses: z.array(z.string().min(1)),
  policyVersion: z.string().min(1),
  plannerVersion: z.string().min(1),
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.allowedSensitivityClasses).size !== value.allowedSensitivityClasses.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allowedSensitivityClasses'],
      message: 'allowedSensitivityClasses cannot contain duplicates',
    });
  }
});
export type ContextQueryPlan = z.infer<typeof ContextQueryPlanSchema>;

export const ContextDecisionStatusSchema = z.enum(['INCLUDED', 'EXCLUDED']);
export const ContextReasonCodeSchema = z.enum([
  'REQUIRED_ITEM',
  'UTILITY_SELECTED',
  'PERMISSION_DENIED',
  'PERMISSION_UNKNOWN',
  'SENSITIVITY_BLOCKED',
  'FRESHNESS_EXPIRED',
  'FRESHNESS_UNKNOWN',
  'STALE_NOT_ALLOWED',
  'HIGH_IMPACT_CONFLICT',
  'NO_DECISION_IMPACT',
  'TOKEN_BUDGET_EXCEEDED',
  'REQUIRED_ITEM_UNAVAILABLE',
  'REQUIRED_ITEM_TOO_LARGE',
]);
export type ContextReasonCode = z.infer<typeof ContextReasonCodeSchema>;

export const ContextItemDecisionSchema = z.object({
  itemId: z.string().min(1),
  itemType: ContextItemTypeSchema,
  section: ContextSectionSchema,
  ref: ObjectRefSchema,
  claimId: awknIdSchema('clm').optional(),
  status: ContextDecisionStatusSchema,
  utilityScore: UtilityScoreSchema,
  tokenCount: SafeNonNegativeIntegerSchema,
  reasonCodes: z.array(ContextReasonCodeSchema).min(1),
  freshnessDecision: ContextFreshnessDecisionSchema,
  authority: ScoreSchema,
  sensitivityRisk: ScoreSchema,
  permission: ContextPermissionDecisionSchema,
  sourceReceiptIds: z.array(awknIdSchema('rcpt')),
  sourceVersion: z.string().min(1),
}).strict();
export type ContextItemDecision = z.infer<typeof ContextItemDecisionSchema>;

export const ContextConflictSchema = z.object({
  itemId: z.string().min(1),
  claimId: awknIdSchema('clm').optional(),
  risk: z.enum(['LOW', 'HIGH']),
  resolution: z.enum(['CONSERVATIVE_VALUE', 'ASK_USER', 'EXCLUDED']),
}).strict();
export type ContextConflict = z.infer<typeof ContextConflictSchema>;

export const ContextSectionAllocationSchema = z.object({
  section: ContextSectionSchema,
  targetTokens: SafeNonNegativeIntegerSchema,
  consumedTokens: SafeNonNegativeIntegerSchema,
}).strict();
export type ContextSectionAllocation = z.infer<typeof ContextSectionAllocationSchema>;

const ContextManifestBaseSchema = z.object({
  schema: z.literal('awkn-context-manifest/v1'),
  contextId: awknIdSchema('ctx'),
  executionId: awknIdSchema('exec'),
  query: z.string().min(1),
  status: z.enum(['READY', 'BLOCKED']),
  tokenBudget: SafePositiveIntegerSchema,
  safetyReserveTokens: SafeNonNegativeIntegerSchema,
  selectedTokenCount: SafeNonNegativeIntegerSchema,
  sectionAllocations: z.array(ContextSectionAllocationSchema),
  included: z.array(ContextItemDecisionSchema),
  excluded: z.array(ContextItemDecisionSchema),
  conflicts: z.array(ContextConflictSchema),
  sourceReceipts: z.array(awknIdSchema('rcpt')),
  blockingReasonCodes: z.array(ContextReasonCodeSchema),
  policyVersion: z.string().min(1),
  plannerVersion: z.string().min(1),
  createdAt: UtcTimestampSchema,
});

export const ContextManifestSchema = ContextManifestBaseSchema.extend({
  manifestHash: z.string().regex(SHA256_HEX_PATTERN),
}).strict().superRefine((value, context) => {
  if (value.selectedTokenCount + value.safetyReserveTokens > value.tokenBudget) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedTokenCount'],
      message: 'selected tokens plus safety reserve exceed token budget',
    });
  }
  const includedTokens = value.included.reduce((total, item) => total + item.tokenCount, 0);
  if (includedTokens !== value.selectedTokenCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedTokenCount'],
      message: 'selectedTokenCount must equal included item token total',
    });
  }
  if (value.status === 'READY' && value.blockingReasonCodes.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['blockingReasonCodes'],
      message: 'READY manifest cannot contain blocking reason codes',
    });
  }
  if (value.status === 'BLOCKED' && value.blockingReasonCodes.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['blockingReasonCodes'],
      message: 'BLOCKED manifest requires blocking reason codes',
    });
  }
});
export type ContextManifest = z.infer<typeof ContextManifestSchema>;

export function contextManifestHash(
  manifest: Omit<ContextManifest, 'manifestHash'>,
): string {
  return stableHash('awkn-context-manifest/v1', manifest as JsonValue);
}

export const ContextPlannerInputSchema = z.object({
  schema: z.literal('awkn-context-planner-input/v1'),
  plan: ContextQueryPlanSchema,
  candidates: z.array(ContextCandidateSchema),
}).strict().superRefine((value, context) => {
  const itemIds = value.candidates.map((candidate) => candidate.itemId);
  if (new Set(itemIds).size !== itemIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidates'],
      message: 'context candidates cannot contain duplicate itemId',
    });
  }
});
export type ContextPlannerInput = z.infer<typeof ContextPlannerInputSchema>;

export const ContextRenderSourceSchema = z.object({
  itemId: z.string().min(1),
  content: JsonValueSchema,
  contentHash: z.string().regex(SHA256_HEX_PATTERN),
}).strict();
export type ContextRenderSource = z.infer<typeof ContextRenderSourceSchema>;
