import { z } from 'zod';

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Runtime authority for values that may enter AWKN Canonical JSON.
 *
 * Objects containing undefined, Date, Map, Set, BigInt, functions, symbols,
 * NaN or infinities are rejected before canonicalization.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export function parseJsonValue(value: unknown): JsonValue {
  return JsonValueSchema.parse(value);
}
