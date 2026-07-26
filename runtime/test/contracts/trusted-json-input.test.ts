import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ActorRefSchema,
  InputJsonReceiptPayloadSchema,
  TrustedJsonDocumentSchema,
  validateReceiptPayloadHash,
} from '../../src/contracts/public.js';
import { buildInputJsonReceipt, parseTrustedJson } from '../../src/input/public.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures', 'input-json');
const id = (prefix: string, digit: string): string => `${prefix}_${digit.repeat(32)}`;

function fixture(name: string): string {
  return readFileSync(join(fixtureRoot, name), 'utf8');
}

describe('trusted JSON parser', () => {
  it('accepts valid JSON and binds source bytes to a canonical value hash', () => {
    const result = parseTrustedJson(fixture('accepted.json'));
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(TrustedJsonDocumentSchema.safeParse(result.document).success, true);
    assert.equal(InputJsonReceiptPayloadSchema.safeParse(result.receiptPayload).success, true);
    assert.equal(result.receiptPayload.status, 'ACCEPTED');
    assert.equal(result.document.sourceHash, result.receiptPayload.sourceHash);
    assert.equal(result.document.valueHash, result.receiptPayload.valueHash);
    assert.deepEqual(result.document.value, {
      name: 'café',
      nested: { ok: true },
      items: [1, 2, 3],
    });
  });

  it('rejects duplicate decoded keys before an object model is created', () => {
    const result = parseTrustedJson(fixture('duplicate-key.json'));
    assert.equal(result.ok, false);
    assert.equal(result.receiptPayload.status, 'REJECTED');
    assert.equal(result.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_DUPLICATE_KEY');
    assert.equal(result.receiptPayload.valueHash, undefined);
  });

  it('detects duplicates hidden by unicode escape decoding', () => {
    const result = parseTrustedJson('{"a":1,"\\u0061":2}');
    assert.equal(result.ok, false);
    assert.equal(result.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_DUPLICATE_KEY');
  });

  it('rejects keys that collide after NFC normalization', () => {
    const result = parseTrustedJson(fixture('normalized-key-collision.json'));
    assert.equal(result.ok, false);
    assert.equal(result.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_NORMALIZED_KEY_COLLISION');
  });

  it('normalizes accepted object keys to NFC', () => {
    const result = parseTrustedJson('{"e\\u0301":1}');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const value = result.document.value as Record<string, unknown>;
    assert.equal(value['é'], 1);
    assert.equal(Object.hasOwn(value, 'é'), false);
  });

  it('rejects invalid UTF-8 without decoding replacement characters', () => {
    const result = parseTrustedJson(Uint8Array.from([0xc3, 0x28]));
    assert.equal(result.ok, false);
    assert.equal(result.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_INVALID_UTF8');
  });

  it('rejects unpaired unicode escapes and raw control characters', () => {
    const surrogate = parseTrustedJson('{"value":"\\uD800"}');
    assert.equal(surrogate.ok, false);
    assert.equal(surrogate.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_INVALID_UNICODE');

    const control = parseTrustedJson('{"value":"line\nfeed"}');
    assert.equal(control.ok, false);
    assert.equal(control.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_SYNTAX');
  });

  it('enforces input, depth, node and string limits', () => {
    const inputLimit = parseTrustedJson('{"a":1}', { limits: { maxInputBytes: 3 } });
    assert.equal(inputLimit.ok, false);
    assert.equal(inputLimit.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_INPUT_LIMIT');

    const depthLimit = parseTrustedJson('[[[0]]]', { limits: { maxDepth: 3 } });
    assert.equal(depthLimit.ok, false);
    assert.equal(depthLimit.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_DEPTH_LIMIT');

    const nodeLimit = parseTrustedJson('[1,2,3]', { limits: { maxNodes: 3 } });
    assert.equal(nodeLimit.ok, false);
    assert.equal(nodeLimit.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_NODE_LIMIT');

    const stringLimit = parseTrustedJson('"abcd"', { limits: { maxStringLength: 3 } });
    assert.equal(stringLimit.ok, false);
    assert.equal(stringLimit.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_STRING_LIMIT');
  });

  it('rejects integers outside the safe integer range', () => {
    const result = parseTrustedJson('9007199254740992');
    assert.equal(result.ok, false);
    assert.equal(result.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_UNSAFE_INTEGER');
  });

  it('rejects trailing commas, leading zeroes and trailing content', () => {
    assert.equal(parseTrustedJson('{"a":1,}').ok, false);
    assert.equal(parseTrustedJson('01').ok, false);
    const trailing = parseTrustedJson('{"a":1} true');
    assert.equal(trailing.ok, false);
    assert.equal(trailing.receiptPayload.diagnostics[0]?.code, 'AOS_INPUT_JSON_TRAILING_CONTENT');
  });
});

describe('input JSON receipt', () => {
  it('wraps accepted parser evidence in a verifiable INPUT receipt', () => {
    const parsed = parseTrustedJson('{"ok":true}');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const producer = ActorRefSchema.parse({
      schema: 'awkn-actor-ref/v1',
      actorId: 'trusted-input-gateway',
      actorType: 'service',
    });
    const receipt = buildInputJsonReceipt({
      receiptId: id('rcpt', '1'),
      executionId: id('exec', '2'),
      traceId: id('tr', '3'),
      producer,
      payload: parsed.receiptPayload,
      createdAt: '2026-07-26T14:00:00.000Z',
    });

    assert.equal(receipt.receiptType, 'INPUT');
    assert.equal(receipt.status, 'SUCCESS');
    assert.equal(receipt.aggregateId, parsed.receiptPayload.sourceHash);
    assert.equal(validateReceiptPayloadHash(receipt), true);
  });

  it('maps rejected parser evidence to a FAILURE receipt', () => {
    const parsed = parseTrustedJson('{"x":1,"x":2}');
    assert.equal(parsed.ok, false);

    const receipt = buildInputJsonReceipt({
      receiptId: id('rcpt', '4'),
      executionId: id('exec', '5'),
      traceId: id('tr', '6'),
      producer: {
        schema: 'awkn-actor-ref/v1',
        actorId: 'trusted-input-gateway',
        actorType: 'service',
      },
      payload: parsed.receiptPayload,
      createdAt: '2026-07-26T14:00:00.000Z',
    });

    assert.equal(receipt.status, 'FAILURE');
    assert.equal(validateReceiptPayloadHash(receipt), true);
  });
});
