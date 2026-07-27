import { z } from 'zod';
import { canonicalizeJson, stableHash } from './canonical-json.js';
import {
  ContextItemTypeSchema,
  ContextManifestSchema,
  ContextRenderSourceSchema,
  ContextSectionSchema,
} from './context.js';
import { awknIdSchema } from './ids.js';
import { JsonValueSchema, type JsonValue } from './json-value.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function contextRenderSourceHash(content: JsonValue): string {
  return stableHash('awkn-context-render-source/v1', content);
}

export const ContextRenderInputSchema = z.object({
  schema: z.literal('awkn-context-render-input/v1'),
  renderId: awknIdSchema('rnd'),
  manifest: ContextManifestSchema,
  sources: z.array(ContextRenderSourceSchema),
  binderVersion: z.string().min(1),
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  const sourceIds = value.sources.map((source) => source.itemId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sources'],
      message: 'Context Render sources cannot contain duplicate itemId',
    });
  }
});
export type ContextRenderInput = z.infer<typeof ContextRenderInputSchema>;

export const ContextRenderItemSchema = z.object({
  itemId: z.string().min(1),
  itemType: ContextItemTypeSchema,
  section: ContextSectionSchema,
  content: JsonValueSchema,
  contentHash: z.string().regex(SHA256_HEX_PATTERN),
  sourceReceiptIds: z.array(awknIdSchema('rcpt')),
  sourceVersion: z.string().min(1),
}).strict();
export type ContextRenderItem = z.infer<typeof ContextRenderItemSchema>;

export const ContextRenderSectionSchema = z.object({
  section: ContextSectionSchema,
  items: z.array(ContextRenderItemSchema),
}).strict();
export type ContextRenderSection = z.infer<typeof ContextRenderSectionSchema>;

const ImmutableContextRenderBaseSchema = z.object({
  schema: z.literal('awkn-immutable-context-render/v1'),
  renderId: awknIdSchema('rnd'),
  contextId: awknIdSchema('ctx'),
  executionId: awknIdSchema('exec'),
  manifestHash: z.string().regex(SHA256_HEX_PATTERN),
  sections: z.array(ContextRenderSectionSchema),
  renderedText: z.string().min(1),
  binderVersion: z.string().min(1),
  createdAt: UtcTimestampSchema,
});

export const ImmutableContextRenderSchema = ImmutableContextRenderBaseSchema.extend({
  renderHash: z.string().regex(SHA256_HEX_PATTERN),
}).strict();
export type ImmutableContextRender = z.infer<typeof ImmutableContextRenderSchema>;

export function contextRenderText(sections: readonly ContextRenderSection[]): string {
  return canonicalizeJson({
    schema: 'awkn-context-render-text/v1',
    sections,
  });
}

export function immutableContextRenderHash(
  render: Omit<ImmutableContextRender, 'renderHash'>,
): string {
  return stableHash('awkn-immutable-context-render/v1', render as JsonValue);
}
