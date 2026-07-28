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
  const verifierIds = value.verifiedBy.map((actor) => actor.actorId);
  if (new Set(verifierIds).size !== verifierIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verifiedBy'],
      message: 'verifiedBy cannot contain duplicate actors',
    });
  }

  if (value.type === 'model_statement' && value.level > 1) {
    const independentVerifiers = value.verifiedBy.filter((actor) => actor.actorId !== value.producer.actorId);
    if (independentVerifiers.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['level'],
        message: 'model statements above evidence level 1 require an independent verifier',
      });
    }
  }
});

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
