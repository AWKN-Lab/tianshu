import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AuthorizationRecordSchema,
  DomainEventSchema,
  ExecutionEnvelopeSchema,
  GoalSpecSchema,
  ReceiptEnvelopeSchema,
  StoredReceiptEnvelopeSchema,
  isKnownReceiptType,
  stableHash,
  validateReceiptPayloadHash,
} from '../../src/contracts/public.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures', 'contracts');
const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureRoot, ...segments), 'utf8')) as Record<string, unknown>;
}

describe('receipt forward compatibility', () => {
  it('preserves unknown receipt types for storage without executing them as known types', () => {
    const known = readJson('receipt', 'policy-allow', 'input.json');
    const future = { ...known, receiptType: 'FUTURE_VERIFICATION' };

    const stored = StoredReceiptEnvelopeSchema.parse(future);
    assert.equal(stored.receiptType, 'FUTURE_VERIFICATION');
    assert.equal(isKnownReceiptType(stored.receiptType), false);
    assert.equal(validateReceiptPayloadHash(stored), true);
    assert.throws(() => ReceiptEnvelopeSchema.parse(future));
  });

  it('rejects malformed future receipt type names', () => {
    const known = readJson('receipt', 'policy-allow', 'input.json');
    assert.throws(() => StoredReceiptEnvelopeSchema.parse({ ...known, receiptType: 'future-type' }));
  });
});

describe('safe integer boundaries', () => {
  it('rejects unsafe Execution revisions', () => {
    const execution = readJson('execution-envelope', 'received', 'input.json');
    assert.throws(() => ExecutionEnvelopeSchema.parse({ ...execution, revision: unsafeInteger }));
  });

  it('rejects unsafe Goal budgets', () => {
    const goal = readJson('goal-spec', 'core-contracts', 'input.json');
    const budget = goal.budget as Record<string, unknown>;
    assert.throws(() => GoalSpecSchema.parse({
      ...goal,
      budget: { ...budget, maxTokens: unsafeInteger },
    }));
  });

  it('rejects unsafe Authorization counters', () => {
    const authorization = readJson('authorization', 'active-single-use', 'input.json');
    assert.throws(() => AuthorizationRecordSchema.parse({
      ...authorization,
      maxUses: unsafeInteger,
    }));
  });

  it('rejects unsafe Event versions and revisions', () => {
    const actor = {
      schema: 'awkn-actor-ref/v1',
      actorId: 'system-1',
      actorType: 'system',
    };
    const event = {
      schema: 'awkn-domain-event/v1',
      eventId: 'evt_77777777777777777777777777777777',
      eventType: 'execution.received',
      eventVersion: 1,
      aggregateType: 'execution',
      aggregateId: 'exec_22222222222222222222222222222222',
      aggregateRevision: 0,
      executionId: 'exec_22222222222222222222222222222222',
      traceId: 'tr_33333333333333333333333333333333',
      actor,
      idempotencyKey: 'execution:received:1',
      receiptIds: [],
      payloadSchema: 'awkn-execution-received/v1',
      payload: { state: 'RECEIVED' },
      occurredAt: '2026-07-26T12:00:00.000Z',
    };

    assert.throws(() => DomainEventSchema.parse({ ...event, eventVersion: unsafeInteger }));
    assert.throws(() => DomainEventSchema.parse({ ...event, aggregateRevision: unsafeInteger }));
  });
});

describe('stable hash schema domain', () => {
  it('rejects invalid or unversioned schema identifiers', () => {
    assert.throws(() => stableHash('test/v1', { ok: true }));
    assert.throws(() => stableHash('awkn-test/v0', { ok: true }));
    assert.throws(() => stableHash('awkn-Test/v1', { ok: true }));
  });
});
