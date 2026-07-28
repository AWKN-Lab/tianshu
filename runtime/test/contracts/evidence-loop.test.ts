/**
 * Evidence-Gain Loop Contract Tests (Phase 6 / C06 / WP-AOS-11)
 *
 * 设计文档: `docs/agent-os-3.0/07-Evidence-Gain-Loop.md`
 *
 * 覆盖设计文档第十三节测试要求 1-10 + 额外测试:
 *  1. 每轮开始前存在 Expected Evidence
 *  2. 无新增证据不能生成正 Delta
 *  3. 根因确认可生成有效 Delta
 *  4. 同一动作重复触发 Strategy Switch
 *  5. 同一错误重复达到阈值后停止
 *  6. Context Gap 可返回 Context Planner
 *  7. Capability Gap 可请求 Broker 切换
 *  8. Regression 触发回滚或隔离
 *  9. Goal 达成需要 Evidence 与 Gate 同时通过
 * 10. Run 恢复不会重复已确认副作用
 * 11. Delta Score 计算正确性
 * 12. 偏差分类正确性
 * 13. No-Gain 停止判定
 * 14. Cycle Receipt schema 验证
 * 15. Cycle Plan Hash 稳定性
 * 16. EvidenceCyclePlan schema 校验 (额外)
 * 17. Authorization Gap 返回 PAUSE (额外)
 * 18. Acceptance Mismatch 返回 CONTINUE (额外)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CycleReceiptSchema,
  CycleBudgetSchema,
  EvidenceCyclePlanSchema,
  EvidenceDeltaSchema,
  ExpectedEvidenceSchema,
  StrategyAttemptSchema,
  DeviationTypeSchema,
  StrategyDecisionSchema,
  computeCyclePlanHash,
  createCycleId,
  type EvidenceCyclePlan,
  type ExpectedEvidence,
  type PlannedAction,
  type CycleBudget,
  type StrategyAttempt,
} from '../../src/contracts/evidence-loop.js';
import { createAwknId } from '../../src/contracts/ids.js';
import {
  buildCyclePlan,
  CyclePlannerError,
  deriveExpectedEvidenceFromGoal,
  newRunId,
  sliceCycleBudget,
} from '../../src/loop/cycle-planner.js';
import {
  calculateEvidenceDelta,
  DELTA_CALCULATOR_VERSION,
  DELTA_WEIGHTS,
  EvidenceDeltaError,
} from '../../src/loop/evidence-delta.js';
import {
  defaultStrategyDecision,
  diagnoseDeviation,
  DeviationDiagnoserError,
} from '../../src/loop/deviation.js';
import {
  buildStrategyAttempt,
  DEFAULT_SWITCHER_CONFIG,
  StrategySwitcher,
} from '../../src/loop/strategy-switcher.js';
import {
  assessStop,
  DEFAULT_STOP_CONFIG,
  isGoalAchieved,
} from '../../src/loop/stop-controller.js';
import {
  createEvidenceLoop,
  EvidenceLoop,
  EvidenceLoopError,
} from '../../src/loop/evidence-loop.js';
import type { GoalSpec } from '../../src/contracts/goal.js';

// ============================================================================
// Fixtures
// ============================================================================

const NOW = '2026-07-28T10:00:00.000Z';
const RUN_ID = createAwknId('run');
const EXECUTION_ID = createAwknId('execution');
const SHA256_HEX = 'a'.repeat(64);

function makeCycleBudget(overrides: Partial<CycleBudget> = {}): CycleBudget {
  return {
    schema: 'awkn-cycle-budget/v1',
    maxCycles: 10,
    maxTokens: 10000,
    maxDurationMs: 60000,
    reservedTokens: 0,
    ...overrides,
  };
}

function makeExpectedEvidence(overrides: Partial<ExpectedEvidence> = {}): ExpectedEvidence {
  return {
    expectedEvidenceId: 'ee_test_1',
    description: 'test output matches expectation',
    sourceType: 'command',
    evaluatorId: 'eval_test_1',
    successPredicate: { exitCode: 0 },
    required: true,
    ...overrides,
  };
}

function makePlannedAction(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    actionId: 'pa_test_1',
    description: 'run test suite',
    toolId: 'shell',
    actionFingerprint: 'fp_action_1',
    expectedEvidenceId: 'ee_test_1',
    ...overrides,
  };
}

function makeCyclePlanInput(overrides: Partial<Parameters<typeof buildCyclePlan>[0]> = {}): Parameters<typeof buildCyclePlan>[0] {
  return {
    runId: RUN_ID,
    cycleNumber: 1,
    objective: 'verify build passes',
    hypothesis: 'tests pass after fix',
    selectedStrategy: 'fix-and-test',
    expectedEvidence: [makeExpectedEvidence()],
    plannedActions: [makePlannedAction()],
    policyBundleHash: SHA256_HEX,
    skillBundleHash: SHA256_HEX,
    contextManifestHash: SHA256_HEX,
    budgetSlice: makeCycleBudget(),
    ...overrides,
  };
}

/**
 * 构造一个"原始" EvidenceCyclePlan 对象（不经过 buildCyclePlan 校验）。
 *
 * 用于测试 schema 层的校验逻辑（superRefine），避免 buildCyclePlan 提前抛错
 * 导致 safeParse 无法被测到。调用方可覆盖任意字段以构造非法 plan。
 */
function makeRawCyclePlan(overrides: Partial<EvidenceCyclePlan> = {}): EvidenceCyclePlan {
  return {
    schema: 'awkn-evidence-cycle-plan/v1',
    cycleId: createCycleId(),
    runId: RUN_ID,
    cycleNumber: 1,
    objective: 'verify build passes',
    hypothesis: 'tests pass after fix',
    expectedEvidence: [makeExpectedEvidence()],
    plannedActions: [makePlannedAction()],
    selectedStrategy: 'fix-and-test',
    policyBundleHash: SHA256_HEX,
    skillBundleHash: SHA256_HEX,
    contextManifestHash: SHA256_HEX,
    budgetSlice: makeCycleBudget(),
    ...overrides,
  };
}

function makeGoalSpec(overrides: Partial<GoalSpec> = {}): GoalSpec {
  return {
    schema: 'awkn-goal-spec/v3',
    goalId: createAwknId('goal'),
    title: 'test goal',
    desiredState: {
      description: 'build passes',
      successSignals: ['all tests pass'],
    },
    scope: {
      included: ['src/**'],
      excluded: [],
    },
    acceptanceCriteria: [
      {
        criterionId: 'ac_1',
        description: 'tests pass',
        required: true,
        evaluator: 'deterministic',
        evidenceSourceIds: ['es_1'],
      },
    ],
    evidenceSources: [
      {
        sourceId: 'es_1',
        sourceType: 'test',
        required: true,
        minimumLevel: 2,
        freshnessClass: 'REAL_TIME',
      },
    ],
    constraints: [],
    assumptions: [],
    budget: {
      maxCycles: 10,
      maxTokens: 100000,
      maxDurationMs: 600000,
    },
    stopPolicy: {
      noGainCycleLimit: 3,
      onBudgetExceeded: 'FAIL',
      onBlocked: 'PAUSE',
      onUncertain: 'CONTINUE',
    },
    judgePolicy: {
      judgeVersion: 'v1',
      minimumEvidenceLevel: 2,
      requireAllAcceptanceCriteria: true,
      requireAllHardConstraints: true,
      requiredGateTypes: ['testGate'],
    },
    deliveryExpectation: {
      modes: ['CHAT'],
      primaryMode: 'CHAT',
      successPredicate: { delivered: true },
    },
    taskProfile: 'engineering',
    riskLevel: 'R2',
    createdBy: {
      schema: 'awkn-actor-ref/v1',
      actorId: 'user-1',
      actorType: 'human',
      projectId: 'proj-1',
    },
    createdAt: NOW,
    ...overrides,
  };
}

// ============================================================================
// Section 1: Schema 验证测试
// ============================================================================

describe('Evidence-Gain Loop: Schema 验证', () => {
  describe('CycleBudgetSchema', () => {
    it('validates a valid cycle budget', () => {
      const budget = makeCycleBudget();
      const result = CycleBudgetSchema.safeParse(budget);
      assert.equal(result.success, true);
    });

    it('rejects budget with negative tokens', () => {
      const result = CycleBudgetSchema.safeParse({
        ...makeCycleBudget(),
        maxTokens: -1,
      });
      assert.equal(result.success, false);
    });

    it('rejects budget with zero maxCycles', () => {
      const result = CycleBudgetSchema.safeParse({
        ...makeCycleBudget(),
        maxCycles: 0,
      });
      assert.equal(result.success, false);
    });
  });

  describe('ExpectedEvidenceSchema', () => {
    it('validates a valid expected evidence', () => {
      const result = ExpectedEvidenceSchema.safeParse(makeExpectedEvidence());
      assert.equal(result.success, true);
    });

    it('rejects evidence without required field', () => {
      const result = ExpectedEvidenceSchema.safeParse({
        ...makeExpectedEvidence(),
        required: undefined,
      });
      assert.equal(result.success, false);
    });
  });

  describe('EvidenceCyclePlanSchema (测试 1: 每轮开始前存在 Expected Evidence)', () => {
    it('validates a valid cycle plan with required expected evidence', () => {
      const plan = buildCyclePlan(makeCyclePlanInput());
      const result = EvidenceCyclePlanSchema.safeParse(plan);
      assert.equal(result.success, true, `should validate: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
    });

    it('rejects cycle plan with empty expectedEvidence (测试 1)', () => {
      const plan = buildCyclePlan(makeCyclePlanInput({ expectedEvidence: [makeExpectedEvidence()] }));
      const result = EvidenceCyclePlanSchema.safeParse({
        ...plan,
        expectedEvidence: [],
      });
      assert.equal(result.success, false);
    });

    it('rejects cycle plan where no expected evidence is required (测试 1)', () => {
      // 直接构造 raw plan（绕过 buildCyclePlan 的校验）以测试 schema 层 superRefine
      const result = EvidenceCyclePlanSchema.safeParse(makeRawCyclePlan({
        expectedEvidence: [makeExpectedEvidence({ required: false })],
      }));
      assert.equal(result.success, false);
    });

    it('rejects cycle plan with duplicate actionFingerprint', () => {
      const action = makePlannedAction();
      // 直接构造 raw plan，包含两个相同 actionFingerprint 的动作
      const result = EvidenceCyclePlanSchema.safeParse(makeRawCyclePlan({
        plannedActions: [action, { ...action, actionId: 'pa_2' }],
      }));
      assert.equal(result.success, false);
    });

    it('rejects cycle plan with plannedAction referencing unknown expectedEvidenceId', () => {
      // 直接构造 raw plan，plannedAction 引用不存在的 expectedEvidenceId
      const result = EvidenceCyclePlanSchema.safeParse(makeRawCyclePlan({
        plannedActions: [makePlannedAction({ expectedEvidenceId: 'ee_unknown' })],
      }));
      assert.equal(result.success, false);
    });
  });

  describe('EvidenceDeltaSchema', () => {
    it('validates a valid delta', () => {
      const delta = calculateEvidenceDelta({
        cycleId: createCycleId(),
        uncertaintyBefore: 0.8,
        uncertaintyAfter: 0.5,
        acceptanceProgressBefore: 0.3,
        acceptanceProgressAfter: 0.6,
        addedEvidenceIds: [createAwknId('evidence')],
        removedOrInvalidatedEvidenceIds: [],
        confirmedClaimIds: [],
        disputedClaimIds: [],
        strategyEliminated: false,
        riskReduced: false,
        regression: false,
        rootCauseConfirmed: false,
        constraintDiscovered: false,
      });
      const result = EvidenceDeltaSchema.safeParse(delta);
      assert.equal(result.success, true);
    });

    it('rejects positive delta when no new evidence and gainType is none (测试 2)', () => {
      const result = EvidenceDeltaSchema.safeParse({
        schema: 'awkn-evidence-delta/v1',
        cycleId: createCycleId(),
        addedEvidenceIds: [],
        removedOrInvalidatedEvidenceIds: [],
        confirmedClaimIds: [],
        disputedClaimIds: [],
        uncertaintyBefore: 0.5,
        uncertaintyAfter: 0.5,
        acceptanceProgressBefore: 0.5,
        acceptanceProgressAfter: 0.5,
        deltaScore: 0.3,
        gainType: 'none',
      });
      assert.equal(result.success, false);
    });

    it('allows positive delta with no new evidence when gainType is root_cause (测试 3)', () => {
      const result = EvidenceDeltaSchema.safeParse({
        schema: 'awkn-evidence-delta/v1',
        cycleId: createCycleId(),
        addedEvidenceIds: [],
        removedOrInvalidatedEvidenceIds: [],
        confirmedClaimIds: [],
        disputedClaimIds: [],
        uncertaintyBefore: 0.5,
        uncertaintyAfter: 0.5,
        acceptanceProgressBefore: 0.5,
        acceptanceProgressAfter: 0.5,
        deltaScore: 0.1,
        gainType: 'root_cause',
      });
      assert.equal(result.success, true);
    });

    it('rejects regression gainType with positive deltaScore', () => {
      const result = EvidenceDeltaSchema.safeParse({
        schema: 'awkn-evidence-delta/v1',
        cycleId: createCycleId(),
        addedEvidenceIds: [createAwknId('evidence')],
        removedOrInvalidatedEvidenceIds: [],
        confirmedClaimIds: [],
        disputedClaimIds: [],
        uncertaintyBefore: 0.5,
        uncertaintyAfter: 0.5,
        acceptanceProgressBefore: 0.5,
        acceptanceProgressAfter: 0.5,
        deltaScore: 0.5,
        gainType: 'regression',
      });
      assert.equal(result.success, false);
    });
  });

  describe('StrategyAttemptSchema', () => {
    it('validates a valid strategy attempt', () => {
      const attempt = buildStrategyAttempt({
        strategyId: 's1',
        hypothesis: 'h1',
        actionFingerprint: 'fp1',
        resultFingerprint: 'rfp1',
        evidenceDeltaScore: 0.5,
        usedAt: NOW,
      });
      const result = StrategyAttemptSchema.safeParse(attempt);
      assert.equal(result.success, true);
    });
  });

  describe('CycleReceiptSchema (测试 14: Cycle Receipt schema 验证)', () => {
    it('validates a valid cycle receipt', () => {
      const receipt = {
        schema: 'awkn-cycle-receipt/v1' as const,
        receiptId: createAwknId('receipt'),
        runId: RUN_ID,
        cycleId: createCycleId(),
        cycle: 1,
        hypothesis: 'tests pass',
        expectedEvidenceIds: ['ee_1'],
        actualEvidenceIds: [createAwknId('evidence')],
        deltaScore: 0.5,
        deviationType: 'EXECUTION_ERROR' as const,
        strategyDecision: 'CONTINUE' as const,
        tokens: 1000,
        durationMs: 5000,
        createdAt: NOW,
      };
      const result = CycleReceiptSchema.safeParse(receipt);
      assert.equal(result.success, true);
    });

    it('rejects receipt with CONTINUE decision carrying nextStrategy', () => {
      const receipt = {
        schema: 'awkn-cycle-receipt/v1' as const,
        receiptId: createAwknId('receipt'),
        runId: RUN_ID,
        cycleId: createCycleId(),
        cycle: 1,
        hypothesis: 'tests pass',
        expectedEvidenceIds: ['ee_1'],
        actualEvidenceIds: [],
        deltaScore: 0,
        deviationType: 'NO_EVIDENCE' as const,
        strategyDecision: 'CONTINUE' as const,
        nextStrategy: 'should-not-be-here',
        tokens: 1000,
        durationMs: 5000,
        createdAt: NOW,
      };
      const result = CycleReceiptSchema.safeParse(receipt);
      assert.equal(result.success, false);
    });
  });
});

// ============================================================================
// Section 2: Delta Score 计算正确性 (测试 11)
// ============================================================================

describe('测试 11: Delta Score 计算正确性', () => {
  it('计算公式符合设计文档 5.1', () => {
    // acceptanceProgressDelta = 0.4, uncertaintyReduction = 0.3, newEvidence = 1, strategyElim = 1, riskRed = 1, regression = 0
    // rawDelta = 0.35*0.4 + 0.25*0.3 + 0.20*1 + 0.10*1 + 0.10*1 - 0.30*0
    //          = 0.14 + 0.075 + 0.20 + 0.10 + 0.10 - 0
    //          = 0.615
    const delta = calculateEvidenceDelta({
      cycleId: createCycleId(),
      uncertaintyBefore: 0.7,
      uncertaintyAfter: 0.4,
      acceptanceProgressBefore: 0.2,
      acceptanceProgressAfter: 0.6,
      addedEvidenceIds: [createAwknId('evidence')],
      removedOrInvalidatedEvidenceIds: [],
      confirmedClaimIds: [],
      disputedClaimIds: [],
      strategyEliminated: true,
      riskReduced: true,
      regression: false,
      rootCauseConfirmed: false,
      constraintDiscovered: false,
    });
    assert.equal(delta.gainType, 'progress');
    const expected = DELTA_WEIGHTS.acceptanceProgress * 0.4
      + DELTA_WEIGHTS.uncertaintyReduction * 0.3
      + DELTA_WEIGHTS.newVerifiedEvidence * 1
      + DELTA_WEIGHTS.strategyElimination * 1
      + DELTA_WEIGHTS.riskReduction * 1
      + DELTA_WEIGHTS.regression * 0;
    assert.ok(Math.abs(delta.deltaScore - expected) < 1e-9, `deltaScore=${delta.deltaScore} expected=${expected}`);
  });

  it('无新增证据且无根因确认时 deltaScore <= 0 (测试 2: fail-closed)', () => {
    const delta = calculateEvidenceDelta({
      cycleId: createCycleId(),
      uncertaintyBefore: 0.5,
      uncertaintyAfter: 0.4,  // uncertaintyReduction = 0.1
      acceptanceProgressBefore: 0.3,
      acceptanceProgressAfter: 0.4,  // acceptanceProgressDelta = 0.1
      addedEvidenceIds: [],
      removedOrInvalidatedEvidenceIds: [],
      confirmedClaimIds: [],
      disputedClaimIds: [],
      strategyEliminated: false,
      riskReduced: false,
      regression: false,
      rootCauseConfirmed: false,
      constraintDiscovered: false,
    });
    // rawDelta = 0.35*0.1 + 0.25*0.1 + 0 + 0 + 0 - 0 = 0.06, but fail-closed → <= 0
    assert.ok(delta.deltaScore <= 0, `deltaScore should be <= 0, got ${delta.deltaScore}`);
    assert.equal(delta.gainType, 'none');
  });

  it('根因确认可在无新证据时生成正 Delta (测试 3)', () => {
    const delta = calculateEvidenceDelta({
      cycleId: createCycleId(),
      uncertaintyBefore: 0.5,
      uncertaintyAfter: 0.5,
      acceptanceProgressBefore: 0.3,
      acceptanceProgressAfter: 0.3,
      addedEvidenceIds: [],
      removedOrInvalidatedEvidenceIds: [],
      confirmedClaimIds: [],
      disputedClaimIds: [],
      strategyEliminated: false,
      riskReduced: false,
      regression: false,
      rootCauseConfirmed: true,
      constraintDiscovered: false,
    });
    assert.ok(delta.deltaScore > 0, `root_cause should produce positive delta, got ${delta.deltaScore}`);
    assert.equal(delta.gainType, 'root_cause');
  });

  it('策略排除可在无新证据时生成正 Delta', () => {
    const delta = calculateEvidenceDelta({
      cycleId: createCycleId(),
      uncertaintyBefore: 0.5,
      uncertaintyAfter: 0.5,
      acceptanceProgressBefore: 0.3,
      acceptanceProgressAfter: 0.3,
      addedEvidenceIds: [],
      removedOrInvalidatedEvidenceIds: [],
      confirmedClaimIds: [],
      disputedClaimIds: [],
      strategyEliminated: true,
      riskReduced: false,
      regression: false,
      rootCauseConfirmed: false,
      constraintDiscovered: false,
    });
    assert.ok(delta.deltaScore > 0, `strategy_elimination should produce positive delta, got ${delta.deltaScore}`);
    assert.equal(delta.gainType, 'strategy_elimination');
  });

  it('约束发现可在无新证据时生成正 Delta', () => {
    const delta = calculateEvidenceDelta({
      cycleId: createCycleId(),
      uncertaintyBefore: 0.5,
      uncertaintyAfter: 0.5,
      acceptanceProgressBefore: 0.3,
      acceptanceProgressAfter: 0.3,
      addedEvidenceIds: [],
      removedOrInvalidatedEvidenceIds: [],
      confirmedClaimIds: [],
      disputedClaimIds: [],
      strategyEliminated: false,
      riskReduced: false,
      regression: false,
      rootCauseConfirmed: false,
      constraintDiscovered: true,
    });
    assert.ok(delta.deltaScore > 0, `constraint_discovery should produce positive delta, got ${delta.deltaScore}`);
    assert.equal(delta.gainType, 'constraint_discovery');
  });

  it('Regression 强制 deltaScore <= 0', () => {
    const delta = calculateEvidenceDelta({
      cycleId: createCycleId(),
      uncertaintyBefore: 0.5,
      uncertaintyAfter: 0.5,
      acceptanceProgressBefore: 0.3,
      acceptanceProgressAfter: 0.6,  // would normally be positive
      addedEvidenceIds: [createAwknId('evidence')],
      removedOrInvalidatedEvidenceIds: [],
      confirmedClaimIds: [],
      disputedClaimIds: [],
      strategyEliminated: false,
      riskReduced: false,
      regression: true,
      rootCauseConfirmed: false,
      constraintDiscovered: false,
    });
    assert.ok(delta.deltaScore <= 0, `regression should force deltaScore <= 0, got ${delta.deltaScore}`);
    assert.equal(delta.gainType, 'regression');
  });

  it('rejects out-of-range uncertainty with EvidenceDeltaError', () => {
    assert.throws(
      () => calculateEvidenceDelta({
        cycleId: createCycleId(),
        uncertaintyBefore: 1.5,
        uncertaintyAfter: 0.5,
        acceptanceProgressBefore: 0.3,
        acceptanceProgressAfter: 0.3,
        addedEvidenceIds: [],
        removedOrInvalidatedEvidenceIds: [],
        confirmedClaimIds: [],
        disputedClaimIds: [],
        strategyEliminated: false,
        riskReduced: false,
        regression: false,
        rootCauseConfirmed: false,
        constraintDiscovered: false,
      }),
      EvidenceDeltaError,
    );
  });
});

// ============================================================================
// Section 3: 偏差分类正确性 (测试 12)
// ============================================================================

describe('测试 12: 偏差分类正确性', () => {
  it('REPEATED_PATTERN 优先级最高', () => {
    const deviation = diagnoseDeviation({
      executionFailed: true,
      repeatedPattern: true,
      contextMissing: true,
      authorizationDenied: true,
      capabilityInsufficient: true,
      regression: true,
      hasNewEvidence: false,
      hypothesisRejected: true,
      acceptanceMismatch: true,
    });
    assert.equal(deviation, 'REPEATED_PATTERN');
  });

  it('REGRESSION 优先于其他（除 REPEATED_PATTERN）', () => {
    const deviation = diagnoseDeviation({
      executionFailed: true,
      repeatedPattern: false,
      contextMissing: true,
      authorizationDenied: true,
      capabilityInsufficient: true,
      regression: true,
      hasNewEvidence: false,
      hypothesisRejected: true,
      acceptanceMismatch: true,
    });
    assert.equal(deviation, 'REGRESSION');
  });

  it('AUTHORIZATION_GAP 在 CAPABILITY_GAP 之前 (测试 17)', () => {
    const deviation = diagnoseDeviation({
      executionFailed: false,
      repeatedPattern: false,
      contextMissing: false,
      authorizationDenied: true,
      capabilityInsufficient: true,
      regression: false,
      hasNewEvidence: true,
      hypothesisRejected: false,
      acceptanceMismatch: false,
    });
    assert.equal(deviation, 'AUTHORIZATION_GAP');
    assert.equal(defaultStrategyDecision(deviation), 'PAUSE');
  });

  it('CAPABILITY_GAP 返回 SWITCH (测试 7: 可请求 Broker 切换)', () => {
    const deviation = diagnoseDeviation({
      executionFailed: false,
      repeatedPattern: false,
      contextMissing: false,
      authorizationDenied: false,
      capabilityInsufficient: true,
      regression: false,
      hasNewEvidence: true,
      hypothesisRejected: false,
      acceptanceMismatch: false,
    });
    assert.equal(deviation, 'CAPABILITY_GAP');
    assert.equal(defaultStrategyDecision(deviation), 'SWITCH');
  });

  it('CONTEXT_GAP 返回 PAUSE (测试 6: 可返回 Context Planner)', () => {
    const deviation = diagnoseDeviation({
      executionFailed: false,
      repeatedPattern: false,
      contextMissing: true,
      authorizationDenied: false,
      capabilityInsufficient: false,
      regression: false,
      hasNewEvidence: true,
      hypothesisRejected: false,
      acceptanceMismatch: false,
    });
    assert.equal(deviation, 'CONTEXT_GAP');
    assert.equal(defaultStrategyDecision(deviation), 'PAUSE');
  });

  it('EXECUTION_ERROR 当执行失败且无其他信号', () => {
    const deviation = diagnoseDeviation({
      executionFailed: true,
      repeatedPattern: false,
      contextMissing: false,
      authorizationDenied: false,
      capabilityInsufficient: false,
      regression: false,
      hasNewEvidence: false,
      hypothesisRejected: false,
      acceptanceMismatch: false,
    });
    assert.equal(deviation, 'EXECUTION_ERROR');
    assert.equal(defaultStrategyDecision(deviation), 'CONTINUE');
  });

  it('HYPOTHESIS_REJECTED 当证据推翻假设', () => {
    const deviation = diagnoseDeviation({
      executionFailed: false,
      repeatedPattern: false,
      contextMissing: false,
      authorizationDenied: false,
      capabilityInsufficient: false,
      regression: false,
      hasNewEvidence: true,
      hypothesisRejected: true,
      acceptanceMismatch: false,
    });
    assert.equal(deviation, 'HYPOTHESIS_REJECTED');
    assert.equal(defaultStrategyDecision(deviation), 'SWITCH');
  });

  it('NO_EVIDENCE 当执行成功但无新证据', () => {
    const deviation = diagnoseDeviation({
      executionFailed: false,
      repeatedPattern: false,
      contextMissing: false,
      authorizationDenied: false,
      capabilityInsufficient: false,
      regression: false,
      hasNewEvidence: false,
      hypothesisRejected: false,
      acceptanceMismatch: false,
    });
    assert.equal(deviation, 'NO_EVIDENCE');
    assert.equal(defaultStrategyDecision(deviation), 'PAUSE');
  });

  it('ACCEPTANCE_MISMATCH 当执行成功有证据但未通过验收 (测试 18)', () => {
    const deviation = diagnoseDeviation({
      executionFailed: false,
      repeatedPattern: false,
      contextMissing: false,
      authorizationDenied: false,
      capabilityInsufficient: false,
      regression: false,
      hasNewEvidence: true,
      hypothesisRejected: false,
      acceptanceMismatch: true,
    });
    assert.equal(deviation, 'ACCEPTANCE_MISMATCH');
    assert.equal(defaultStrategyDecision(deviation), 'CONTINUE');
  });

  it('fail-closed: 未知情况归为 EXECUTION_ERROR', () => {
    // 所有信号都为 false / 默认值，且 hasNewEvidence=true（避免 NO_EVIDENCE）
    const deviation = diagnoseDeviation({
      executionFailed: false,
      repeatedPattern: false,
      contextMissing: false,
      authorizationDenied: false,
      capabilityInsufficient: false,
      regression: false,
      hasNewEvidence: true,
      hypothesisRejected: false,
      acceptanceMismatch: false,
    });
    assert.equal(deviation, 'EXECUTION_ERROR');
  });
});

// ============================================================================
// Section 4: Strategy Switcher (测试 4)
// ============================================================================

describe('测试 4: 同一动作重复触发 Strategy Switch', () => {
  it('同一 actionFingerprint 第 2 次出现触发 SWITCH', () => {
    const switcher = new StrategySwitcher();
    const attempt1 = buildStrategyAttempt({
      strategyId: 's1',
      hypothesis: 'h1',
      actionFingerprint: 'fp_A',
      resultFingerprint: 'rfp_1',
      evidenceDeltaScore: 0.5,
      usedAt: NOW,
    });
    switcher.recordAttempt(attempt1);

    const assessment = switcher.assess({ nextActionFingerprint: 'fp_A' });
    assert.equal(assessment.shouldSwitch, true);
    assert.equal(assessment.reason, 'ACTION_FINGERPRINT_REPEAT');
  });

  it('不同 actionFingerprint 不触发 SWITCH', () => {
    const switcher = new StrategySwitcher();
    const attempt = buildStrategyAttempt({
      strategyId: 's1',
      hypothesis: 'h1',
      actionFingerprint: 'fp_A',
      resultFingerprint: 'rfp_1',
      evidenceDeltaScore: 0.5,
      usedAt: NOW,
    });
    switcher.recordAttempt(attempt);

    const assessment = switcher.assess({ nextActionFingerprint: 'fp_B' });
    assert.equal(assessment.shouldSwitch, false);
  });

  it('同一 errorFingerprint 达到阈值触发 SWITCH', () => {
    const switcher = new StrategySwitcher();
    const attempt1 = buildStrategyAttempt({
      strategyId: 's1',
      hypothesis: 'h1',
      actionFingerprint: 'fp_A',
      resultFingerprint: 'rfp_1',
      evidenceDeltaScore: -0.2,
      failureType: 'err_timeout',
      usedAt: NOW,
    });
    switcher.recordAttempt(attempt1);

    const assessment = switcher.assess({ nextErrorFingerprint: 'err_timeout' });
    assert.equal(assessment.shouldSwitch, true);
    assert.equal(assessment.reason, 'ERROR_FINGERPRINT_REPEAT');
  });

  it('连续两轮低 Delta 触发 SWITCH', () => {
    const switcher = new StrategySwitcher();
    // 两次低 Delta 尝试
    switcher.recordAttempt(buildStrategyAttempt({
      strategyId: 's1', hypothesis: 'h1', actionFingerprint: 'fp_A',
      resultFingerprint: 'rfp_1', evidenceDeltaScore: -0.1, usedAt: NOW,
    }));
    switcher.recordAttempt(buildStrategyAttempt({
      strategyId: 's1', hypothesis: 'h1', actionFingerprint: 'fp_B',
      resultFingerprint: 'rfp_2', evidenceDeltaScore: 0, usedAt: NOW,
    }));

    const assessment = switcher.assess({});
    assert.equal(assessment.shouldSwitch, true);
    assert.equal(assessment.reason, 'CONSECUTIVE_LOW_DELTA');
  });

  it('假设被推翻立即触发 SWITCH', () => {
    const switcher = new StrategySwitcher();
    const assessment = switcher.assess({ hypothesisRejected: true });
    assert.equal(assessment.shouldSwitch, true);
    assert.equal(assessment.reason, 'HYPOTHESIS_REJECTED');
  });
});

// ============================================================================
// Section 5: Stop Controller (测试 5, 9, 13)
// ============================================================================

describe('测试 5: 同一错误重复达到阈值后停止', () => {
  it('连续 3 次同一 errorFingerprint 触发 No-Gain', () => {
    const assessment = assessStop({
      allRequiredAcceptancePassed: false,
      deliveryPreconditionsMet: false,
      hasBlockingPolicy: false,
      evidenceLevelSatisfied: false,
      acceptancePassed: 0,
      acceptanceTotal: 2,
      budgetExhausted: false,
      noCapability: false,
      prerequisiteFailed: false,
      policyBlocked: false,
      unrecoverableExternalFailure: false,
      consecutiveLowDeltaCount: 0,
      consecutiveSameActionCount: 0,
      consecutiveSameErrorCount: 3,
      hasSwitchedStrategy: true,  // 已切换过 → STOP
      deviationType: 'REPEATED_PATTERN',
    });
    assert.equal(assessment.decision, 'STOP');
    assert.equal(assessment.reason, 'NO_GAIN_REPEATED_ERROR');
  });

  it('未切换过策略时 No-Gain 强制 SWITCH', () => {
    const assessment = assessStop({
      allRequiredAcceptancePassed: false,
      deliveryPreconditionsMet: false,
      hasBlockingPolicy: false,
      evidenceLevelSatisfied: false,
      acceptancePassed: 0,
      acceptanceTotal: 2,
      budgetExhausted: false,
      noCapability: false,
      prerequisiteFailed: false,
      policyBlocked: false,
      unrecoverableExternalFailure: false,
      consecutiveLowDeltaCount: 3,
      consecutiveSameActionCount: 0,
      consecutiveSameErrorCount: 0,
      hasSwitchedStrategy: false,  // 未切换过 → SWITCH
      deviationType: 'NO_EVIDENCE',
    });
    assert.equal(assessment.decision, 'SWITCH');
    assert.equal(assessment.reason, 'NO_GAIN_CONSECUTIVE_LOW_DELTA');
  });
});

describe('测试 13: No-Gain 停止判定', () => {
  it('连续 3 轮 deltaScore <= 0 触发 No-Gain', () => {
    const assessment = assessStop({
      allRequiredAcceptancePassed: false,
      deliveryPreconditionsMet: false,
      hasBlockingPolicy: false,
      evidenceLevelSatisfied: false,
      acceptancePassed: 0,
      acceptanceTotal: 2,
      budgetExhausted: false,
      noCapability: false,
      prerequisiteFailed: false,
      policyBlocked: false,
      unrecoverableExternalFailure: false,
      consecutiveLowDeltaCount: 3,
      consecutiveSameActionCount: 0,
      consecutiveSameErrorCount: 0,
      hasSwitchedStrategy: true,
      deviationType: 'NO_EVIDENCE',
    });
    assert.equal(assessment.decision, 'STOP');
    assert.equal(assessment.reason, 'NO_GAIN_CONSECUTIVE_LOW_DELTA');
  });

  it('连续 3 轮同一 actionFingerprint 触发 No-Gain', () => {
    const assessment = assessStop({
      allRequiredAcceptancePassed: false,
      deliveryPreconditionsMet: false,
      hasBlockingPolicy: false,
      evidenceLevelSatisfied: false,
      acceptancePassed: 0,
      acceptanceTotal: 2,
      budgetExhausted: false,
      noCapability: false,
      prerequisiteFailed: false,
      policyBlocked: false,
      unrecoverableExternalFailure: false,
      consecutiveLowDeltaCount: 0,
      consecutiveSameActionCount: 3,
      consecutiveSameErrorCount: 0,
      hasSwitchedStrategy: true,
      deviationType: 'REPEATED_PATTERN',
    });
    assert.equal(assessment.decision, 'STOP');
    assert.equal(assessment.reason, 'NO_GAIN_REPEATED_ACTION');
  });

  it('2 轮低 Delta 不触发 No-Gain', () => {
    const assessment = assessStop({
      allRequiredAcceptancePassed: false,
      deliveryPreconditionsMet: false,
      hasBlockingPolicy: false,
      evidenceLevelSatisfied: false,
      acceptancePassed: 0,
      acceptanceTotal: 2,
      budgetExhausted: false,
      noCapability: false,
      prerequisiteFailed: false,
      policyBlocked: false,
      unrecoverableExternalFailure: false,
      consecutiveLowDeltaCount: 2,
      consecutiveSameActionCount: 0,
      consecutiveSameErrorCount: 0,
      hasSwitchedStrategy: false,
      deviationType: 'NO_EVIDENCE',
    });
    assert.equal(assessment.decision, 'CONTINUE');
  });
});

describe('测试 9: Goal 达成需要 Evidence 与 Gate 同时通过', () => {
  it('Evidence + Gate 都通过 + Delivery + 无阻断 → Goal 达成', () => {
    const achieved = isGoalAchieved({
      allRequiredAcceptancePassed: true,
      allGatesPassed: true,
      evidenceLevelSatisfied: true,
      deliveryPreconditionsMet: true,
      hasBlockingPolicy: false,
    });
    assert.equal(achieved, true);
  });

  it('Gate 未通过 → Goal 未达成', () => {
    const achieved = isGoalAchieved({
      allRequiredAcceptancePassed: true,
      allGatesPassed: false,
      evidenceLevelSatisfied: true,
      deliveryPreconditionsMet: true,
      hasBlockingPolicy: false,
    });
    assert.equal(achieved, false);
  });

  it('Evidence 等级不足 → Goal 未达成', () => {
    const achieved = isGoalAchieved({
      allRequiredAcceptancePassed: true,
      allGatesPassed: true,
      evidenceLevelSatisfied: false,
      deliveryPreconditionsMet: true,
      hasBlockingPolicy: false,
    });
    assert.equal(achieved, false);
  });

  it('存在阻断 Policy → Goal 未达成', () => {
    const achieved = isGoalAchieved({
      allRequiredAcceptancePassed: true,
      allGatesPassed: true,
      evidenceLevelSatisfied: true,
      deliveryPreconditionsMet: true,
      hasBlockingPolicy: true,
    });
    assert.equal(achieved, false);
  });

  it('StopController 成功判定需要四个条件同时满足', () => {
    const assessment = assessStop({
      allRequiredAcceptancePassed: true,
      deliveryPreconditionsMet: true,
      hasBlockingPolicy: false,
      evidenceLevelSatisfied: true,
      acceptancePassed: 2,
      acceptanceTotal: 2,
      budgetExhausted: false,
      noCapability: false,
      prerequisiteFailed: false,
      policyBlocked: false,
      unrecoverableExternalFailure: false,
      consecutiveLowDeltaCount: 0,
      consecutiveSameActionCount: 0,
      consecutiveSameErrorCount: 0,
      hasSwitchedStrategy: false,
      deviationType: 'ACCEPTANCE_MISMATCH',
    });
    assert.equal(assessment.decision, 'STOP');
    assert.equal(assessment.reason, 'SUCCESS');
  });
});

describe('StopController 失败判定', () => {
  it('预算耗尽 → STOP / BUDGET_EXHAUSTED', () => {
    const assessment = assessStop({
      allRequiredAcceptancePassed: false,
      deliveryPreconditionsMet: false,
      hasBlockingPolicy: false,
      evidenceLevelSatisfied: false,
      acceptancePassed: 0,
      acceptanceTotal: 2,
      budgetExhausted: true,
      noCapability: false,
      prerequisiteFailed: false,
      policyBlocked: false,
      unrecoverableExternalFailure: false,
      consecutiveLowDeltaCount: 0,
      consecutiveSameActionCount: 0,
      consecutiveSameErrorCount: 0,
      hasSwitchedStrategy: false,
      deviationType: 'EXECUTION_ERROR',
    });
    assert.equal(assessment.decision, 'STOP');
    assert.equal(assessment.reason, 'BUDGET_EXHAUSTED');
  });

  it('Policy 阻断 → STOP / POLICY_BLOCKED', () => {
    const assessment = assessStop({
      allRequiredAcceptancePassed: false,
      deliveryPreconditionsMet: false,
      hasBlockingPolicy: false,
      evidenceLevelSatisfied: false,
      acceptancePassed: 0,
      acceptanceTotal: 2,
      budgetExhausted: false,
      noCapability: false,
      prerequisiteFailed: false,
      policyBlocked: true,
      unrecoverableExternalFailure: false,
      consecutiveLowDeltaCount: 0,
      consecutiveSameActionCount: 0,
      consecutiveSameErrorCount: 0,
      hasSwitchedStrategy: false,
      deviationType: 'AUTHORIZATION_GAP',
    });
    assert.equal(assessment.decision, 'STOP');
    assert.equal(assessment.reason, 'POLICY_BLOCKED');
  });

  it('前提失效 → STOP / PREREQUISITE_FAILED', () => {
    const assessment = assessStop({
      allRequiredAcceptancePassed: false,
      deliveryPreconditionsMet: false,
      hasBlockingPolicy: false,
      evidenceLevelSatisfied: false,
      acceptancePassed: 0,
      acceptanceTotal: 2,
      budgetExhausted: false,
      noCapability: false,
      prerequisiteFailed: true,
      policyBlocked: false,
      unrecoverableExternalFailure: false,
      consecutiveLowDeltaCount: 0,
      consecutiveSameActionCount: 0,
      consecutiveSameErrorCount: 0,
      hasSwitchedStrategy: false,
      deviationType: 'HYPOTHESIS_REJECTED',
    });
    assert.equal(assessment.decision, 'STOP');
    assert.equal(assessment.reason, 'PREREQUISITE_FAILED');
  });
});

// ============================================================================
// Section 6: Cycle Plan Hash 稳定性 (测试 15)
// ============================================================================

describe('测试 15: Cycle Plan Hash 稳定性', () => {
  it('相同内容（不同 cycleId/runId）产生相同 hash', () => {
    const plan = buildCyclePlan(makeCyclePlanInput());
    const plan2 = buildCyclePlan(makeCyclePlanInput());

    // cycleId/runId 是随机生成的，但 hash 应该相同
    const hash1 = computeCyclePlanHash(plan);
    const hash2 = computeCyclePlanHash(plan2);
    assert.equal(hash1, hash2);
  });

  it('不同 hypothesis 产生不同 hash', () => {
    const plan1 = buildCyclePlan(makeCyclePlanInput({ hypothesis: 'h1' }));
    const plan2 = buildCyclePlan(makeCyclePlanInput({ hypothesis: 'h2' }));
    const hash1 = computeCyclePlanHash(plan1);
    const hash2 = computeCyclePlanHash(plan2);
    assert.notEqual(hash1, hash2);
  });

  it('不同 expectedEvidence 产生不同 hash', () => {
    const plan1 = buildCyclePlan(makeCyclePlanInput({
      expectedEvidence: [makeExpectedEvidence({ expectedEvidenceId: 'ee_1' })],
      plannedActions: [makePlannedAction({ expectedEvidenceId: 'ee_1' })],
    }));
    const plan2 = buildCyclePlan(makeCyclePlanInput({
      expectedEvidence: [makeExpectedEvidence({ expectedEvidenceId: 'ee_2' })],
      plannedActions: [makePlannedAction({ expectedEvidenceId: 'ee_2' })],
    }));
    const hash1 = computeCyclePlanHash(plan1);
    const hash2 = computeCyclePlanHash(plan2);
    assert.notEqual(hash1, hash2);
  });

  it('hash 是 64 位 hex 字符串', () => {
    const plan = buildCyclePlan(makeCyclePlanInput());
    const hash = computeCyclePlanHash(plan);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('hash 排除 cycleId / runId（运行时字段）', () => {
    // 直接构造两个 plan，仅 cycleId / runId 不同
    const baseInput = makeCyclePlanInput();
    const plan1 = buildCyclePlan(baseInput);
    const plan2: EvidenceCyclePlan = {
      ...plan1,
      cycleId: createCycleId(),
      runId: newRunId(),
    };
    assert.equal(computeCyclePlanHash(plan1), computeCyclePlanHash(plan2));
  });
});

// ============================================================================
// Section 7: Cycle Planner 校验
// ============================================================================

describe('CyclePlanBuilder 校验', () => {
  it('拒绝缺少 hypothesis 的 plan', () => {
    assert.throws(
      () => buildCyclePlan(makeCyclePlanInput({ hypothesis: '' })),
      (err: unknown) => err instanceof CyclePlannerError && err.code === 'MISSING_HYPOTHESIS',
    );
  });

  it('拒绝空 expectedEvidence', () => {
    assert.throws(
      () => buildCyclePlan(makeCyclePlanInput({ expectedEvidence: [] })),
      (err: unknown) => err instanceof CyclePlannerError && err.code === 'MISSING_EXPECTED_EVIDENCE',
    );
  });

  it('拒绝没有 required evidence 的 plan', () => {
    assert.throws(
      () => buildCyclePlan(makeCyclePlanInput({
        expectedEvidence: [makeExpectedEvidence({ required: false })],
      })),
      (err: unknown) => err instanceof CyclePlannerError && err.code === 'NO_REQUIRED_EVIDENCE',
    );
  });

  it('拒绝重复 actionFingerprint', () => {
    const action = makePlannedAction();
    assert.throws(
      () => buildCyclePlan(makeCyclePlanInput({
        plannedActions: [action, { ...action, actionId: 'pa_2' }],
      })),
      (err: unknown) => err instanceof CyclePlannerError && err.code === 'DUPLICATE_ACTION_FINGERPRINT',
    );
  });

  it('sliceCycleBudget 均分预算', () => {
    const budget = sliceCycleBudget(
      { maxCycles: 10, maxTokens: 100000, maxDurationMs: 600000 },
      5,
      1000,
    );
    // (100000 - 1000*5) / 5 = 95000 / 5 = 19000
    assert.equal(budget.maxTokens, 19000);
    assert.equal(budget.maxDurationMs, 120000);
    assert.equal(budget.reservedTokens, 1000);
  });

  it('sliceCycleBudget 拒绝 0 remaining cycles', () => {
    assert.throws(
      () => sliceCycleBudget({ maxCycles: 10, maxTokens: 100000, maxDurationMs: 600000 }, 0),
      CyclePlannerError,
    );
  });

  it('deriveExpectedEvidenceFromGoal 映射 sourceType', () => {
    const goal = makeGoalSpec();
    const derived = deriveExpectedEvidenceFromGoal(goal);
    assert.equal(derived.length, 1);
    // 'test' → 'command'
    assert.equal(derived[0]!.sourceType, 'command');
    assert.equal(derived[0]!.required, true);
  });
});

// ============================================================================
// Section 8: EvidenceLoop 端到端 (测试 8, 10)
// ============================================================================

describe('EvidenceLoop 端到端', () => {
  describe('测试 8: Regression 触发回滚或隔离', () => {
    it('Regression 偏差触发 SWITCH 决策（回滚/隔离）', () => {
      const loop = createEvidenceLoop('strategy-1', 'initial hypothesis');
      const plan = loop.buildPlan(makeCyclePlanInput({ runId: RUN_ID }));

      const assessment = loop.assessCycle({
        plan,
        execution: {
          actualEvidenceIds: [createAwknId('evidence')],
          tokens: 1000,
          durationMs: 5000,
          executionFailed: false,
          actionFingerprint: 'fp_A',
          resultFingerprint: 'rfp_A',
          regression: true,
          contextMissing: false,
          authorizationDenied: false,
          capabilityInsufficient: false,
          hypothesisRejected: false,
          acceptanceMismatch: false,
          strategyEliminated: false,
          riskReduced: false,
          rootCauseConfirmed: false,
          constraintDiscovered: false,
        },
        evaluation: {
          acceptancePassed: 0,
          acceptanceTotal: 2,
          allRequiredAcceptancePassed: false,
          deliveryPreconditionsMet: false,
          hasBlockingPolicy: false,
          evidenceLevelSatisfied: false,
          allGatesPassed: false,
          budgetExhausted: false,
          noCapability: false,
          prerequisiteFailed: false,
          policyBlocked: false,
          unrecoverableExternalFailure: false,
          recentDeltaScores: [],
          recentActionFingerprints: [],
          recentErrorFingerprints: [],
          uncertaintyBefore: 0.5,
          uncertaintyAfter: 0.5,
          acceptanceProgressBefore: 0.2,
          acceptanceProgressAfter: 0.2,
        },
      });

      assert.equal(assessment.deviationType, 'REGRESSION');
      assert.equal(assessment.decision, 'SWITCH');
      assert.equal(assessment.delta.gainType, 'regression');
      assert.ok(assessment.delta.deltaScore <= 0);
    });
  });

  describe('测试 10: Run 恢复不会重复已确认副作用', () => {
    it('replayHistory 仅更新内部状态，不触发外部执行', () => {
      const loop = createEvidenceLoop('strategy-1', 'h1');

      // 模拟从 Event 重放的历史
      const replayedAttempts: StrategyAttempt[] = [
        buildStrategyAttempt({
          strategyId: 'strategy-1',
          hypothesis: 'h1',
          actionFingerprint: 'fp_A',
          resultFingerprint: 'rfp_A',
          evidenceDeltaScore: 0.3,
          usedAt: NOW,
        }),
        buildStrategyAttempt({
          strategyId: 'strategy-1',
          hypothesis: 'h1',
          actionFingerprint: 'fp_B',
          resultFingerprint: 'rfp_B',
          evidenceDeltaScore: 0.5,
          usedAt: NOW,
        }),
      ];

      // 重放前状态
      assert.equal(loop.strategyHistory.length, 0);

      // 重放
      loop.replayHistory(replayedAttempts);

      // 重放后状态：历史恢复，但当前策略仍是最后一条
      assert.equal(loop.strategyHistory.length, 2);
      assert.equal(loop.strategyId, 'strategy-1');
      assert.equal(loop.hasSwitched, false);  // 只有一个 strategyId
    });

    it('replayHistory 检测已切换策略', () => {
      const loop = createEvidenceLoop('strategy-1', 'h1');
      loop.replayHistory([
        buildStrategyAttempt({
          strategyId: 'strategy-1', hypothesis: 'h1',
          actionFingerprint: 'fp_A', resultFingerprint: 'rfp_A',
          evidenceDeltaScore: 0.3, usedAt: NOW,
        }),
        buildStrategyAttempt({
          strategyId: 'strategy-2', hypothesis: 'h2',
          actionFingerprint: 'fp_B', resultFingerprint: 'rfp_B',
          evidenceDeltaScore: 0.5, usedAt: NOW,
        }),
      ]);
      assert.equal(loop.hasSwitched, true);
      assert.equal(loop.strategyId, 'strategy-2');
    });
  });

  describe('完整 Cycle 评估流程', () => {
    it('成功 Cycle：通过所有验收 → STOP / SUCCESS', () => {
      const loop = createEvidenceLoop('strategy-1', 'tests pass');
      const plan = loop.buildPlan(makeCyclePlanInput({ runId: RUN_ID }));

      const assessment = loop.assessCycle({
        plan,
        execution: {
          actualEvidenceIds: [createAwknId('evidence')],
          tokens: 2000,
          durationMs: 10000,
          executionFailed: false,
          actionFingerprint: 'fp_A',
          resultFingerprint: 'rfp_A',
          regression: false,
          contextMissing: false,
          authorizationDenied: false,
          capabilityInsufficient: false,
          hypothesisRejected: false,
          acceptanceMismatch: false,
          strategyEliminated: false,
          riskReduced: false,
          rootCauseConfirmed: false,
          constraintDiscovered: false,
        },
        evaluation: {
          acceptancePassed: 2,
          acceptanceTotal: 2,
          allRequiredAcceptancePassed: true,
          deliveryPreconditionsMet: true,
          hasBlockingPolicy: false,
          evidenceLevelSatisfied: true,
          allGatesPassed: true,
          budgetExhausted: false,
          noCapability: false,
          prerequisiteFailed: false,
          policyBlocked: false,
          unrecoverableExternalFailure: false,
          recentDeltaScores: [],
          recentActionFingerprints: [],
          recentErrorFingerprints: [],
          uncertaintyBefore: 0.6,
          uncertaintyAfter: 0.2,
          acceptanceProgressBefore: 0.3,
          acceptanceProgressAfter: 1.0,
        },
      });

      assert.equal(assessment.decision, 'STOP');
      assert.equal(assessment.stopAssessment.reason, 'SUCCESS');
      assert.equal(assessment.goalAchieved, true);
      assert.ok(assessment.delta.deltaScore > 0);
      assert.equal(assessment.delta.gainType, 'progress');
      // Receipt 校验
      assert.equal(assessment.receipt.schema, 'awkn-cycle-receipt/v1');
      assert.equal(assessment.receipt.runId, RUN_ID);
      assert.equal(assessment.receipt.cycle, 1);
    });

    it('失败 Cycle：执行失败 + 无新证据 → CONTINUE / EXECUTION_ERROR', () => {
      const loop = createEvidenceLoop('strategy-1', 'tests pass');
      const plan = loop.buildPlan(makeCyclePlanInput({ runId: RUN_ID }));

      const assessment = loop.assessCycle({
        plan,
        execution: {
          actualEvidenceIds: [],
          tokens: 500,
          durationMs: 2000,
          executionFailed: true,
          errorFingerprint: 'err_1',
          actionFingerprint: 'fp_A',
          resultFingerprint: 'rfp_A',
          regression: false,
          contextMissing: false,
          authorizationDenied: false,
          capabilityInsufficient: false,
          hypothesisRejected: false,
          acceptanceMismatch: false,
          strategyEliminated: false,
          riskReduced: false,
          rootCauseConfirmed: false,
          constraintDiscovered: false,
        },
        evaluation: {
          acceptancePassed: 0,
          acceptanceTotal: 2,
          allRequiredAcceptancePassed: false,
          deliveryPreconditionsMet: false,
          hasBlockingPolicy: false,
          evidenceLevelSatisfied: false,
          allGatesPassed: false,
          budgetExhausted: false,
          noCapability: false,
          prerequisiteFailed: false,
          policyBlocked: false,
          unrecoverableExternalFailure: false,
          recentDeltaScores: [],
          recentActionFingerprints: [],
          recentErrorFingerprints: [],
          uncertaintyBefore: 0.5,
          uncertaintyAfter: 0.6,
          acceptanceProgressBefore: 0.2,
          acceptanceProgressAfter: 0.2,
        },
      });

      assert.equal(assessment.deviationType, 'EXECUTION_ERROR');
      assert.equal(assessment.decision, 'CONTINUE');
      assert.ok(assessment.delta.deltaScore <= 0);  // 无新证据 fail-closed
      assert.equal(assessment.goalAchieved, false);
    });

    it('Context Gap 返回 PAUSE (测试 6)', () => {
      const loop = createEvidenceLoop('strategy-1', 'h1');
      const plan = loop.buildPlan(makeCyclePlanInput({ runId: RUN_ID }));

      const assessment = loop.assessCycle({
        plan,
        execution: {
          actualEvidenceIds: [createAwknId('evidence')],
          tokens: 800,
          durationMs: 3000,
          executionFailed: false,
          actionFingerprint: 'fp_A',
          resultFingerprint: 'rfp_A',
          regression: false,
          contextMissing: true,
          authorizationDenied: false,
          capabilityInsufficient: false,
          hypothesisRejected: false,
          acceptanceMismatch: false,
          strategyEliminated: false,
          riskReduced: false,
          rootCauseConfirmed: false,
          constraintDiscovered: false,
        },
        evaluation: {
          acceptancePassed: 0,
          acceptanceTotal: 2,
          allRequiredAcceptancePassed: false,
          deliveryPreconditionsMet: false,
          hasBlockingPolicy: false,
          evidenceLevelSatisfied: false,
          allGatesPassed: false,
          budgetExhausted: false,
          noCapability: false,
          prerequisiteFailed: false,
          policyBlocked: false,
          unrecoverableExternalFailure: false,
          recentDeltaScores: [],
          recentActionFingerprints: [],
          recentErrorFingerprints: [],
          uncertaintyBefore: 0.5,
          uncertaintyAfter: 0.5,
          acceptanceProgressBefore: 0.2,
          acceptanceProgressAfter: 0.2,
        },
      });

      assert.equal(assessment.deviationType, 'CONTEXT_GAP');
      assert.equal(assessment.decision, 'PAUSE');
    });

    it('Capability Gap 返回 SWITCH (测试 7)', () => {
      const loop = createEvidenceLoop('strategy-1', 'h1');
      const plan = loop.buildPlan(makeCyclePlanInput({ runId: RUN_ID }));

      const assessment = loop.assessCycle({
        plan,
        execution: {
          actualEvidenceIds: [createAwknId('evidence')],
          tokens: 800,
          durationMs: 3000,
          executionFailed: false,
          actionFingerprint: 'fp_A',
          resultFingerprint: 'rfp_A',
          regression: false,
          contextMissing: false,
          authorizationDenied: false,
          capabilityInsufficient: true,
          hypothesisRejected: false,
          acceptanceMismatch: false,
          strategyEliminated: false,
          riskReduced: false,
          rootCauseConfirmed: false,
          constraintDiscovered: false,
        },
        evaluation: {
          acceptancePassed: 0,
          acceptanceTotal: 2,
          allRequiredAcceptancePassed: false,
          deliveryPreconditionsMet: false,
          hasBlockingPolicy: false,
          evidenceLevelSatisfied: false,
          allGatesPassed: false,
          budgetExhausted: false,
          noCapability: false,
          prerequisiteFailed: false,
          policyBlocked: false,
          unrecoverableExternalFailure: false,
          recentDeltaScores: [],
          recentActionFingerprints: [],
          recentErrorFingerprints: [],
          uncertaintyBefore: 0.5,
          uncertaintyAfter: 0.5,
          acceptanceProgressBefore: 0.2,
          acceptanceProgressAfter: 0.2,
        },
      });

      assert.equal(assessment.deviationType, 'CAPABILITY_GAP');
      assert.equal(assessment.decision, 'SWITCH');
      assert.ok(assessment.nextStrategy);
    });

    it('同一 actionFingerprint 重复 → SWITCH (测试 4 端到端)', () => {
      const loop = createEvidenceLoop('strategy-1', 'h1');
      // 第一轮
      const plan1 = loop.buildPlan(makeCyclePlanInput({ runId: RUN_ID, cycleNumber: 1 }));
      loop.assessCycle({
        plan: plan1,
        execution: {
          actualEvidenceIds: [],
          tokens: 500,
          durationMs: 1000,
          executionFailed: true,
          errorFingerprint: 'err_X',
          actionFingerprint: 'fp_repeat',
          resultFingerprint: 'rfp_1',
          regression: false,
          contextMissing: false,
          authorizationDenied: false,
          capabilityInsufficient: false,
          hypothesisRejected: false,
          acceptanceMismatch: false,
          strategyEliminated: false,
          riskReduced: false,
          rootCauseConfirmed: false,
          constraintDiscovered: false,
        },
        evaluation: {
          acceptancePassed: 0,
          acceptanceTotal: 2,
          allRequiredAcceptancePassed: false,
          deliveryPreconditionsMet: false,
          hasBlockingPolicy: false,
          evidenceLevelSatisfied: false,
          allGatesPassed: false,
          budgetExhausted: false,
          noCapability: false,
          prerequisiteFailed: false,
          policyBlocked: false,
          unrecoverableExternalFailure: false,
          recentDeltaScores: [],
          recentActionFingerprints: [],
          recentErrorFingerprints: [],
          uncertaintyBefore: 0.5,
          uncertaintyAfter: 0.6,
          acceptanceProgressBefore: 0.2,
          acceptanceProgressAfter: 0.2,
        },
      });

      // 第二轮：同一 actionFingerprint → 应触发 SWITCH
      const plan2 = loop.buildPlan(makeCyclePlanInput({ runId: RUN_ID, cycleNumber: 2 }));
      const assessment2 = loop.assessCycle({
        plan: plan2,
        execution: {
          actualEvidenceIds: [],
          tokens: 500,
          durationMs: 1000,
          executionFailed: false,
          actionFingerprint: 'fp_repeat',
          resultFingerprint: 'rfp_2',
          regression: false,
          contextMissing: false,
          authorizationDenied: false,
          capabilityInsufficient: false,
          hypothesisRejected: false,
          acceptanceMismatch: false,
          strategyEliminated: false,
          riskReduced: false,
          rootCauseConfirmed: false,
          constraintDiscovered: false,
        },
        evaluation: {
          acceptancePassed: 0,
          acceptanceTotal: 2,
          allRequiredAcceptancePassed: false,
          deliveryPreconditionsMet: false,
          hasBlockingPolicy: false,
          evidenceLevelSatisfied: false,
          allGatesPassed: false,
          budgetExhausted: false,
          noCapability: false,
          prerequisiteFailed: false,
          policyBlocked: false,
          unrecoverableExternalFailure: false,
          recentDeltaScores: [-0.1],
          recentActionFingerprints: ['fp_repeat'],
          recentErrorFingerprints: ['err_X'],
          uncertaintyBefore: 0.6,
          uncertaintyAfter: 0.6,
          acceptanceProgressBefore: 0.2,
          acceptanceProgressAfter: 0.2,
        },
      });

      assert.equal(assessment2.deviationType, 'REPEATED_PATTERN');
      assert.equal(assessment2.decision, 'SWITCH');
    });
  });
});

// ============================================================================
// Section 9: 公共导出与 ID 生成
// ============================================================================

describe('ID 生成与导出', () => {
  it('createCycleId 生成 cyc_ 前缀 ID', () => {
    const id = createCycleId();
    assert.match(id, /^cyc_[0-9a-f]{32}$/);
  });

  it('DeviationTypeSchema 包含全部 9 个偏差类型', () => {
    const values = DeviationTypeSchema.options;
    assert.equal(values.length, 9);
    for (const expected of [
      'EXECUTION_ERROR',
      'HYPOTHESIS_REJECTED',
      'CONTEXT_GAP',
      'AUTHORIZATION_GAP',
      'CAPABILITY_GAP',
      'ACCEPTANCE_MISMATCH',
      'REPEATED_PATTERN',
      'NO_EVIDENCE',
      'REGRESSION',
    ] as const) {
      assert.ok(values.includes(expected), `missing deviation type: ${expected}`);
    }
  });

  it('StrategyDecisionSchema 包含 CONTINUE/SWITCH/PAUSE/STOP', () => {
    const values = StrategyDecisionSchema.options;
    assert.deepEqual(values.sort(), ['CONTINUE', 'PAUSE', 'STOP', 'SWITCH']);
  });

  it('DELTA_CALCULATOR_VERSION 是非空字符串', () => {
    assert.ok(DELTA_CALCULATOR_VERSION.length > 0);
  });

  it('DELTA_WEIGHTS 总正权重为 1.0（不含 regression）', () => {
    const positiveSum = DELTA_WEIGHTS.acceptanceProgress
      + DELTA_WEIGHTS.uncertaintyReduction
      + DELTA_WEIGHTS.newVerifiedEvidence
      + DELTA_WEIGHTS.strategyElimination
      + DELTA_WEIGHTS.riskReduction;
    assert.ok(Math.abs(positiveSum - 1.0) < 1e-9);
  });
});
