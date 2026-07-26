import { z } from 'zod';
import { ActorRefSchema, ObjectRefSchema } from './actors.js';
import { stableHash } from './canonical-json.js';
import { awknIdSchema } from './ids.js';
import { JsonValueSchema, type JsonValue } from './json-value.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const RECEIPT_TYPE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export const ReceiptTypeSchema = z.enum([
  'INPUT',
  'INTENT',
  'CONTEXT',
  'POLICY',
  'SKILL',
  'MODEL_ROUTE',
  'TOOL_AUTHORIZATION',
  'TOOL_EXECUTION',
  'GATE',
  'DELIVERY',
  'OUTCOME',
  'MEMORY_WRITE',
  'EVOLUTION',
  'CYCLE',
  'SHADOW_DIFF',
]);

export type ReceiptType = z.infer<typeof ReceiptTypeSchema>;

const ReceiptEnvelopeBaseShape = {
  schema: z.literal('awkn-receipt-envelope/v1'),
  receiptId: awknIdSchema('rcpt'),
  payloadSchema: z.string().regex(/^awkn-[a-z0-9-]+\/v[1-9][0-9]*$/),
  executionId: awknIdSchema('exec'),
  traceId: awknIdSchema('tr'),
  runId: awknIdSchema('run').optional(),
  stepId: awknIdSchema('step').optional(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  producer: ActorRefSchema,
  status: z.enum(['SUCCESS', 'FAILURE', 'PARTIAL', 'UNKNOWN']),
  payload: JsonValueSchema,
  payloadHash: z.string().regex(SHA256_HEX_PATTERN),
  artifactRefs: z.array(ObjectRefSchema),
  createdAt: UtcTimestampSchema,
} as const;

/** Active-processing schema. Unknown receipt types are rejected here. */
export const ReceiptEnvelopeSchema = z.object({
  ...ReceiptEnvelopeBaseShape,
  receiptType: ReceiptTypeSchema,
}).strict();

export type ReceiptEnvelope = z.infer<typeof ReceiptEnvelopeSchema>;

/**
 * Persistence/replay schema. It preserves future receipt types so an older
 * runtime can retain, hash and forward them without pretending to understand
 * their payload semantics.
 */
export const StoredReceiptEnvelopeSchema = z.object({
  ...ReceiptEnvelopeBaseShape,
  receiptType: z.string().regex(RECEIPT_TYPE_PATTERN),
}).strict();

export type StoredReceiptEnvelope = z.infer<typeof StoredReceiptEnvelopeSchema>;

export function isKnownReceiptType(value: string): value is ReceiptType {
  return ReceiptTypeSchema.safeParse(value).success;
}

export function receiptPayloadHash(payloadSchema: string, payload: JsonValue): string {
  return stableHash(payloadSchema, payload);
}

export function validateReceiptPayloadHash(
  receipt: Pick<StoredReceiptEnvelope, 'payloadSchema' | 'payload' | 'payloadHash'>,
): boolean {
  return receipt.payloadHash === receiptPayloadHash(receipt.payloadSchema, receipt.payload);
}
