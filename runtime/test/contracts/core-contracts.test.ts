import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ActorRefSchema,
  ExecutionEnvelopeSchema,
  ObjectRefSchema,
  ReceiptEnvelopeSchema,
  canonicalizeJson,
  createAwknId,
  receiptPayloadHash,
  stableHash,
  toUtcTimestamp,
  validateReceiptPayloadHash,
} from '../../src/contracts/public.js';

const id = (prefix: string, digit: string): string => `${prefix}_${digit.repeat(32)}`;

const actor = ActorRefSchema.parse({
  schema: 'awkn-actor-ref/v1',
  actorId: 'user-1',
  actorType: 'human',
  userId: 'user-1',
  projectId: 'tianshu',
});

const objectRef = ObjectRefSchema.parse({
  schema: 'awkn-object-ref/v1',
  objectType: 'trusted-input',
  objectId: 'input-1',
  schemaId: 'awkn-trusted-input/v1',
  contentHash: 'a'.repeat(64),
});

describe('AWKN Canonical JSON v1', () => {
  it('normalizes keys and values to NFC and sorts keys by code point', () => {
    assert.equal(
      canonicalizeJson({ b: 1, a: 'e\u0301' }),
      '{"a":"é","b":1}',
    );
  });

  it('preserves array order, null and false while normalizing negative zero', () => {
    assert.equal(
      canonicalizeJson({ items: [3, 1, 2], nil: null, ok: false, zero: -0 }),
      '{"items":[3,1,2],"nil":null,"ok":false,"zero":0}',
    );
  });

  it('normalizes CRLF only for declared text paths', () => {
    const textPaths = new Set(['/text']);
    assert.equal(
      canonicalizeJson({ raw: 'a\r\nb', text: 'a\r\nb' }, { textPaths }),
      '{"raw":"a\\r\\nb","text":"a\\nb"}',
    );
  });

  it('produces the frozen stable-hash vector', () => {
    assert.equal(
      stableHash('awkn-test/v1', { b: 1, a: 'e\u0301' }),
      'fc82c1fb048c48756e487547b889d3fb6d10605c0054c428ba188952ab3e0d8c',
    );
  });

  it('rejects unsupported or ambiguous runtime values', () => {
    assert.throws(() => canonicalizeJson({ value: undefined }), /undefined object field/);
    assert.throws(() => canonicalizeJson({ value: Number.NaN }), /non-finite number/);
    assert.throws(() => canonicalizeJson(new Date()), /plain objects/);
    assert.throws(() => canonicalizeJson('\ud800'), /unpaired high surrogate/);
    assert.throws(
      () => canonicalizeJson({ é: 1, 'e\u0301': 2 }),
      /duplicate key after NFC normalization/,
    );
  });
});

describe('AWKN identifiers and time', () => {
  it('creates prefixed lowercase identifiers', () => {
    assert.match(createAwknId('execution'), /^exec_[0-9a-f]{32}$/);
    assert.match(createAwknId('receipt'), /^rcpt_[0-9a-f]{32}$/);
  });

  it('converts offset timestamps to canonical UTC milliseconds', () => {
    assert.equal(toUtcTimestamp('2026-07-26T20:00:00+08:00'), '2026-07-26T12:00:00.000Z');
    assert.throws(() => toUtcTimestamp('2026-07-26T12:00:00'), /timezone is required/);
  });
});

describe('ReceiptEnvelope v1', () => {
  it('validates strict receipt fields and payload hash', () => {
    const payload = { decision: 'ALLOW', count: 0 };
    const receipt = ReceiptEnvelopeSchema.parse({
      schema: 'awkn-receipt-envelope/v1',
      receiptId: id('rcpt', '1'),
      receiptType: 'POLICY',
      payloadSchema: 'awkn-policy-decision/v1',
      executionId: id('exec', '2'),
      traceId: id('tr', '3'),
      aggregateType: 'execution',
      aggregateId: id('exec', '2'),
      producer: actor,
      status: 'SUCCESS',
      payload,
      payloadHash: receiptPayloadHash('awkn-policy-decision/v1', payload),
      artifactRefs: [],
      createdAt: '2026-07-26T12:00:00.000Z',
    });

    assert.equal(validateReceiptPayloadHash(receipt), true);
    assert.equal(validateReceiptPayloadHash({ ...receipt, payloadHash: '0'.repeat(64) }), false);
  });

  it('rejects unknown envelope fields', () => {
    assert.throws(() => ReceiptEnvelopeSchema.parse({
      schema: 'awkn-receipt-envelope/v1',
      receiptId: id('rcpt', '1'),
      receiptType: 'INPUT',
      payloadSchema: 'awkn-input-receipt/v1',
      executionId: id('exec', '2'),
      traceId: id('tr', '3'),
      aggregateType: 'execution',
      aggregateId: id('exec', '2'),
      producer: actor,
      status: 'SUCCESS',
      payload: {},
      payloadHash: receiptPayloadHash('awkn-input-receipt/v1', {}),
      artifactRefs: [],
      createdAt: '2026-07-26T12:00:00.000Z',
      unexpected: true,
    }), /unrecognized/i);
  });
});

describe('ExecutionEnvelope v1', () => {
  const baseEnvelope = {
    schema: 'awkn-execution-envelope/v1' as const,
    executionId: id('exec', '4'),
    traceId: id('tr', '5'),
    revision: 0,
    actor,
    scope: {
      schema: 'awkn-execution-scope/v1' as const,
      projectId: 'tianshu',
      sessionId: 'session-1',
    },
    inputRef: objectRef,
    runRefs: [],
    deliveryRefs: [],
    memoryDecisionRefs: [],
    evolutionCandidateRefs: [],
    featureFlagsRef: {
      ...objectRef,
      objectType: 'feature-flag-snapshot',
      objectId: 'flags-1',
      schemaId: 'awkn-feature-flag-snapshot/v1',
    },
    createdAt: '2026-07-26T12:00:00.000Z',
    updatedAt: '2026-07-26T12:00:00.000Z',
  };

  it('accepts an active envelope without a closed timestamp', () => {
    const envelope = ExecutionEnvelopeSchema.parse({ ...baseEnvelope, state: 'RECEIVED' });
    assert.equal(envelope.state, 'RECEIVED');
  });

  it('requires closedAt only for CLOSED', () => {
    assert.throws(
      () => ExecutionEnvelopeSchema.parse({ ...baseEnvelope, state: 'CLOSED' }),
      /closedAt is required/,
    );
    assert.throws(
      () => ExecutionEnvelopeSchema.parse({
        ...baseEnvelope,
        state: 'RUNNING',
        closedAt: '2026-07-26T12:01:00.000Z',
      }),
      /closedAt is only valid/,
    );
    assert.doesNotThrow(() => ExecutionEnvelopeSchema.parse({
      ...baseEnvelope,
      state: 'CLOSED',
      updatedAt: '2026-07-26T12:01:00.000Z',
      closedAt: '2026-07-26T12:01:00.000Z',
    }));
  });
});
