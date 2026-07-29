/**
 * Evidence-Gain Loop Contract Tests (Phase 6 / C06 / WP-AOS-12)
 *
 * 设计文档: docs/agent-os-3.0/07-Evidence-Gain-Loop.md
 *
 * 覆盖：
 * - Hypothesis 校验
 * - ExpectedEvidence 必填项
 * - CycleBudget 边界
 * - EvidenceCyclePlan 必须有 Expected Evidence 和 required 证据
 * - CycleReceipt 状态约束（正 Delta 需要证据；SWITCH 需要 nextStrategy）
 * - NoGainStopCondition 触发条件
 * - assessStrategySwitch 和 evaluateNoGainStop 辅助函数
 * - Hash 稳定性
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DeviationTypeSchema,
  StrategyDecisionSchema,
  HypothesisSchema,
  ExpectedEvidenceSchema,
  PlannedActionSchema,
  CycleBudgetSchema,
  EvidenceCyclePlanSchema,
  StrategyAttemptSchema,
  CycleReceiptSchema,
  NoGainStopConditionSchema,
  computeEvidenceCyclePlanHash,
  computeCycleReceiptHash,
  createCycleReceiptId,
  assessStrategySwitch,
  evaluateNoGainStop,
  type EvidenceCyclePlan,
  type CycleReceipt,
  type StrategyAttempt,
  type NoGainStopCondition,
} from '../../src/contracts/evidence-loop.js';
import { createAwknId } from '../../src/contracts/ids.js';
import { toUtcTimestamp } from '../../src/contracts/time.js';

const NOW = toUtcTimestamp('2026-07-28T10:00:00.000Z');
const RUN_ID = createAwknId('run');
const SHA256_EXAMPLE = 'b'.repeat(64);

function makeHypothesis(overrides: Partial<{ hypothesisId: string; statement: string; rationale: string; assumptions: string[]; falsifiable: boolean; confidence: number }> = {}) {
  return {
    schema: 'awkn-hypothesis/v1' as const,
    hypothesisId: 'hyp-1',
    statement: 'build failure is caused by missing migration',
    rationale: 'error log mentions schema mismatch',
    assumptions: ['migration v12 was not applied'],
    falsifiable: true,
    confidence: 0.7,
    ...overrides,
  };
}

function makeExpectedEvidence(overrides: Partial<{ expectedEvidenceId: string; description: string; sourceType: string; evaluatorId: string; successPredicate: Record<string, unknown>; required: boolean }> = {}) {
  return {
    schema: 'awkn-expected-evidence/v1' as const,
    expectedEvidenceId: 'ee-1',
    description: 'migration v12 applied successfully',
    sourceType: 'command' as const,
    evaluatorId: 'migration-checker',
    successPredicate: { exitCode: 0 },
    required: true,
    ...overrides,
  };
}

function makePlannedAction(overrides: Partial<{ actionId: string; toolId: string; description: string; producesEvidenceIds: string[]; fingerprint: string }> = {}) {
  return {
    actionId: 'act-1',
    toolId: 'shell.exec',
    description: 'run migration v12',
    producesEvidenceIds: ['ee-1'],
    fingerprint: 'migration-v12-run',
    ...overrides,
  };
}

function makeCycleBudget(overrides: Partial<{ maxTokens: number; maxDurationMs: number; maxCostUsd: number; consumedTokens: number; consumedDurationMs: number; consumedCostUsd: number }> = {}) {
  return {
    maxTokens: 100000,
    maxDurationMs: 60000,
    maxCostUsd: 0.5,
    consumedTokens: 0,
    consumedDurationMs: 0,
    consumedCostUsd: 0,
    ...overrides,
  };
}

function makeCyclePlan(overrides: Partial<EvidenceCyclePlan> = {}): EvidenceCyclePlan {
  return {
    schema: 'awkn-evidence-cycle-plan/v1',
    cycleId: 'cycle-1',
    runId: RUN_ID,
    cycleNumber: 1,
    objective: 'fix migration failure',
    hypothesis: makeHypothesis(),
    expectedEvidence: [makeExpectedEvidence()],
    plannedActions: [makePlannedAction()],
    selectedStrategy: 'apply-migration',
    policyBundleHash: SHA256_EXAMPLE,
    skillBundleHash: SHA256_EXAMPLE,
    contextManifestHash: SHA256_EXAMPLE,
    budgetSlice: makeCycleBudget(),
    createdAt: NOW,
    ...overrides,
  };
}

function makeCycleReceipt(overrides: Partial<CycleReceipt> = {}): CycleReceipt {
  return {
    schema: 'awkn-cycle-receipt/v1',
    receiptId: createAwknId('receipt'),
    runId: RUN_ID,
    cycle: 1,
    hypothesis: 'build failure is caused by missing migration',
    expectedEvidenceIds: ['ee-1'],
    actualEvidenceIds: [createAwknId('evidence')],
    deltaScore: 0.5,
    gainType: 'progress',
    strategyDecision: 'CONTINUE',
    tokens: 3200,
    durationMs: 18000,
    createdAt: NOW,
    ...overrides,
  };
}

function makeStrategyAttempt(overrides: Partial<StrategyAttempt> = {}): StrategyAttempt {
  return {
    schema: 'awkn-strategy-attempt/v1',
    strategyId: 'strat-1',
    hypothesis: 'test hypothesis',
    actionFingerprint: 'action-fp-1',
    resultFingerprint: 'result-fp-1',
    evidenceDeltaScore: 0.3,
    usedAt: NOW,
    ...overrides,
  };
}

describe('Evidence-Gain Loop Contract (C06)', () => {
  describe('enums', () => {
    it('accepts all nine deviation types', () => {
      for (const d of ['EXECUTION_ERROR', 'HYPOTHESIS_REJECTED', 'CONTEXT_GAP', 'AUTHORIZATION_GAP', 'CAPABILITY_GAP', 'ACCEPTANCE_MISMATCH', 'REPEATED_PATTERN', 'NO_EVIDENCE', 'REGRESSION'] as const) {
        assert.equal(DeviationTypeSchema.safeParse(d).success, true);
      }
    });

    it('accepts all six strategy decisions', () => {
      for (const s of ['CONTINUE', 'SWITCH', 'PAUSE', 'STOP', 'WAITING_USER', 'WAITING_AUTHORIZATION'] as const) {
        assert.equal(StrategyDecisionSchema.safeParse(s).success, true);
      }
    });
  });

  describe('Hypothesis', () => {
    it('accepts valid hypothesis', () => {
      assert.equal(HypothesisSchema.safeParse(makeHypothesis()).success, true);
    });

    it('rejects confidence out of range', () => {
      assert.equal(HypothesisSchema.safeParse(makeHypothesis({ confidence: 1.5 })).success, false);
    });
  });

  describe('ExpectedEvidence', () => {
    it('accepts valid expected evidence', () => {
      assert.equal(ExpectedEvidenceSchema.safeParse(makeExpectedEvidence()).success, true);
    });

    it('rejects required evidence with empty successPredicate', () => {
      assert.equal(
        ExpectedEvidenceSchema.safeParse(makeExpectedEvidence({ successPredicate: {} })).success,
        false,
      );
    });

    it('accepts non-required evidence with empty predicate', () => {
      assert.equal(
        ExpectedEvidenceSchema.safeParse(makeExpectedEvidence({ required: false, successPredicate: {} })).success,
        true,
      );
    });
  });

  describe('CycleBudget', () => {
    it('accepts valid budget', () => {
      assert.equal(CycleBudgetSchema.safeParse(makeCycleBudget()).success, true);
    });

    it('rejects consumed exceeding max tokens', () => {
      assert.equal(
        CycleBudgetSchema.safeParse(makeCycleBudget({ consumedTokens: 150000 })).success,
        false,
      );
    });

    it('rejects consumed exceeding max cost', () => {
      assert.equal(
        CycleBudgetSchema.safeParse(makeCycleBudget({ consumedCostUsd: 1.0 })).success,
        false,
      );
    });
  });

  describe('EvidenceCyclePlan', () => {
    it('accepts valid cycle plan', () => {
      assert.equal(EvidenceCyclePlanSchema.safeParse(makeCyclePlan()).success, true);
    });

    it('requires at least one expected evidence (test 1)', () => {
      assert.equal(
        EvidenceCyclePlanSchema.safeParse(makeCyclePlan({ expectedEvidence: [] })).success,
        false,
      );
    });

    it('requires at least one required expected evidence', () => {
      assert.equal(
        EvidenceCyclePlanSchema.safeParse(
          makeCyclePlan({ expectedEvidence: [makeExpectedEvidence({ required: false })] }),
        ).success,
        false,
      );
    });

    it('rejects planned action referencing unknown evidence id', () => {
      assert.equal(
        EvidenceCyclePlanSchema.safeParse(
          makeCyclePlan({
            plannedActions: [makePlannedAction({ producesEvidenceIds: ['unknown-ee'] })],
          }),
        ).success,
        false,
      );
    });
  });

  describe('CycleReceipt', () => {
    it('accepts valid receipt with positive delta and evidence', () => {
      assert.equal(CycleReceiptSchema.safeParse(makeCycleReceipt()).success, true);
    });

    it('rejects positive delta without actual evidence (test 2)', () => {
      assert.equal(
        CycleReceiptSchema.safeParse(
          makeCycleReceipt({ actualEvidenceIds: [], deltaScore: 0.3 }),
        ).success,
        false,
      );
    });

    it('accepts zero delta without evidence', () => {
      assert.equal(
        CycleReceiptSchema.safeParse(
          makeCycleReceipt({ actualEvidenceIds: [], deltaScore: 0, gainType: 'none', deviationType: 'NO_EVIDENCE' }),
        ).success,
        true,
      );
    });

    it('rejects regression gainType with positive delta', () => {
      assert.equal(
        CycleReceiptSchema.safeParse(
          makeCycleReceipt({ gainType: 'regression', deltaScore: 0.1 }),
        ).success,
        false,
      );
    });

    it('requires nextStrategy for SWITCH decision', () => {
      assert.equal(
        CycleReceiptSchema.safeParse(
          makeCycleReceipt({ strategyDecision: 'SWITCH' }),
        ).success,
        false,
      );
    });

    it('accepts SWITCH with nextStrategy', () => {
      assert.equal(
        CycleReceiptSchema.safeParse(
          makeCycleReceipt({ strategyDecision: 'SWITCH', nextStrategy: 'inspect-config' }),
        ).success,
        true,
      );
    });

    it('requires deviationType for none gainType', () => {
      assert.equal(
        CycleReceiptSchema.safeParse(
          makeCycleReceipt({ gainType: 'none', deltaScore: 0 }),
        ).success,
        false,
      );
    });
  });

  describe('NoGainStopCondition', () => {
    it('accepts non-triggered condition below threshold', () => {
      const cond = {
        schema: 'awkn-no-gain-stop-condition/v1' as const,
        conditionId: 'ngsc-1',
        consecutiveLowDeltaCycles: 2,
        consecutiveSameActionCycles: 1,
        consecutiveSameErrorCycles: 0,
        triggered: false,
      };
      assert.equal(NoGainStopConditionSchema.safeParse(cond).success, true);
    });

    it('accepts triggered condition at threshold with reason', () => {
      const cond = {
        schema: 'awkn-no-gain-stop-condition/v1' as const,
        conditionId: 'ngsc-2',
        consecutiveLowDeltaCycles: 3,
        consecutiveSameActionCycles: 0,
        consecutiveSameErrorCycles: 0,
        triggered: true,
        reason: 'no-gain threshold reached',
      };
      assert.equal(NoGainStopConditionSchema.safeParse(cond).success, true);
    });

    it('rejects triggered without reason', () => {
      const cond = {
        schema: 'awkn-no-gain-stop-condition/v1' as const,
        conditionId: 'ngsc-3',
        consecutiveLowDeltaCycles: 3,
        consecutiveSameActionCycles: 0,
        consecutiveSameErrorCycles: 0,
        triggered: true,
      };
      assert.equal(NoGainStopConditionSchema.safeParse(cond).success, false);
    });

    it('rejects mismatched triggered flag', () => {
      const cond = {
        schema: 'awkn-no-gain-stop-condition/v1' as const,
        conditionId: 'ngsc-4',
        consecutiveLowDeltaCycles: 3,
        consecutiveSameActionCycles: 0,
        consecutiveSameErrorCycles: 0,
        triggered: false,
      };
      assert.equal(NoGainStopConditionSchema.safeParse(cond).success, false);
    });
  });

  describe('assessStrategySwitch', () => {
    it('returns no switch for empty attempts', () => {
      const result = assessStrategySwitch([], 0.5);
      assert.equal(result.shouldSwitch, false);
    });

    it('detects repeated action fingerprint [ACTION] (PR1 P2-1: 来源标记 + 禁止低增益顺带通过)', () => {
      // 构造只触发 ACTION 重复、不触发其他低增益条件的 attempts：
      // - actionFingerprint 相同 → 触发 'repeated action fingerprint [ACTION]'
      // - evidenceDeltaScore > 0 → 不触发 'consecutive low delta cycles' 和 'current hypothesis rejected'
      // - currentDeltaScore > 0 → 不触发 'current delta score non-positive'
      // - failureType undefined → 不触发 'repeated failure type'
      const attempts: StrategyAttempt[] = [
        makeStrategyAttempt({ actionFingerprint: 'fp-A', evidenceDeltaScore: 0.5 }),
        makeStrategyAttempt({ actionFingerprint: 'fp-A', evidenceDeltaScore: 0.4 }),
      ];
      const result = assessStrategySwitch(attempts, 0.3);
      assert.equal(result.shouldSwitch, true);
      // 断言 [ACTION] 来源标记存在
      assert.ok(result.reasons.some((r) => r.includes('[ACTION]')), 'reasons 应含 [ACTION] 来源标记');
      // 断言只有 1 个 reason，禁止其他低增益条件顺带通过
      assert.equal(result.reasons.length, 1, '应只有 1 个 reason（ACTION 重复），无其他低增益条件顺带通过');
      assert.ok(result.reasons[0]!.includes('repeated action fingerprint'), 'reason 应为 repeated action fingerprint');
    });

    it('detects repeated failure type [ERROR] (PR1 P2-1: 来源标记 + 禁止低增益顺带通过)', () => {
      // 构造只触发 ERROR 重复、不触发其他低增益条件的 attempts：
      // - failureType 相同（EXECUTION_ERROR）→ 触发 'repeated failure type: EXECUTION_ERROR [ERROR]'
      // - actionFingerprint 不同 → 不触发 'repeated action fingerprint'
      // - evidenceDeltaScore > 0 → 不触发 'consecutive low delta cycles' 和 'current hypothesis rejected'
      // - currentDeltaScore > 0 → 不触发 'current delta score non-positive'
      // - failureType 为 EXECUTION_ERROR（非 HYPOTHESIS_REJECTED/REGRESSION）→ 不触发 'current hypothesis rejected'
      const attempts: StrategyAttempt[] = [
        makeStrategyAttempt({ actionFingerprint: 'fp-A', failureType: 'EXECUTION_ERROR', evidenceDeltaScore: 0.5 }),
        makeStrategyAttempt({ actionFingerprint: 'fp-B', failureType: 'EXECUTION_ERROR', evidenceDeltaScore: 0.4 }),
      ];
      const result = assessStrategySwitch(attempts, 0.3);
      assert.equal(result.shouldSwitch, true);
      // 断言 [ERROR] 来源标记存在
      assert.ok(result.reasons.some((r) => r.includes('[ERROR]')), 'reasons 应含 [ERROR] 来源标记');
      // 断言只有 1 个 reason，禁止其他低增益条件顺带通过
      assert.equal(result.reasons.length, 1, '应只有 1 个 reason（ERROR 重复），无其他低增益条件顺带通过');
      assert.ok(result.reasons[0]!.includes('repeated failure type'), 'reason 应为 repeated failure type');
      // 不应含 [ACTION] 标记
      assert.ok(!result.reasons.some((r) => r.includes('[ACTION]')), '不应含 [ACTION] 来源标记');
    });

    it('detects hypothesis rejected', () => {
      const attempts: StrategyAttempt[] = [
        makeStrategyAttempt({ failureType: 'HYPOTHESIS_REJECTED', evidenceDeltaScore: -0.3 }),
      ];
      const result = assessStrategySwitch(attempts, -0.3);
      assert.equal(result.shouldSwitch, true);
    });
  });

  describe('evaluateNoGainStop', () => {
    it('returns non-triggered below threshold', () => {
      const receipts: CycleReceipt[] = [
        makeCycleReceipt({ deltaScore: 0.5 }),
        makeCycleReceipt({ deltaScore: 0.3 }),
      ];
      const result = evaluateNoGainStop(receipts, []);
      assert.equal(result.triggered, false);
    });

    it('triggers after 3 consecutive low-delta cycles', () => {
      const receipts: CycleReceipt[] = [
        makeCycleReceipt({ deltaScore: 0.5 }),
        makeCycleReceipt({ deltaScore: 0 }),
        makeCycleReceipt({ deltaScore: 0 }),
        makeCycleReceipt({ deltaScore: 0 }),
      ];
      const result = evaluateNoGainStop(receipts, []);
      assert.equal(result.triggered, true);
      assert.ok(result.consecutiveLowDeltaCycles >= 3);
    });

    it('triggers after 3 consecutive same action fingerprints', () => {
      const attempts: StrategyAttempt[] = [
        makeStrategyAttempt({ actionFingerprint: 'fp-X' }),
        makeStrategyAttempt({ actionFingerprint: 'fp-X' }),
        makeStrategyAttempt({ actionFingerprint: 'fp-X' }),
      ];
      const result = evaluateNoGainStop([], attempts);
      assert.equal(result.triggered, true);
    });
  });

  describe('hash computation', () => {
    it('produces stable plan hash', () => {
      const plan = makeCyclePlan();
      const { cycleId: _c, createdAt: _t, ...content } = plan;
      void _c; void _t;
      const h1 = computeEvidenceCyclePlanHash(content);
      const h2 = computeEvidenceCyclePlanHash(content);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{64}$/);
    });

    it('produces stable receipt hash', () => {
      const receipt = makeCycleReceipt();
      const { receiptId: _r, createdAt: _t, ...content } = receipt;
      void _r; void _t;
      const h1 = computeCycleReceiptHash(content);
      const h2 = computeCycleReceiptHash(content);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{64}$/);
    });
  });
});
