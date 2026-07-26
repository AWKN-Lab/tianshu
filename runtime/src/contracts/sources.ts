import { z } from 'zod';
import { awknIdSchema } from './ids.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const SourceKindSchema = z.enum([
  'current_human_message',
  'historical_human_message',
  'assistant_message',
  'conversation_summary',
  'tianshu_runtime_state',
  'tianshu_repository_file',
  'memory_os_claim',
  'tool_observation',
  'external_repository_file',
  'external_document',
  'web_source',
]);

export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceRefSchema = z.object({
  schema: z.literal('awkn-source-ref/v1'),
  sourceKind: SourceKindSchema,
  sourceId: z.string().min(1),
  uri: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  contentHash: z.string().regex(SHA256_HEX_PATTERN).optional(),
  observedAt: UtcTimestampSchema.optional(),
  publishedAt: UtcTimestampSchema.optional(),
  accessReceiptId: awknIdSchema('rcpt').optional(),
}).strict();

export type SourceRef = z.infer<typeof SourceRefSchema>;

export const FreshnessContractSchema = z.object({
  schema: z.literal('awkn-freshness-contract/v1'),
  class: z.enum(['STATIC', 'SLOW_CHANGING', 'TIME_SENSITIVE', 'REAL_TIME']),
  observedAt: UtcTimestampSchema,
  sourcePublishedAt: UtcTimestampSchema.optional(),
  validUntil: UtcTimestampSchema.optional(),
  refreshPolicy: z.enum(['none', 'before_use', 'before_decision', 'always']),
  sourceAuthority: z.string().min(1),
  conflictStatus: z.enum(['none', 'suspected', 'confirmed']),
}).strict();

export type FreshnessContract = z.infer<typeof FreshnessContractSchema>;
