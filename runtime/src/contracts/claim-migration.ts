import { z } from 'zod';
import { ClaimSchema, ClaimTypeSchema, claimContentHash, type Claim } from './claim.js';
import { awknIdSchema } from './ids.js';
import { SourceRefSchema } from './sources.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const ClaimV2Schema = z.object({
  schema: z.literal('awkn-claim/v2'),
  claimId: awknIdSchema('clm'),
  content: z.string().min(1),
  contentHash: z.string().regex(SHA256_HEX_PATTERN),
  originator: z.enum(['human', 'assistant', 'system', 'external']),
  speaker: z.enum(['human', 'assistant', 'system', 'tool']),
  claimType: ClaimTypeSchema,
  epistemicStatus: z.enum([
    'proposed',
    'asserted',
    'confirmed',
    'derived',
    'disputed',
    'superseded',
    'expired',
  ]),
  confirmationScope: z.enum(['none', 'direction', 'option', 'field_level']),
  sourceRefs: z.array(SourceRefSchema).min(1),
  derivedFrom: z.array(awknIdSchema('clm')),
  authority: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  sensitivityClass: z.string().min(1),
  validFrom: UtcTimestampSchema.optional(),
  validUntil: UtcTimestampSchema.optional(),
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
}).strict();

export type ClaimV2 = z.infer<typeof ClaimV2Schema>;

const confirmationLevelMap: Record<ClaimV2['confirmationScope'], Claim['confirmationLevel']> = {
  none: 'none',
  direction: 'direction',
  option: 'option',
  field_level: 'field',
};

export function migrateClaimV2ToV3(input: unknown): Claim {
  const claim = ClaimV2Schema.parse(input);
  return ClaimSchema.parse({
    schema: 'awkn-claim/v3',
    claimId: claim.claimId,
    content: claim.content,
    contentHash: claimContentHash(claim.content),
    originator: claim.originator,
    speaker: claim.speaker,
    claimType: claim.claimType,
    epistemicStatus: claim.epistemicStatus === 'confirmed' ? 'asserted' : claim.epistemicStatus,
    confirmationLevel: confirmationLevelMap[claim.confirmationScope],
    sourceRefs: claim.sourceRefs,
    derivedFrom: claim.derivedFrom,
    authority: claim.authority,
    confidence: claim.confidence,
    sensitivityClass: claim.sensitivityClass,
    ...(claim.validFrom === undefined ? {} : { validFrom: claim.validFrom }),
    ...(claim.validUntil === undefined ? {} : { validUntil: claim.validUntil }),
    ...(claim.projectId === undefined ? {} : { projectId: claim.projectId }),
    ...(claim.userId === undefined ? {} : { userId: claim.userId }),
  });
}
