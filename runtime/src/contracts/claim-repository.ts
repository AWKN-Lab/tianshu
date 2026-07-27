import { z } from 'zod';
import { ClaimEpistemicStatusSchema, ClaimSchema } from './claim.js';
import { awknIdSchema } from './ids.js';
import { SafeNonNegativeIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

export const ClaimLedgerRecordSchema = z.object({
  schema: z.literal('awkn-claim-ledger-record/v1'),
  claim: ClaimSchema,
  revision: SafeNonNegativeIntegerSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.updatedAt < value.createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt cannot precede createdAt',
    });
  }
});
export type ClaimLedgerRecord = z.infer<typeof ClaimLedgerRecordSchema>;

export const AppendClaimCommandSchema = z.object({
  schema: z.literal('awkn-append-claim-command/v1'),
  claim: ClaimSchema,
  eventId: awknIdSchema('evt'),
  idempotencyKey: z.string().min(1),
  occurredAt: UtcTimestampSchema,
}).strict();
export type AppendClaimCommand = z.infer<typeof AppendClaimCommandSchema>;

export const ClaimStatusTransitionCommandSchema = z.object({
  claimId: awknIdSchema('clm'),
  eventId: awknIdSchema('evt'),
  expectedRevision: SafeNonNegativeIntegerSchema,
  toStatus: z.enum(['asserted', 'disputed', 'superseded', 'expired']),
  reasonCode: z.string().min(1),
}).strict();
export type ClaimStatusTransitionCommand = z.infer<typeof ClaimStatusTransitionCommandSchema>;

export const ApplyClaimTransitionsCommandSchema = z.object({
  schema: z.literal('awkn-apply-claim-transitions-command/v1'),
  transitions: z.array(ClaimStatusTransitionCommandSchema).min(1),
  idempotencyKey: z.string().min(1),
  occurredAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  const claimIds = value.transitions.map((transition) => transition.claimId);
  if (new Set(claimIds).size !== claimIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transitions'],
      message: 'transition batch cannot contain duplicate claimId',
    });
  }
  const eventIds = value.transitions.map((transition) => transition.eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transitions'],
      message: 'transition batch cannot contain duplicate eventId',
    });
  }
});
export type ApplyClaimTransitionsCommand = z.infer<typeof ApplyClaimTransitionsCommandSchema>;

const ClaimLedgerEventBaseSchema = z.object({
  schema: z.literal('awkn-claim-ledger-event/v1'),
  eventId: awknIdSchema('evt'),
  claimId: awknIdSchema('clm'),
  revision: SafeNonNegativeIntegerSchema,
  idempotencyKey: z.string().min(1),
  occurredAt: UtcTimestampSchema,
}).strict();

export const ClaimAppendedEventSchema = ClaimLedgerEventBaseSchema.extend({
  eventType: z.literal('CLAIM_APPENDED'),
  claim: ClaimSchema,
}).strict();
export type ClaimAppendedEvent = z.infer<typeof ClaimAppendedEventSchema>;

export const ClaimStatusChangedEventSchema = ClaimLedgerEventBaseSchema.extend({
  eventType: z.literal('CLAIM_STATUS_CHANGED'),
  fromStatus: ClaimEpistemicStatusSchema,
  toStatus: ClaimEpistemicStatusSchema,
  reasonCode: z.string().min(1),
}).strict();
export type ClaimStatusChangedEvent = z.infer<typeof ClaimStatusChangedEventSchema>;

export const ClaimLedgerEventSchema = z.discriminatedUnion('eventType', [
  ClaimAppendedEventSchema,
  ClaimStatusChangedEventSchema,
]);
export type ClaimLedgerEvent = z.infer<typeof ClaimLedgerEventSchema>;

export const ClaimRepositoryQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  statuses: z.array(ClaimEpistemicStatusSchema),
}).strict();
export type ClaimRepositoryQuery = z.infer<typeof ClaimRepositoryQuerySchema>;
