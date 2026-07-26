import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { awknIdSchema } from './ids.js';
import { JsonValueSchema } from './json-value.js';
import { UtcTimestampSchema } from './time.js';

export const DomainEventSchema = z.object({
  schema: z.literal('awkn-domain-event/v1'),
  eventId: awknIdSchema('evt'),
  eventType: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/),
  eventVersion: z.number().int().positive(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  aggregateRevision: z.number().int().nonnegative(),
  executionId: awknIdSchema('exec'),
  traceId: awknIdSchema('tr'),
  actor: ActorRefSchema,
  idempotencyKey: z.string().min(1),
  receiptIds: z.array(awknIdSchema('rcpt')),
  payloadSchema: z.string().regex(/^awkn-[a-z0-9-]+\/v[1-9][0-9]*$/),
  payload: JsonValueSchema,
  occurredAt: UtcTimestampSchema,
}).strict();

export type DomainEvent = z.infer<typeof DomainEventSchema>;
