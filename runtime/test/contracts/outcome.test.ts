/**
 * Outcome Record Contract Tests (Phase 6 / C08 / WP-AOS-13)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第三、四节
 *
 * 覆盖：
 * - OutcomeState 五层独立性（执行/交付/采用/业务/学习）
 * - OutcomeAttribution 权重归一化
 * - 状态不可合并约束（执行成功才能交付成功，交付成功才能采用成功）
 * - Hash 稳定性
 * - 辅助查询函数
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OutcomeStateSchema,
  OutcomeAttributionMethodSchema,
  WeightedRefSchema,
  OutcomeAttributionSchema,
  OutcomeRecordSchema,
  computeOutcomeRecordHash,
  createOutcomeId,
  snapshotOutcomeStates,
  hasIndependentLearning,
  needsFurtherObservation,
  countBlockingReasons,
  type OutcomeRecord,
  type OutcomeAttribution,
} from '../../src/contracts/outcome.js';
import { createAwknId } from '../../src/contracts/ids.js';
import { toUtcTimestamp } from '../../src/contracts/time.js';
import type { ActorRef } from '../../src/contracts/actors.js';

const NOW = toUtcTimestamp('2026-07-28T10:00:00.000Z');
const EXECUTION_ID = createAwknId('execution');
const EVIDENCE_ID = createAwknId('evidence');

function makeActor(): ActorRef {
  return {
    schema: 'awkn-actor-ref/v1',
    actorId: 'observer-1',
    actorType: 'system',
    projectId: 'proj-1',
  };
}

function makeWeightedRef(ref: string, weight: number): { ref: string; weight: number } {
  return { ref, weight };
}

function makeAttribution(overrides: Partial<OutcomeAttribution> = {}): OutcomeAttribution {
  return {
    contributingClaims: [makeWeightedRef('clm_a', 0.5), makeWeightedRef('clm_b', 0.5)],
    contributingPolicies: [],
    contributingSkills: [],
    contributingModels: [],
    contributingTools: [],
    confidence: 0.8,
    method: 'rule_based',
    ...overrides,
  };
}

function makeOutcomeRecord(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    schema: 'awkn-outcome-record/v1',
    outcomeId: createOutcomeId(),
    executionId: EXECUTION_ID,
    executionOutcome: 'SUCCEEDED',
    deliveryOutcome: 'SUCCEEDED',
    adoptionOutcome: 'UNKNOWN',
    businessOutcome: 'UNKNOWN',
    learningOutcome: 'UNKNOWN',
    evidenceIds: [EVIDENCE_ID],
    observedAt: NOW,
    observer: makeActor(),
    confidence: 0.8,
    ...overrides,
  };
}

describe('Outcome Contract (C08)', () => {
  describe('enums', () => {
    it('accepts all six outcome states', () => {
      for (const state of ['SUCCEEDED', 'FAILED', 'PARTIAL', 'CANCELLED', 'PENDING', 'UNKNOWN'] as const) {
        assert.equal(OutcomeStateSchema.safeParse(state).success, true);
      }
    });

    it('accepts all four attribution methods', () => {
      for (const method of ['rule_based', 'counterfactual', 'human_review', 'mixed'] as const) {
        assert.equal(OutcomeAttributionMethodSchema.safeParse(method).success, true);
      }
    });
  });

  describe('WeightedRef', () => {
    it('accepts valid weighted ref', () => {
      assert.equal(WeightedRefSchema.safeParse({ ref: 'clm_1', weight: 0.5 }).success, true);
    });

    it('rejects weight out of range', () => {
      assert.equal(WeightedRefSchema.safeParse({ ref: 'clm_1', weight: 1.5 }).success, false);
      assert.equal(WeightedRefSchema.safeParse({ ref: 'clm_1', weight: -0.1 }).success, false);
    });
  });

  describe('OutcomeAttribution', () => {
    it('accepts valid attribution with normalized weights', () => {
      const attr = makeAttribution();
      assert.equal(OutcomeAttributionSchema.safeParse(attr).success, true);
    });

    it('rejects attribution with no contributing factors', () => {
      const attr = makeAttribution({
        contributingClaims: [],
      });
      assert.equal(OutcomeAttributionSchema.safeParse(attr).success, false);
    });

    it('rejects attribution with weights not summing to 1.0', () => {
      const attr = makeAttribution({
        contributingClaims: [makeWeightedRef('clm_a', 0.3), makeWeightedRef('clm_b', 0.3)],
      });
      assert.equal(OutcomeAttributionSchema.safeParse(attr).success, false);
    });

    it('accepts attribution spread across multiple categories', () => {
      const attr = makeAttribution({
        contributingClaims: [makeWeightedRef('clm_a', 0.4)],
        contributingPolicies: [makeWeightedRef('pb_1', 0.3)],
        contributingTools: [makeWeightedRef('tc_1', 0.3)],
      });
      assert.equal(OutcomeAttributionSchema.safeParse(attr).success, true);
    });
  });

  describe('OutcomeRecord', () => {
    it('accepts a valid record with UNKNOWN adoption/business/learning', () => {
      const record = makeOutcomeRecord();
      assert.equal(OutcomeRecordSchema.safeParse(record).success, true);
    });

    it('rejects delivery SUCCEEDED when execution FAILED', () => {
      const record = makeOutcomeRecord({
        executionOutcome: 'FAILED',
        deliveryOutcome: 'SUCCEEDED',
      });
      assert.equal(OutcomeRecordSchema.safeParse(record).success, false);
    });

    it('rejects adoption SUCCEEDED when delivery not SUCCEEDED', () => {
      const record = makeOutcomeRecord({
        executionOutcome: 'SUCCEEDED',
        deliveryOutcome: 'PARTIAL',
        adoptionOutcome: 'SUCCEEDED',
      });
      assert.equal(OutcomeRecordSchema.safeParse(record).success, false);
    });

    it('rejects business SUCCEEDED without adoption', () => {
      const record = makeOutcomeRecord({
        executionOutcome: 'SUCCEEDED',
        deliveryOutcome: 'SUCCEEDED',
        adoptionOutcome: 'UNKNOWN',
        businessOutcome: 'SUCCEEDED',
      });
      assert.equal(OutcomeRecordSchema.safeParse(record).success, false);
    });

    it('allows execution failure with learning success (test 10)', () => {
      const record = makeOutcomeRecord({
        executionOutcome: 'FAILED',
        deliveryOutcome: 'FAILED',
        adoptionOutcome: 'UNKNOWN',
        businessOutcome: 'UNKNOWN',
        learningOutcome: 'SUCCEEDED',
      });
      assert.equal(OutcomeRecordSchema.safeParse(record).success, true);
    });

    it('rejects learning FAILED when execution SUCCEEDED', () => {
      const record = makeOutcomeRecord({
        executionOutcome: 'SUCCEEDED',
        deliveryOutcome: 'SUCCEEDED',
        learningOutcome: 'FAILED',
      });
      assert.equal(OutcomeRecordSchema.safeParse(record).success, false);
    });

    it('accepts attribution in outcome record', () => {
      const record = makeOutcomeRecord({
        attribution: makeAttribution(),
      });
      assert.equal(OutcomeRecordSchema.safeParse(record).success, true);
    });
  });

  describe('hash computation', () => {
    it('produces stable SHA-256 hash', () => {
      const record = makeOutcomeRecord();
      const { outcomeId: _o, ...content } = record;
      void _o;
      const h1 = computeOutcomeRecordHash(content);
      const h2 = computeOutcomeRecordHash(content);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{64}$/);
    });

    it('changes hash when state changes', () => {
      const r1 = makeOutcomeRecord({ executionOutcome: 'SUCCEEDED' });
      const r2 = makeOutcomeRecord({ executionOutcome: 'FAILED', deliveryOutcome: 'FAILED' });
      const { outcomeId: _o1, ...c1 } = r1;
      const { outcomeId: _o2, ...c2 } = r2;
      void _o1; void _o2;
      assert.notEqual(computeOutcomeRecordHash(c1), computeOutcomeRecordHash(c2));
    });
  });

  describe('snapshot and helpers', () => {
    it('snapshotOutcomeStates returns all five layers', () => {
      const record = makeOutcomeRecord();
      const snap = snapshotOutcomeStates(record);
      assert.equal(snap.execution, 'SUCCEEDED');
      assert.equal(snap.delivery, 'SUCCEEDED');
      assert.equal(snap.adoption, 'UNKNOWN');
      assert.equal(snap.business, 'UNKNOWN');
      assert.equal(snap.learning, 'UNKNOWN');
    });

    it('hasIndependentLearning detects successful learning', () => {
      const record = makeOutcomeRecord({ learningOutcome: 'SUCCEEDED' });
      assert.equal(hasIndependentLearning(record), true);
    });

    it('needsFurtherObservation detects PENDING/UNKNOWN', () => {
      const record = makeOutcomeRecord({ adoptionOutcome: 'PENDING' });
      assert.equal(needsFurtherObservation(record), true);
    });

    it('countBlockingReasons counts FAILED layers', () => {
      const record = makeOutcomeRecord({
        executionOutcome: 'FAILED',
        deliveryOutcome: 'FAILED',
        adoptionOutcome: 'FAILED',
        businessOutcome: 'UNKNOWN',
        learningOutcome: 'SUCCEEDED',
      });
      assert.equal(countBlockingReasons(record), 3);
    });
  });
});
