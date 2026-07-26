import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { awknIdSchema } from './ids.js';
import { JsonValueSchema } from './json-value.js';
import { RiskLevelSchema } from './goal.js';
import { SafeNonNegativeIntegerSchema, SafePositiveIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

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
  maxUses: SafePositiveIntegerSchema,
  usedCount: SafeNonNegativeIntegerSchema,
  status: z.enum(['PENDING', 'ACTIVE', 'CONSUMED', 'REVOKED', 'EXPIRED']),
  issuedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
  revokedAt: UtcTimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  for (const [path, values] of [
    ['allowedToolIds', value.allowedToolIds],
    ['allowedOperations', value.allowedOperations],
  ] as const) {
    const repeated = duplicates(values);
    if (repeated.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: `duplicate authorization scope values: ${repeated.join(', ')}`,
      });
    }
  }

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
  if (value.status === 'PENDING' && value.usedCount !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['usedCount'],
      message: 'PENDING authorization cannot have used executions',
    });
  }
  if (value.status === 'ACTIVE' && value.usedCount >= value.maxUses) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'authorization at its usage ceiling must be CONSUMED',
    });
  }
  if (value.status === 'CONSUMED' && value.usedCount !== value.maxUses) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['usedCount'],
      message: 'CONSUMED authorization must use its full allowance',
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
  if (value.revokedAt !== undefined && value.revokedAt < value.issuedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revokedAt'],
      message: 'revokedAt cannot precede issuedAt',
    });
  }
});

export type AuthorizationRecord = z.infer<typeof AuthorizationRecordSchema>;
