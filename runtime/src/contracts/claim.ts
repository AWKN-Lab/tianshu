import { z } from 'zod';
import { stableHash } from './canonical-json.js';
import { awknIdSchema } from './ids.js';
import { SourceRefSchema } from './sources.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const ClaimTypeSchema = z.enum([
  'fact',
  'preference',
  'decision',
  'goal',
  'constraint',
  'hypothesis',
  'recommendation',
  'prediction',
  'observation',
]);

export function claimContentHash(content: string): string {
  return stableHash('awkn-claim-content/v1', content);
}

export const ClaimSchema = z.object({
  schema: z.literal('awkn-claim/v3'),
  claimId: awknIdSchema('clm'),
  content: z.string().min(1),
  contentHash: z.string().regex(SHA256_HEX_PATTERN),
  originator: z.enum(['human', 'assistant', 'system', 'external']),
  speaker: z.enum(['human', 'assistant', 'system', 'tool']),
  claimType: ClaimTypeSchema,
  epistemicStatus: z.enum([
    'proposed',
    'asserted',
    'derived',
    'observed',
    'disputed',
    'superseded',
    'expired',
  ]),
  confirmationLevel: z.enum(['none', 'direction', 'option', 'field']),
  sourceRefs: z.array(SourceRefSchema).min(1),
  derivedFrom: z.array(awknIdSchema('clm')),
  authority: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  sensitivityClass: z.string().min(1),
  validFrom: UtcTimestampSchema.optional(),
  validUntil: UtcTimestampSchema.optional(),
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.contentHash !== claimContentHash(value.content)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contentHash'],
      message: 'contentHash does not match canonical claim content',
    });
  }
  if (value.validFrom !== undefined && value.validUntil !== undefined && value.validUntil < value.validFrom) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validUntil'],
      message: 'validUntil cannot precede validFrom',
    });
  }
  if (value.derivedFrom.includes(value.claimId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['derivedFrom'],
      message: 'claim cannot derive from itself',
    });
  }
  if (new Set(value.derivedFrom).size !== value.derivedFrom.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['derivedFrom'],
      message: 'derivedFrom cannot contain duplicate claims',
    });
  }
  if (value.epistemicStatus === 'derived' && value.derivedFrom.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['derivedFrom'],
      message: 'derived claims require at least one parent claim',
    });
  }
  if (value.epistemicStatus === 'observed') {
    const sourceKinds = new Set(value.sourceRefs.map((source) => source.sourceKind));
    const hasObservationSource = sourceKinds.has('tool_observation') || sourceKinds.has('tianshu_runtime_state');
    if ((value.speaker !== 'tool' && value.originator !== 'system') || !hasObservationSource) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['epistemicStatus'],
        message: 'observed claims require a tool speaker or system originator and an observation source',
      });
    }
  }
  if (value.originator === 'human' && value.speaker !== 'human') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['speaker'],
      message: 'human-originated claims require a human speaker',
    });
  }
});

export type Claim = z.infer<typeof ClaimSchema>;
