import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOtlpPayload,
  generateSpanId,
  generateTraceId,
  sanitizeAttributes,
  startSpan,
  type SpanRecord,
} from '../../src/observability/trace.js';

const previousTraceFile = process.env.AWKN_TRACE_FILE;
const previousTraceLocal = process.env.AWKN_TRACE_LOCAL;
const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

afterEach(() => {
  if (previousTraceFile === undefined) delete process.env.AWKN_TRACE_FILE;
  else process.env.AWKN_TRACE_FILE = previousTraceFile;
  if (previousTraceLocal === undefined) delete process.env.AWKN_TRACE_LOCAL;
  else process.env.AWKN_TRACE_LOCAL = previousTraceLocal;
  if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
});

describe('OpenTelemetry-compatible tracing', () => {
  it('generates W3C-sized hexadecimal identifiers', () => {
    assert.match(generateTraceId(), /^[0-9a-f]{32}$/);
    assert.match(generateSpanId(), /^[0-9a-f]{16}$/);
  });

  it('redacts sensitive attributes while preserving token metrics', () => {
    const attributes = sanitizeAttributes({
      authorization: 'Bearer secret',
      'gen_ai.prompt': 'private prompt',
      'gen_ai.usage.input_tokens': 42,
    });
    assert.equal(attributes.authorization, '[REDACTED]');
    assert.equal(attributes['gen_ai.prompt'], '[REDACTED]');
    assert.equal(attributes['gen_ai.usage.input_tokens'], 42);
  });

  it('writes a local JSONL span and redacts error secrets', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-trace-'));
    const file = join(root, 'trace.jsonl');
    process.env.AWKN_TRACE_FILE = file;
    process.env.AWKN_TRACE_LOCAL = '1';
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    const span = startSpan({ name: 'test.span', attributes: { password: 'hidden' } });
    span.end('error', { 'gen_ai.usage.total_tokens': 3 }, new Error('api_key=secret-value'));

    const record = JSON.parse(readFileSync(file, 'utf-8').trim()) as SpanRecord;
    assert.equal(record.name, 'test.span');
    assert.equal(record.attributes.password, '[REDACTED]');
    assert.equal(record.attributes['gen_ai.usage.total_tokens'], 3);
    assert.doesNotMatch(record.error ?? '', /secret-value/);
  });

  it('encodes byte fields as base64 in OTLP JSON', () => {
    const record: SpanRecord = {
      traceId: '000102030405060708090a0b0c0d0e0f',
      spanId: '0001020304050607',
      name: 'otlp',
      kind: 'client',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      status: 'ok',
      attributes: { count: 1 },
    };
    const payload = buildOtlpPayload(record) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string }> }> }>;
    };
    const encoded = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    assert.equal(encoded.traceId, Buffer.from(record.traceId, 'hex').toString('base64'));
    assert.equal(encoded.spanId, Buffer.from(record.spanId, 'hex').toString('base64'));
  });
});
