import { z } from 'zod';
import { ObjectRefSchema } from './actors.js';
import { awknIdSchema } from './ids.js';

export const AosErrorCodeSchema = z.enum([
  'AOS_CONTRACT_SCHEMA_UNKNOWN',
  'AOS_CONTRACT_VALIDATION_FAILED',
  'AOS_HASH_CANONICALIZATION_FAILED',
  'AOS_EXECUTION_REVISION_CONFLICT',
  'AOS_EVENT_REVISION_CONFLICT',
  'AOS_GOAL_NOT_ELIGIBLE',
  'AOS_GOAL_EVIDENCE_INSUFFICIENT',
  'AOS_GOAL_CONSTRAINT_FAILED',
  'AOS_POLICY_CONFLICT',
  'AOS_AUTH_REQUIRED',
  'AOS_AUTH_SCOPE_MISMATCH',
  'AOS_AUTH_REVOKED',
  'AOS_AUTH_CONSUMED',
  'AOS_SIDE_EFFECT_UNCERTAIN',
  'AOS_MEMORY_REVISION_CONFLICT',
  'AOS_PROTOCOL_INCOMPATIBLE',
]);

export type AosErrorCode = z.infer<typeof AosErrorCodeSchema>;

export const AosErrorSchema = z.object({
  schema: z.literal('awkn-error/v1'),
  code: AosErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  detailsRef: ObjectRefSchema.optional(),
  receiptId: awknIdSchema('rcpt').optional(),
}).strict();

export type AosErrorRecord = z.infer<typeof AosErrorSchema>;

export class AosContractError extends Error {
  constructor(readonly record: AosErrorRecord) {
    super(record.message);
    this.name = 'AosContractError';
  }
}
