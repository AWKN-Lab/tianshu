import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { awknIdSchema } from './ids.js';
import { FreshnessContractSchema, SourceRefSchema } from './sources.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const EvidenceRecordSchema = z.object({
  schema: z.literal('awkn-evidence/v2'),
  evidenceId: awknIdSchema('ev'),
  executionId: awknIdSchema('exec'),
  traceId: awknIdSchema('tr'),
  runId: awknIdSchema('run').optional(),
  stepId: awknIdSchema('step').optional(),
  claimIds: z.array(awknIdSchema('clm')),
  type: z.enum([
    'model_statement',
    'tool_output',
    'test_result',
    'artifact',
    'external_state',
    'human_confirmation',
  ]),
  level: z.number().int().min(0).max(5),
  contentHash: z.string().regex(SHA256_HEX_PATTERN),
  sourceRef: SourceRefSchema,
  observedAt: UtcTimestampSchema,
  freshness: FreshnessContractSchema.optional(),
  producer: ActorRefSchema,
  verifiedBy: z.array(ActorRefSchema),
}).strict().superRefine((value, context) => {
  if (value.type === 'model_statement' && value.level > 1 && value.verifiedBy.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['level'],
      message: 'model statements above evidence level 1 require an independent verifier',
    });
  }
});

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const EvidenceDeltaSchema = z.object({
  schema: z.literal('awkn-evidence-delta/v1'),
  cycleId: z.string().min(1),
  components: z.object({
    acceptanceProgress: z.number().min(0).max(1),
    uncertaintyReduction: z.number().min(0).max(1),
    newVerifiedEvidence: z.number().min(0).max(1),
    strategyElimination: z.number().min(0).max(1),
    riskReduction: z.number().min(0).max(1),
    regression: z.number().min(0).max(1),
  }).strict(),
  deltaScore: z.number().min(-1).max(1),
  gainType: z.enum([
    'progress',
    'root_cause',
    'constraint_discovery',
    'strategy_elimination',
    'none',
    'regression',
  ]),
  calculatorVersion: z.string().min(1),
}).strict();

export type EvidenceDelta = z.infer<typeof EvidenceDeltaSchema>;
