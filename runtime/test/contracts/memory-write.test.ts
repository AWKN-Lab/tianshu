/**
 * Memory Write Gate Contract Tests (Phase 6 / C09 / WP-AOS-14)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第五、六节
 *
 * 覆盖：
 * - MemoryCandidate 校验（governance 必须确认、blocked 不能 memory-os、assistant decision 必须确认）
 * - MemoryOperation 校验（create 不能 memoryId；update/delete 必须 memoryId）
 * - MemoryTransaction 重复 memoryId 检测、墓碑约束
 * - MemoryWriteReceipt 状态约束（WRITE/REJECT/DEFER）
 * - Hash 稳定性
 * - ID 生成
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MemoryClassSchema,
  MemoryBackendSchema,
  SensitivityDecisionSchema,
  MemoryWriteDecisionSchema,
  MemoryWriteReasonCodeSchema,
  MemoryOperationTypeSchema,
  MemoryCandidateSchema,
  MemoryOperationSchema,
  DependencyUpdateSchema,
  TombstoneSchema,
  MemoryTransactionSchema,
  MemoryWriteReceiptSchema,
  computeMemoryCandidateHash,
  computeMemoryTransactionHash,
  computeMemoryWriteReceiptHash,
  createMemoryCandidateId,
  createMemoryTransactionId,
  createMemoryWriteReceiptId,
  type MemoryCandidate,
  type MemoryTransaction,
  type MemoryWriteReceipt,
} from '../../src/contracts/memory-write.js';
import { claimContentHash, type Claim } from '../../src/contracts/claim.js';
import { createAwknId } from '../../src/contracts/ids.js';
import { toUtcTimestamp } from '../../src/contracts/time.js';

const NOW = toUtcTimestamp('2026-07-28T10:00:00.000Z');

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  const content = 'user prefers Chinese language';
  return {
    schema: 'awkn-claim/v3',
    claimId: createAwknId('claim'),
    content,
    contentHash: claimContentHash(content),
    originator: 'human',
    speaker: 'human',
    claimType: 'fact',
    epistemicStatus: 'asserted',
    confirmationLevel: 'field',
    sourceRefs: [{
      schema: 'awkn-source-ref/v1',
      sourceKind: 'current_human_message',
      sourceId: 'msg-1',
      observedAt: NOW,
    }],
    derivedFrom: [],
    authority: 0.8,
    confidence: 0.8,
    sensitivityClass: 'internal',
    validFrom: NOW,
    ...overrides,
  };
}

function makeMemoryCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    schema: 'awkn-memory-candidate/v1',
    candidateId: createMemoryCandidateId(),
    claim: makeClaim(),
    proposedMemoryClass: 'semantic',
    writeReason: 'user-stated durable preference',
    durabilityScore: 0.9,
    futureUtilityScore: 0.8,
    sensitivityDecision: 'allowed',
    requiresConfirmation: false,
    targetBackend: 'memory-os',
    ...overrides,
  };
}

function makeMemoryOperation(overrides: Partial<{ type: string; memoryId: string | undefined; claim: Claim; memoryClass: string; expectedRevision: number | undefined }> = {}) {
  return {
    type: 'create' as const,
    claim: makeClaim(),
    memoryClass: 'semantic' as const,
    ...overrides,
  };
}

function makeMemoryTransaction(overrides: Partial<MemoryTransaction> = {}): MemoryTransaction {
  return {
    schema: 'awkn-transaction/v1',
    transactionId: createMemoryTransactionId(),
    idempotencyKey: 'idem-1',
    operations: [makeMemoryOperation()],
    dependencyUpdates: [],
    tombstones: [],
    ...overrides,
  };
}

function makeMemoryWriteReceipt(overrides: Partial<MemoryWriteReceipt> = {}): MemoryWriteReceipt {
  return {
    schema: 'awkn-memory-write-receipt/v1',
    receiptId: createMemoryWriteReceiptId(),
    candidateId: createMemoryCandidateId(),
    claimId: createAwknId('claim'),
    decision: 'WRITE',
    reasonCodes: ['HUMAN_FIELD_CONFIRMED', 'DURABLE'],
    backend: 'memory-os',
    memoryId: 'mem-1',
    revision: 1,
    idempotencyKey: 'idem-1',
    transactionId: createMemoryTransactionId(),
    createdAt: NOW,
    ...overrides,
  };
}

describe('Memory Write Gate Contract (C09)', () => {
  describe('enums', () => {
    it('accepts all six memory classes', () => {
      for (const c of ['working', 'goal', 'episodic', 'semantic', 'procedural', 'governance'] as const) {
        assert.equal(MemoryClassSchema.safeParse(c).success, true);
      }
    });

    it('accepts all three backends', () => {
      for (const b of ['local', 'memory-os', 'none'] as const) {
        assert.equal(MemoryBackendSchema.safeParse(b).success, true);
      }
    });

    it('accepts all four sensitivity decisions', () => {
      for (const s of ['allowed', 'sensitive', 'blocked', 'redacted'] as const) {
        assert.equal(SensitivityDecisionSchema.safeParse(s).success, true);
      }
    });

    it('accepts all three write decisions', () => {
      for (const d of ['WRITE', 'REJECT', 'DEFER'] as const) {
        assert.equal(MemoryWriteDecisionSchema.safeParse(d).success, true);
      }
    });

    it('accepts all three operation types', () => {
      for (const t of ['create', 'update', 'delete'] as const) {
        assert.equal(MemoryOperationTypeSchema.safeParse(t).success, true);
      }
    });
  });

  describe('MemoryCandidate', () => {
    it('accepts valid candidate', () => {
      assert.equal(MemoryCandidateSchema.safeParse(makeMemoryCandidate()).success, true);
    });

    it('rejects claim without awkn-claim/v3 schema', () => {
      const badClaim = { ...makeClaim(), schema: 'wrong' };
      assert.equal(
        MemoryCandidateSchema.safeParse(makeMemoryCandidate({ claim: badClaim as unknown as Claim })).success,
        false,
      );
    });

    it('rejects claim without sourceRefs', () => {
      const badClaim = { ...makeClaim(), sourceRefs: [] };
      assert.equal(
        MemoryCandidateSchema.safeParse(makeMemoryCandidate({ claim: badClaim as unknown as Claim })).success,
        false,
      );
    });

    it('rejects governance memory without confirmation (design test 4)', () => {
      assert.equal(
        MemoryCandidateSchema.safeParse(
          makeMemoryCandidate({ proposedMemoryClass: 'governance', requiresConfirmation: false }),
        ).success,
        false,
      );
    });

    it('accepts governance memory with confirmation', () => {
      assert.equal(
        MemoryCandidateSchema.safeParse(
          makeMemoryCandidate({ proposedMemoryClass: 'governance', requiresConfirmation: true }),
        ).success,
        true,
      );
    });

    it('rejects blocked sensitivity targeting memory-os', () => {
      assert.equal(
        MemoryCandidateSchema.safeParse(
          makeMemoryCandidate({ sensitivityDecision: 'blocked', targetBackend: 'memory-os' }),
        ).success,
        false,
      );
    });

    it('accepts blocked sensitivity targeting local', () => {
      assert.equal(
        MemoryCandidateSchema.safeParse(
          makeMemoryCandidate({ sensitivityDecision: 'blocked', targetBackend: 'local' }),
        ).success,
        true,
      );
    });

    it('rejects assistant decision claim without confirmation (design test 4)', () => {
      const assistantClaim = makeClaim({
        originator: 'assistant',
        speaker: 'assistant',
        claimType: 'decision',
      });
      assert.equal(
        MemoryCandidateSchema.safeParse(
          makeMemoryCandidate({ claim: assistantClaim, requiresConfirmation: false }),
        ).success,
        false,
      );
    });

    it('accepts assistant decision claim with confirmation', () => {
      const assistantClaim = makeClaim({
        originator: 'assistant',
        speaker: 'assistant',
        claimType: 'decision',
      });
      assert.equal(
        MemoryCandidateSchema.safeParse(
          makeMemoryCandidate({ claim: assistantClaim, requiresConfirmation: true }),
        ).success,
        true,
      );
    });

    it('accepts assistant non-decision claim without confirmation', () => {
      const assistantClaim = makeClaim({
        originator: 'assistant',
        speaker: 'assistant',
        claimType: 'fact',
      });
      assert.equal(
        MemoryCandidateSchema.safeParse(
          makeMemoryCandidate({ claim: assistantClaim, requiresConfirmation: false }),
        ).success,
        true,
      );
    });
  });

  describe('MemoryOperation', () => {
    it('accepts create without memoryId', () => {
      assert.equal(MemoryOperationSchema.safeParse(makeMemoryOperation({ type: 'create' })).success, true);
    });

    it('rejects create with memoryId', () => {
      assert.equal(
        MemoryOperationSchema.safeParse(makeMemoryOperation({ type: 'create', memoryId: 'mem-1' })).success,
        false,
      );
    });

    it('rejects update without memoryId', () => {
      assert.equal(
        MemoryOperationSchema.safeParse(makeMemoryOperation({ type: 'update' })).success,
        false,
      );
    });

    it('accepts update with memoryId', () => {
      assert.equal(
        MemoryOperationSchema.safeParse(makeMemoryOperation({ type: 'update', memoryId: 'mem-1' })).success,
        true,
      );
    });

    it('rejects delete without memoryId', () => {
      assert.equal(
        MemoryOperationSchema.safeParse(makeMemoryOperation({ type: 'delete' })).success,
        false,
      );
    });
  });

  describe('DependencyUpdate and Tombstone', () => {
    it('accepts valid dependency update', () => {
      const du = {
        dependentMemoryId: 'mem-1',
        dependencyClaimId: createAwknId('claim'),
        action: 'invalidate',
        reason: 'source claim deleted',
      };
      assert.equal(DependencyUpdateSchema.safeParse(du).success, true);
    });

    it('accepts valid tombstone', () => {
      const ts = {
        memoryId: 'mem-1',
        reason: 'source claim disputed',
        deletedAt: NOW,
      };
      assert.equal(TombstoneSchema.safeParse(ts).success, true);
    });
  });

  describe('MemoryTransaction', () => {
    it('accepts valid transaction', () => {
      assert.equal(MemoryTransactionSchema.safeParse(makeMemoryTransaction()).success, true);
    });

    it('rejects duplicate memoryId in same transaction', () => {
      const tx = makeMemoryTransaction({
        operations: [
          makeMemoryOperation({ type: 'update', memoryId: 'mem-1' }),
          makeMemoryOperation({ type: 'update', memoryId: 'mem-1' }),
        ],
      });
      assert.equal(MemoryTransactionSchema.safeParse(tx).success, false);
    });

    it('rejects create/update on tombstoned memory', () => {
      const tx = makeMemoryTransaction({
        operations: [makeMemoryOperation({ type: 'update', memoryId: 'mem-1' })],
        tombstones: [{
          memoryId: 'mem-1',
          reason: 'disputed',
          deletedAt: NOW,
        }],
      });
      assert.equal(MemoryTransactionSchema.safeParse(tx).success, false);
    });

    it('accepts delete on tombstoned memory', () => {
      const tx = makeMemoryTransaction({
        operations: [makeMemoryOperation({ type: 'delete', memoryId: 'mem-1' })],
        tombstones: [{
          memoryId: 'mem-1',
          reason: 'disputed',
          deletedAt: NOW,
        }],
      });
      assert.equal(MemoryTransactionSchema.safeParse(tx).success, true);
    });
  });

  describe('MemoryWriteReceipt', () => {
    it('accepts valid WRITE receipt', () => {
      assert.equal(MemoryWriteReceiptSchema.safeParse(makeMemoryWriteReceipt()).success, true);
    });

    it('rejects WRITE without memoryId (when backend available)', () => {
      assert.equal(
        MemoryWriteReceiptSchema.safeParse(makeMemoryWriteReceipt({ memoryId: undefined })).success,
        false,
      );
    });

    it('accepts WRITE without memoryId when BACKEND_UNAVAILABLE', () => {
      assert.equal(
        MemoryWriteReceiptSchema.safeParse(
          makeMemoryWriteReceipt({
            backend: 'none',
            memoryId: undefined,
            reasonCodes: ['BACKEND_UNAVAILABLE'],
          }),
        ).success,
        true,
      );
    });

    it('rejects REJECT with non-none backend', () => {
      assert.equal(
        MemoryWriteReceiptSchema.safeParse(
          makeMemoryWriteReceipt({ decision: 'REJECT', backend: 'memory-os', memoryId: undefined, reasonCodes: ['MODEL_INFERENCE'] }),
        ).success,
        false,
      );
    });

    it('accepts REJECT with none backend', () => {
      assert.equal(
        MemoryWriteReceiptSchema.safeParse(
          makeMemoryWriteReceipt({
            decision: 'REJECT',
            backend: 'none',
            memoryId: undefined,
            reasonCodes: ['MODEL_INFERENCE'],
          }),
        ).success,
        true,
      );
    });

    it('rejects DEFER without REQUIRES_CONFIRMATION reasonCode', () => {
      assert.equal(
        MemoryWriteReceiptSchema.safeParse(
          makeMemoryWriteReceipt({
            decision: 'DEFER',
            backend: 'none',
            memoryId: undefined,
            reasonCodes: ['DURABLE'],
          }),
        ).success,
        false,
      );
    });

    it('accepts DEFER with REQUIRES_CONFIRMATION', () => {
      assert.equal(
        MemoryWriteReceiptSchema.safeParse(
          makeMemoryWriteReceipt({
            decision: 'DEFER',
            backend: 'none',
            memoryId: undefined,
            reasonCodes: ['REQUIRES_CONFIRMATION'],
          }),
        ).success,
        true,
      );
    });
  });

  describe('hash and id', () => {
    it('produces stable candidate hash', () => {
      const c = makeMemoryCandidate();
      const { candidateId: _id, ...content } = c;
      void _id;
      const h1 = computeMemoryCandidateHash(content);
      const h2 = computeMemoryCandidateHash(content);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{64}$/);
    });

    it('produces stable transaction hash', () => {
      const tx = makeMemoryTransaction();
      const { transactionId: _id, ...content } = tx;
      void _id;
      const h1 = computeMemoryTransactionHash(content);
      const h2 = computeMemoryTransactionHash(content);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{64}$/);
    });

    it('produces stable receipt hash', () => {
      const r = makeMemoryWriteReceipt();
      const { receiptId: _id, ...content } = r;
      void _id;
      const h1 = computeMemoryWriteReceiptHash(content);
      const h2 = computeMemoryWriteReceiptHash(content);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{64}$/);
    });

    it('generates valid AWKN IDs', () => {
      assert.match(createMemoryCandidateId(), /^mc_[0-9a-f]{32}$/);
      assert.match(createMemoryTransactionId(), /^mtx_[0-9a-f]{32}$/);
      assert.match(createMemoryWriteReceiptId(), /^mw_[0-9a-f]{32}$/);
    });
  });
});
