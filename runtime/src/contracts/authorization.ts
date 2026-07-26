import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { awknIdSchema } from './ids.js';
import { JsonValueSchema } from './json-value.js';
import { RiskLevelSchema } from './goal.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const AuthorizationRecordSchema = z.object({
  schema: z.literal('awkn-authorization-token/v1'),
  authorizationId: awknIdSchema('auth'),
  tokenHash: z.string().regex(SHA256_HEX_PATTERN),
  actor: ActorRefSchema,
  executionId: awknIdSchema('exec'),
  allowedToolIds: z.array(z.string().min(1)).min(1),
  allowedOperations: z.array(z.string().min(1)).min(1),
  targetConstraints: z.record(JsonValueSchema),
  riskCeiling: RiskLevelSchema,
  maxUses: z.number().int().positive(),
  usedCount: z.number().int().nonnegative(),
  status: z.enum(['PENDING', 'ACTIVE', 'CONSUMED', 'REVOKED', 'EXPIRED']),
  issuedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
  revokedAt: UtcTimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.usedCount > value.maxUses) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['usedCount'],
      message: 'usedCount cannot exceed maxUses',
    });
  }
  if (value.expiresAt <= value.issuedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'expiresAt must be after issuedAt',
    });
  }
  if (value.status === 'REVOKED' && value.revokedAt === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revokedAt'],
      message: 'revokedAt is required when status is REVOKED',
    });
  }
  if (value.status !== 'REVOKED' && value.revokedAt !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revokedAt'],
      message: 'revokedAt is only valid when status is REVOKED',
    });
  }
  if (value.status === 'CONSUMED' && value.usedCount !== value.maxUses) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['usedCount'],
      message: 'CONSUMED authorization must use its full allowance',
    });
  }
});

export type AuthorizationRecord = z.infer<typeof AuthorizationRecordSchema>;
