import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { awknIdSchema } from './ids.js';
import { JsonValueSchema } from './json-value.js';
import { SafeNonNegativeIntegerSchema, SafePositiveIntegerSchema } from './numbers.js';
import { SchemaIdSchema } from './schema-id.js';
import { UtcTimestampSchema } from './time.js';

export const DomainEventSchema = z.object({
  schema: z.literal('awkn-domain-event/v1'),
  eventId: awknIdSchema('evt'),
  eventType: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/),
  eventVersion: SafePositiveIntegerSchema,
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  aggregateRevision: SafeNonNegativeIntegerSchema,
  executionId: awknIdSchema('exec'),
  traceId: awknIdSchema('tr'),
  actor: ActorRefSchema,
  idempotencyKey: z.string().min(1),
  receiptIds: z.array(awknIdSchema('rcpt')),
  payloadSchema: SchemaIdSchema,
  payload: JsonValueSchema,
  occurredAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.receiptIds).size !== value.receiptIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['receiptIds'],
      message: 'receiptIds cannot contain duplicates',
    });
  }
});

export type DomainEvent = z.infer<typeof DomainEventSchema>;
