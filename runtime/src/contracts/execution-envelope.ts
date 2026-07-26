import { z } from 'zod';
import { ActorRefSchema, ExecutionScopeSchema, ObjectRefSchema } from './actors.js';
import { awknIdSchema } from './ids.js';
import { SafeNonNegativeIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

export const ExecutionStateSchema = z.enum([
  'RECEIVED',
  'TRUSTED',
  'ROUTED',
  'CONTEXT_READY',
  'COMPILED',
  'AUTHORIZED',
  'RUNNING',
  'DELIVERING',
  'DELIVERED',
  'OUTCOME_PENDING',
  'OUTCOME_RECORDED',
  'CLOSED',
  'BLOCKED',
  'WAITING_USER',
  'WAITING_AUTHORIZATION',
  'RETRYING',
  'DEGRADED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
]);

export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

export const ExecutionEnvelopeSchema = z.object({
  schema: z.literal('awkn-execution-envelope/v1'),
  executionId: awknIdSchema('exec'),
  traceId: awknIdSchema('tr'),
  revision: SafeNonNegativeIntegerSchema,
  actor: ActorRefSchema,
  scope: ExecutionScopeSchema,
  inputRef: ObjectRefSchema,
  intentRef: ObjectRefSchema.optional(),
  goalRef: ObjectRefSchema.optional(),
  contextRef: ObjectRefSchema.optional(),
  policyBundleRef: ObjectRefSchema.optional(),
  skillBundleRef: ObjectRefSchema.optional(),
  brokerPlanRef: ObjectRefSchema.optional(),
  runRefs: z.array(ObjectRefSchema),
  deliveryRefs: z.array(ObjectRefSchema),
  outcomeRef: ObjectRefSchema.optional(),
  memoryDecisionRefs: z.array(ObjectRefSchema),
  evolutionCandidateRefs: z.array(ObjectRefSchema),
  featureFlagsRef: ObjectRefSchema,
  state: ExecutionStateSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  closedAt: UtcTimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.state === 'CLOSED' && value.closedAt === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['closedAt'],
      message: 'closedAt is required when state is CLOSED',
    });
  }
  if (value.state !== 'CLOSED' && value.closedAt !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['closedAt'],
      message: 'closedAt is only valid when state is CLOSED',
    });
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt cannot precede createdAt',
    });
  }
});

export type ExecutionEnvelope = z.infer<typeof ExecutionEnvelopeSchema>;
