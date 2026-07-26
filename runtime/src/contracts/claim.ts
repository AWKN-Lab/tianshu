import { z } from 'zod';
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
  sourceRefs: z.array(SourceRefSchema),
  derivedFrom: z.array(awknIdSchema('clm')),
  authority: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  sensitivityClass: z.string().min(1),
  validFrom: UtcTimestampSchema.optional(),
  validUntil: UtcTimestampSchema.optional(),
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
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
  if (value.epistemicStatus === 'observed' && value.speaker !== 'tool' && value.originator !== 'system') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['epistemicStatus'],
      message: 'observed claims require a tool speaker or system originator',
    });
  }
});

export type Claim = z.infer<typeof ClaimSchema>;
