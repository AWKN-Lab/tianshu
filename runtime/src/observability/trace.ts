import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer';
export type SpanStatus = 'ok' | 'error';
export type AttributeValue = string | number | boolean;

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: SpanStatus;
  attributes: Record<string, AttributeValue>;
  error?: string;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function generateTraceId(): string { return hex(16); }
export function generateSpanId(): string { return hex(8); }

function bytesBase64(hexValue: string | undefined): string | undefined {
  return hexValue ? Buffer.from(hexValue, 'hex').toString('base64') : undefined;
}

function nowNanos(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function sanitizeError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/(?:bearer\s+)[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 2000);
}

function sanitizeValue(key: string, value: unknown): AttributeValue | undefined {
  if (value === undefined || value === null) return undefined;
  const tokenMetric = /(?:^|[._])(?:input|output|total|prompt|completion)_?tokens$/i.test(key);
  const sensitive = /authorization|api.?key|secret|password|cookie|prompt|message\.content|request\.body|response\.body/i.test(key);
  if (sensitive && !tokenMetric) return '[REDACTED]';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

export function sanitizeAttributes(input: Record<string, unknown>): Record<string, AttributeValue> {
  const output: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const sanitized = sanitizeValue(key, value);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function localTracePath(): string {
  if (process.env.AWKN_TRACE_FILE) return resolve(process.env.AWKN_TRACE_FILE);
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'data', 'traces.jsonl');
}

function writeLocal(record: SpanRecord): void {
  if (process.env.AWKN_TRACE_LOCAL === '0') return;
  try {
    const path = localTracePath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch { /* observability must not break execution */ }
}

export function buildOtlpPayload(record: SpanRecord): Record<string, unknown> {
  const attributes = Object.entries(record.attributes).map(([key, value]) => ({
    key,
    value: typeof value === 'string'
      ? { stringValue: value }
      : typeof value === 'boolean'
        ? { boolValue: value }
        : Number.isInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value },
  }));
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: process.env.OTEL_SERVICE_NAME ?? 'awkn-engine-runtime' } }] },
      scopeSpans: [{
        scope: { name: 'awkn-engine', version: '0.1.0' },
        spans: [{
          traceId: bytesBase64(record.traceId),
          spanId: bytesBase64(record.spanId),
          parentSpanId: bytesBase64(record.parentSpanId),
          name: record.name,
          kind: { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 }[record.kind],
          startTimeUnixNano: record.startTimeUnixNano,
          endTimeUnixNano: record.endTimeUnixNano,
          attributes,
          status: { code: record.status === 'ok' ? 1 : 2, message: record.error },
        }],
      }],
    }],
  };
}

function exportOtlp(record: SpanRecord): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  const url = endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`;
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.OTEL_EXPORTER_OTLP_HEADERS ? parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS) : {}) },
    body: JSON.stringify(buildOtlpPayload(record)),
  }).catch(() => undefined);
}

function parseHeaders(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw.split(',')
      .map((entry) => entry.split('=', 2).map((part) => decodeURIComponent(part.trim())))
      .filter((parts) => parts.length === 2) as Array<[string, string]>,
  );
}

export interface SpanHandle {
  traceId: string;
  spanId: string;
  end(status?: SpanStatus, attributes?: Record<string, unknown>, error?: unknown): SpanRecord;
}

export function startSpan(input: {
  traceId?: string;
  parentSpanId?: string;
  name: string;
  kind?: SpanKind;
  attributes?: Record<string, unknown>;
}): SpanHandle {
  const traceId = input.traceId ?? generateTraceId();
  const spanId = generateSpanId();
  const started = nowNanos();
  let ended = false;
  return {
    traceId,
    spanId,
    end(status = 'ok', attributes = {}, error?: unknown): SpanRecord {
      if (ended) throw new Error(`span ${spanId} already ended`);
      ended = true;
      const record: SpanRecord = {
        traceId,
        spanId,
        parentSpanId: input.parentSpanId,
        name: input.name,
        kind: input.kind ?? 'internal',
        startTimeUnixNano: started.toString(),
        endTimeUnixNano: nowNanos().toString(),
        status,
        attributes: sanitizeAttributes({ ...(input.attributes ?? {}), ...attributes }),
        error: sanitizeError(error),
      };
      writeLocal(record);
      exportOtlp(record);
      return record;
    },
  };
}

export function recordCompletedSpan(input: {
  traceId?: string;
  name: string;
  kind?: SpanKind;
  durationMs: number;
  status: SpanStatus;
  attributes?: Record<string, unknown>;
  error?: unknown;
}): SpanRecord {
  const end = nowNanos();
  const record: SpanRecord = {
    traceId: input.traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    name: input.name,
    kind: input.kind ?? 'internal',
    startTimeUnixNano: (end - BigInt(Math.max(0, Math.floor(input.durationMs))) * 1_000_000n).toString(),
    endTimeUnixNano: end.toString(),
    status: input.status,
    attributes: sanitizeAttributes(input.attributes ?? {}),
    error: sanitizeError(input.error),
  };
  writeLocal(record);
  exportOtlp(record);
  return record;
}
