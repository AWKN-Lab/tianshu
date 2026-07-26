import { z } from 'zod';

export const SCHEMA_ID_PATTERN = /^awkn-[a-z0-9-]+\/v[1-9][0-9]*$/;

export const SchemaIdSchema = z.string().regex(
  SCHEMA_ID_PATTERN,
  'schema ID must use awkn-<domain>-<name>/v<major>',
);

export type SchemaId = z.infer<typeof SchemaIdSchema>;

export function parseSchemaId(value: unknown): SchemaId {
  return SchemaIdSchema.parse(value);
}
