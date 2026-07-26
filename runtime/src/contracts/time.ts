import { z } from 'zod';

const UTC_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCanonicalUtcTimestamp(value: string): boolean {
  if (!UTC_MILLISECOND_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isBusinessDate(value: string): boolean {
  if (!BUSINESS_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const UtcTimestampSchema = z.string().refine(
  isCanonicalUtcTimestamp,
  'timestamp must be UTC ISO-8601 with millisecond precision',
);

export const BusinessDateSchema = z.string().refine(
  isBusinessDate,
  'business date must use YYYY-MM-DD',
);

export function toUtcTimestamp(input: string | Date): string {
  const parsed = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid timestamp');
  if (typeof input === 'string' && !/(Z|[+-]\d{2}:\d{2})$/.test(input)) {
    throw new Error('timestamp timezone is required');
  }
  return parsed.toISOString();
}
