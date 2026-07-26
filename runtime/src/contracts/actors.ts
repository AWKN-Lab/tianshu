import { z } from 'zod';
import { SafeNonNegativeIntegerSchema } from './numbers.js';
import { SchemaIdSchema } from './schema-id.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const ActorRefSchema = z.object({
  schema: z.literal('awkn-actor-ref/v1'),
  actorId: z.string().min(1),
  actorType: z.enum(['human', 'assistant', 'system', 'tool', 'service']),
  tenantId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
}).strict();

export type ActorRef = z.infer<typeof ActorRefSchema>;

export const ExecutionScopeSchema = z.object({
  schema: z.literal('awkn-execution-scope/v1'),
  tenantId: z.string().min(1).optional(),
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
}).strict();

export type ExecutionScope = z.infer<typeof ExecutionScopeSchema>;

export const ObjectRefSchema = z.object({
  schema: z.literal('awkn-object-ref/v1'),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  schemaId: SchemaIdSchema,
  contentHash: z.string().regex(SHA256_HEX_PATTERN).optional(),
  revision: SafeNonNegativeIntegerSchema.optional(),
  externalRef: z.string().min(1).optional(),
}).strict();

export type ObjectRef = z.infer<typeof ObjectRefSchema>;
