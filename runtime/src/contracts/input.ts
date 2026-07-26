import { z } from 'zod';
import { JsonValueSchema } from './json-value.js';
import { SafeNonNegativeIntegerSchema, SafePositiveIntegerSchema } from './numbers.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const TRUSTED_JSON_PARSER_VERSION = 'awkn-json-parser/v1' as const;

export const TrustedJsonLimitsSchema = z.object({
  maxInputBytes: SafePositiveIntegerSchema,
  maxDepth: SafePositiveIntegerSchema,
  maxNodes: SafePositiveIntegerSchema,
  maxStringLength: SafePositiveIntegerSchema,
}).strict();

export type TrustedJsonLimits = z.infer<typeof TrustedJsonLimitsSchema>;

export const TrustedJsonDiagnosticCodeSchema = z.enum([
  'AOS_INPUT_JSON_INVALID_UTF8',
  'AOS_INPUT_JSON_EMPTY',
  'AOS_INPUT_JSON_SYNTAX',
  'AOS_INPUT_JSON_TRAILING_CONTENT',
  'AOS_INPUT_JSON_DUPLICATE_KEY',
  'AOS_INPUT_JSON_NORMALIZED_KEY_COLLISION',
  'AOS_INPUT_JSON_INVALID_UNICODE',
  'AOS_INPUT_JSON_UNSAFE_INTEGER',
  'AOS_INPUT_JSON_INPUT_LIMIT',
  'AOS_INPUT_JSON_DEPTH_LIMIT',
  'AOS_INPUT_JSON_NODE_LIMIT',
  'AOS_INPUT_JSON_STRING_LIMIT',
]);

export type TrustedJsonDiagnosticCode = z.infer<typeof TrustedJsonDiagnosticCodeSchema>;

export const TrustedJsonDiagnosticSchema = z.object({
  code: TrustedJsonDiagnosticCodeSchema,
  message: z.string().min(1),
  byteOffset: SafeNonNegativeIntegerSchema,
  line: SafePositiveIntegerSchema,
  column: SafePositiveIntegerSchema,
  path: z.string(),
}).strict();

export type TrustedJsonDiagnostic = z.infer<typeof TrustedJsonDiagnosticSchema>;

export const TrustedJsonDocumentSchema = z.object({
  schema: z.literal('awkn-trusted-json-document/v1'),
  parserVersion: z.literal(TRUSTED_JSON_PARSER_VERSION),
  sourceHash: z.string().regex(SHA256_HEX_PATTERN),
  valueHash: z.string().regex(SHA256_HEX_PATTERN),
  byteLength: SafeNonNegativeIntegerSchema,
  value: JsonValueSchema,
}).strict();

export type TrustedJsonDocument = z.infer<typeof TrustedJsonDocumentSchema>;

export const InputJsonReceiptPayloadSchema = z.object({
  schema: z.literal('awkn-input-json-receipt/v1'),
  parserVersion: z.literal(TRUSTED_JSON_PARSER_VERSION),
  status: z.enum(['ACCEPTED', 'REJECTED']),
  sourceHash: z.string().regex(SHA256_HEX_PATTERN),
  valueHash: z.string().regex(SHA256_HEX_PATTERN).optional(),
  byteLength: SafeNonNegativeIntegerSchema,
  limits: TrustedJsonLimitsSchema,
  diagnostics: z.array(TrustedJsonDiagnosticSchema),
}).strict().superRefine((value, context) => {
  if (value.status === 'ACCEPTED') {
    if (value.valueHash === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valueHash'],
        message: 'accepted input requires valueHash',
      });
    }
    if (value.diagnostics.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnostics'],
        message: 'accepted input cannot contain diagnostics',
      });
    }
  }

  if (value.status === 'REJECTED') {
    if (value.valueHash !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valueHash'],
        message: 'rejected input cannot publish valueHash',
      });
    }
    if (value.diagnostics.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnostics'],
        message: 'rejected input requires at least one diagnostic',
      });
    }
  }
});

export type InputJsonReceiptPayload = z.infer<typeof InputJsonReceiptPayloadSchema>;
