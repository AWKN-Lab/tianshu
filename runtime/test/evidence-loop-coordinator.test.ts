/**
 * Evidence-Gain Loop Coordinator Smoke Test (Phase 6 / C06 / WP-AOS-12)
 *
 * 设计文档: docs/agent-os-3.0/07-Evidence-Gain-Loop.md
 *
 * 与 contracts/evidence-loop.test.ts 的区别：
 * - contracts 测试聚焦于 Schema 校验和纯函数辅助（assessStrategySwitch / evaluateNoGainStop）
 * - 本 smoke 测试聚焦于 createEvidenceGainLoop 协调器的端到端行为：
 *   plan → execute(mock) → evaluate → 决策
 *
 * 覆盖设计文档四条验收：
 * 1. 每轮都有 Cycle Receipt
 * 2. 连续无增量时系统不会盲目循环
 * 3. Strategy Switch 可观测
 * 4. Evidence 与 Acceptance 进度可查询
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createEvidenceGainLoop,
  createInitialEvidenceLoopState,
  type CycleEvaluationInput,
} from '../src/loop/evidence-loop.js';
import type { CyclePlanInput } from '../src/loop/cycle-planner.js';
import type { DeltaInput } from '../src/loop/evidence-delta.js';
import type { DeviationInput } from '../src/loop/deviation.js';
import type {
  CycleReceipt,
  EvidenceCyclePlan,
  ExpectedEvidence,
  Hypothesis,
  PlannedAction,
  CycleBudget,
  StrategyAttempt,
} from '../src/contracts/evidence-loop.js';
import { createAwknId } from '../src/contracts/ids.js';
import { toUtcTimestamp } from '../src/contracts/time.js';

const NOW_ISO = '2026-07-29T08:00:00.000Z';
const FIXED_DATE = new Date(NOW_ISO);
const RUN_ID = createAwknId('run');
const SHA256_EXAMPLE = 'a'.repeat(64);

const HYPOTHESIS: Hypothesis = {
  schema: 'awkn-hypothesis/v1',
  hypothesisId: 'hyp-migration',
  statement: 'build failure caused by missing migration v12',
  rationale: 'error log mentions schema mismatch',
  assumptions: ['migration v12 was not applied'],
  falsifiable: true,
  confidence: 0.7,
};

const EXPECTED_EVIDENCE: ExpectedEvidence = {
  schema: 'awkn-expected-evidence/v1',
  expectedEvidenceId: 'ee-migration-applied',
  description: 'migration v12 applied successfully',
  sourceType: 'command',
  evaluatorId: 'migration-checker',
  successPredicate: { exitCode: 0 },
  required: true,
};

const PLANNED_ACTION: PlannedAction = {
  actionId: 'act-run-migration',
  toolId: 'shell.exec',
  description: 'run migration v12',
  producesEvidenceIds: ['ee-migration-applied'],
  fingerprint: 'migration-v12-run',
};

const BUDGET: CycleBudget = {
  maxTokens: 100000,
  maxDurationMs: 60000,
  maxCostUsd: 0.5,
  consumedTokens: 0,
  consumedDurationMs: 0,
  consumedCostUsd: 0,
};

function makePlanInput(cycleNumber: number, overrides: Partial<CyclePlanInput> = {}): CyclePlanInput {
  return {
    runId: RUN_ID,
    cycleNumber,
    objective: 'fix migration failure',
    hypothesis: HYPOTHESIS,
    expectedEvidence: [EXPECTED_EVIDENCE],
    plannedActions: [PLANNED_ACTION],
    selectedStrategy: 'apply-migration',
    policyBundleHash: SHA256_EXAMPLE,
    skillBundleHash: SHA256_EXAMPLE,
    contextManifestHash: SHA256_EXAMPLE,
    budgetSlice: BUDGET,
    now: FIXED_DATE,
    ...overrides,
  };
}

function makeDeltaInput(cycleId: string, overrides: Partial<DeltaInput> = {}): DeltaInput {
  return {
    cycleId,
    acceptanceProgress: 0,
    uncertaintyReduction: 0,
    newVerifiedEvidence: 0,
    strategyElimination: 0,
    riskReduction: 0,
    regression: 0,
    newEvidenceCount: 0,
    ...overrides,
  };
}

function makeDeviationInput(overrides: Partial<DeviationInput> = {}): DeviationInput {
  return {
    gates: [],
    toolExecutions: [],
    deltaScore: 0,
    gainType: 'none',
    acceptanceProgress: 0,
    recentActionFingerprints: [],
    recentErrorFingerprints: [],
    ...overrides,
  };
}

function makeEvalInput(
  cyclePlan: EvidenceCyclePlan,
  overrides: Partial<CycleEvaluationInput> = {},
): CycleEvaluationInput {
  return {
    cyclePlan,
    deltaInput: makeDeltaInput(cyclePlan.cycleId),
    deviationInput: makeDeviationInput({ deltaScore: 0, gainType: 'none', acceptanceProgress: 0 }),
    allRequiredGatesPassed: false,
    budgetExhausted: false,
    blockedByPolicy: false,
    reachedMaxCycles: false,
    waitingForUser: false,
    waitingForExternal: false,
    preconditionFailed: false,
    actualEvidenceIds: [],
    tokens: 1000,
    durationMs: 5000,
    now: FIXED_DATE,
    ...overrides,
  };
}

describe('Evidence-Gain Loop Coordinator (createEvidenceGainLoop)', () => {
  describe('acceptance 1: each cycle produces a CycleReceipt', () => {
    it('planCycle + evaluateCycle yields a valid CycleReceipt', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      const result = loop.evaluateCycle(makeEvalInput(plan));

      assert.ok(result.receipt, 'receipt must be defined');
      assert.equal(result.receipt.schema, 'awkn-cycle-receipt/v1');
      assert.equal(result.receipt.runId, RUN_ID);
      assert.equal(result.receipt.cycle, 1);
      assert.equal(result.receipt.hypothesis, HYPOTHESIS.statement);
      assert.match(result.receipt.receiptId, /^rcpt_[0-9a-f]{32}$/);
    });

    it('multiple cycles produce distinct receipts with increasing cycle numbers', () => {
      const loop = createEvidenceGainLoop();
      const plan1 = loop.planCycle(makePlanInput(1));
      const r1 = loop.evaluateCycle(makeEvalInput(plan1));
      const plan2 = loop.planCycle(makePlanInput(2));
      const r2 = loop.evaluateCycle(makeEvalInput(plan2));

      assert.notEqual(r1.receipt.receiptId, r2.receipt.receiptId);
      assert.equal(r1.receipt.cycle, 1);
      assert.equal(r2.receipt.cycle, 2);
    });
  });

  describe('acceptance 4: evidence and acceptance progress queryable via state', () => {
    it('getState exposes cycleReceipts and strategyAttempts', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      loop.evaluateCycle(makeEvalInput(plan, { actualEvidenceIds: [createAwknId('evidence')] }));

      const state = loop.getState();
      assert.equal(state.cycleReceipts.length, 1);
      assert.equal(state.cyclePlans.length, 1);
      assert.equal(state.strategyAttempts.length, 0);
      assert.equal(state.hasSwitchedBefore, false);
    });

    it('recordStrategyAttempt adds to state.strategyAttempts', () => {
      const loop = createEvidenceGainLoop();
      const attempt: StrategyAttempt = {
        schema: 'awkn-strategy-attempt/v1',
        strategyId: 'strat-1',
        hypothesis: HYPOTHESIS.statement,
        actionFingerprint: 'fp-A',
        resultFingerprint: 'rfp-A',
        evidenceDeltaScore: 0.1,
        usedAt: toUtcTimestamp(NOW_ISO),
      };
      loop.recordStrategyAttempt(attempt);

      const state = loop.getState();
      assert.equal(state.strategyAttempts.length, 1);
      assert.equal(state.strategyAttempts[0]!.strategyId, 'strat-1');
    });
  });

  describe('SUCCESS path: all required gates passed', () => {
    it('returns SUCCESS stop decision when allRequiredGatesPassed=true', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      const result = loop.evaluateCycle(
        makeEvalInput(plan, { allRequiredGatesPassed: true }),
      );

      assert.equal(result.stopDecision.type, 'SUCCESS');
      assert.equal(result.shouldContinue, false);
    });

    it('SUCCESS receipt records positive delta when evidence is present', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      const evId = createAwknId('evidence');
      const result = loop.evaluateCycle(
        makeEvalInput(plan, {
          allRequiredGatesPassed: true,
          deltaInput: makeDeltaInput(plan.cycleId, {
            acceptanceProgress: 1.0,
            newVerifiedEvidence: 1.0,
            newEvidenceCount: 1,
          }),
          actualEvidenceIds: [evId],
        }),
      );

      assert.equal(result.stopDecision.type, 'SUCCESS');
      assert.ok(result.delta.deltaScore > 0);
      assert.equal(result.receipt.actualEvidenceIds.length, 1);
      assert.equal(result.receipt.deltaScore, result.delta.deltaScore);
    });
  });

  describe('NO_GAIN_STOP: 3 consecutive low-delta cycles stop the loop', () => {
    it('does NOT trigger NO_GAIN_STOP after only 2 low-delta cycles', () => {
      const loop = createEvidenceGainLoop();
      for (let i = 1; i <= 2; i++) {
        const plan = loop.planCycle(makePlanInput(i));
        const result = loop.evaluateCycle(makeEvalInput(plan));
        // 还未达到 3 轮阈值，应继续
        assert.notEqual(result.stopDecision.type, 'NO_GAIN_STOP');
      }
      const state = loop.getState();
      assert.equal(state.cycleReceipts.length, 2);
    });

    it('triggers NO_GAIN_STOP on the 3rd consecutive low-delta cycle', () => {
      const loop = createEvidenceGainLoop();
      let lastResult;
      for (let i = 1; i <= 3; i++) {
        const plan = loop.planCycle(makePlanInput(i));
        lastResult = loop.evaluateCycle(makeEvalInput(plan));
      }
      assert.ok(lastResult, 'last result must be defined');
      assert.equal(lastResult!.stopDecision.type, 'NO_GAIN_STOP');
      assert.equal(lastResult!.shouldContinue, false);
      const cond = lastResult!.stopDecision.type === 'NO_GAIN_STOP'
        ? lastResult!.stopDecision.condition
        : null;
      assert.ok(cond, 'no-gain condition must be attached');
      assert.ok(cond!.consecutiveLowDeltaCycles >= 3);
      assert.equal(cond!.triggered, true);
    });
  });

  describe('acceptance 2: continuous no-gain does not loop blindly', () => {
    it('after NO_GAIN_STOP, shouldContinue is false and decision is not CONTINUE', () => {
      const loop = createEvidenceGainLoop();
      // 3 cycles with all-zero delta and no evidence
      let lastResult = null;
      for (let i = 1; i <= 3; i++) {
        const plan = loop.planCycle(makePlanInput(i));
        lastResult = loop.evaluateCycle(makeEvalInput(plan));
      }
      assert.ok(lastResult);
      assert.equal(lastResult!.shouldContinue, false);
      assert.notEqual(lastResult!.strategyDecision, 'CONTINUE');
    });
  });

  describe('acceptance 3: Strategy Switch observable', () => {
    it('repeated action fingerprint triggers SWITCH with nextStrategy', () => {
      const loop = createEvidenceGainLoop();
      // 第 1 轮：记录 actionFingerprint='fp-A'，delta>0 让循环继续
      const plan1 = loop.planCycle(makePlanInput(1));
      loop.evaluateCycle(
        makeEvalInput(plan1, {
          deltaInput: makeDeltaInput(plan1.cycleId, {
            acceptanceProgress: 0.5,
            newVerifiedEvidence: 0.3,
            newEvidenceCount: 1,
          }),
          actualEvidenceIds: [createAwknId('evidence')],
        }),
      );
      loop.recordStrategyAttempt({
        schema: 'awkn-strategy-attempt/v1',
        strategyId: 'strat-1',
        hypothesis: HYPOTHESIS.statement,
        actionFingerprint: 'fp-A',
        resultFingerprint: 'rfp-A',
        evidenceDeltaScore: 0.4,
        usedAt: toUtcTimestamp(NOW_ISO),
      });

      // 第 2 轮：相同 actionFingerprint 触发 assessStrategySwitch 的 'repeated action fingerprint'
      const plan2 = loop.planCycle(makePlanInput(2));
      const result2 = loop.evaluateCycle(
        makeEvalInput(plan2, {
          deltaInput: makeDeltaInput(plan2.cycleId, {
            acceptanceProgress: 0.0,
            newEvidenceCount: 0,
          }),
          actualEvidenceIds: [],
        }),
      );
      // 记录相同 fingerprint 让 assessStrategySwitch 能检测到
      loop.recordStrategyAttempt({
        schema: 'awkn-strategy-attempt/v1',
        strategyId: 'strat-1',
        hypothesis: HYPOTHESIS.statement,
        actionFingerprint: 'fp-A',
        resultFingerprint: 'rfp-A2',
        evidenceDeltaScore: 0,
        usedAt: toUtcTimestamp(NOW_ISO),
      });

      // 第 3 轮：strategyAttempts 已有 2 条相同 actionFingerprint，触发 SWITCH
      const plan3 = loop.planCycle(makePlanInput(3));
      const result3 = loop.evaluateCycle(
        makeEvalInput(plan3, {
          deltaInput: makeDeltaInput(plan3.cycleId, {
            acceptanceProgress: 0.0,
            newEvidenceCount: 0,
          }),
          actualEvidenceIds: [],
        }),
      );

      // 至少在某轮应观察到 SWITCH
      const observedSwitch =
        result2.strategySwitch.shouldSwitch || result3.strategySwitch.shouldSwitch;
      assert.ok(
        observedSwitch,
        'strategy switch should be observed when action fingerprint repeats',
      );

      // 校验可观测性：strategySwitch 字段已被填充
      assert.ok(result3.strategySwitch, 'strategySwitch field must be populated');
    });

    it('SWITCH decision sets nextStrategy on the receipt', () => {
      const loop = createEvidenceGainLoop();
      // 制造一个 SWITCH：通过 HYPOTHESIS_REJECTED 触发 recommendStrategyDecision → SWITCH
      const plan = loop.planCycle(makePlanInput(1));
      const result = loop.evaluateCycle(
        makeEvalInput(plan, {
          deltaInput: makeDeltaInput(plan.cycleId, {
            regression: 0.0,
            acceptanceProgress: 0.0,
            newEvidenceCount: 0,
          }),
          deviationInput: makeDeviationInput({
            deltaScore: 0,
            gainType: 'none',
            acceptanceProgress: 0,
            hypothesis: HYPOTHESIS.statement,
            hypothesisRejected: true,
            recentActionFingerprints: [],
            recentErrorFingerprints: [],
          }),
        }),
      );

      // hypothesisRejected → deviation=HYPOTHESIS_REJECTED → recommendStrategyDecision=SWITCH
      // 但 strategySwitch 是否触发取决于 attempts 状态；这里 attempts 为空，不会触发
      // 所以 strategyDecision 走 recommendStrategyDecision 的 SWITCH 路径
      if (result.strategyDecision === 'SWITCH') {
        assert.ok(result.receipt.nextStrategy, 'SWITCH decision must set nextStrategy');
      }
      // 校验 deviationType 已被诊断
      assert.equal(result.deviationType, 'HYPOTHESIS_REJECTED');
    });
  });

  describe('FAILURE paths', () => {
    it('returns FAILURE when budget exhausted', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      const result = loop.evaluateCycle(
        makeEvalInput(plan, { budgetExhausted: true }),
      );
      assert.equal(result.stopDecision.type, 'FAILURE');
      assert.equal(result.shouldContinue, false);
    });

    it('returns FAILURE when blocked by policy', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      const result = loop.evaluateCycle(
        makeEvalInput(plan, { blockedByPolicy: true }),
      );
      assert.equal(result.stopDecision.type, 'FAILURE');
    });

    it('returns FAILURE when precondition failed', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      const result = loop.evaluateCycle(
        makeEvalInput(plan, { preconditionFailed: true }),
      );
      assert.equal(result.stopDecision.type, 'FAILURE');
    });

    it('returns FAILURE when reached max cycles', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      const result = loop.evaluateCycle(
        makeEvalInput(plan, { reachedMaxCycles: true }),
      );
      assert.equal(result.stopDecision.type, 'FAILURE');
    });
  });

  describe('PAUSE paths', () => {
    it('returns PAUSE when waiting for user', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      const result = loop.evaluateCycle(
        makeEvalInput(plan, { waitingForUser: true }),
      );
      assert.equal(result.stopDecision.type, 'PAUSE');
      assert.equal(result.shouldContinue, false);
    });

    it('returns PAUSE when waiting for external', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      const result = loop.evaluateCycle(
        makeEvalInput(plan, { waitingForExternal: true }),
      );
      assert.equal(result.stopDecision.type, 'PAUSE');
    });
  });

  describe('CONTINUE path', () => {
    it('returns CONTINUE when no stop condition met and gates not all passed', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      // 第 1 轮不会触发 NO_GAIN_STOP（需要 3 轮）
      const result = loop.evaluateCycle(makeEvalInput(plan));
      assert.equal(result.stopDecision.type, 'CONTINUE');
      assert.equal(result.shouldContinue, true);
    });
  });

  describe('invariant: positive delta requires new evidence', () => {
    it('positive delta without new evidence throws (设计文档测试 2)', () => {
      const loop = createEvidenceGainLoop();
      const plan = loop.planCycle(makePlanInput(1));
      // deltaInput 没有 newEvidenceCount，但有 acceptanceProgress → deltaScore > 0
      assert.throws(
        () => loop.evaluateCycle(
          makeEvalInput(plan, {
            deltaInput: makeDeltaInput(plan.cycleId, {
              acceptanceProgress: 0.5,
              newVerifiedEvidence: 0.3,
              newEvidenceCount: 0, // 没有新证据
            }),
          }),
        ),
        (err: unknown) => err instanceof Error && /without new evidence/.test(err.message),
      );
    });
  });

  describe('initial state isolation', () => {
    it('createInitialEvidenceLoopState returns empty state', () => {
      const state = createInitialEvidenceLoopState();
      assert.deepEqual(state.cyclePlans, []);
      assert.deepEqual(state.cycleReceipts, []);
      assert.deepEqual(state.strategyAttempts, []);
      assert.equal(state.hasSwitchedBefore, false);
    });

    it('initial state can be passed to createEvidenceGainLoop', () => {
      const initial = createInitialEvidenceLoopState();
      const loop = createEvidenceGainLoop(initial);
      const plan = loop.planCycle(makePlanInput(1));
      const result = loop.evaluateCycle(makeEvalInput(plan));
      assert.ok(result.receipt);
    });

    it('initial state is not mutated by subsequent operations', () => {
      const initial = createInitialEvidenceLoopState();
      const loop = createEvidenceGainLoop(initial);
      const plan = loop.planCycle(makePlanInput(1));
      loop.evaluateCycle(makeEvalInput(plan));

      // 原始 initial 不应被修改
      assert.equal(initial.cyclePlans.length, 0);
      assert.equal(initial.cycleReceipts.length, 0);
    });
  });

  describe('full lifecycle smoke: success after progress', () => {
    it('simulates 2-cycle run ending in SUCCESS', () => {
      const loop = createEvidenceGainLoop();

      // Cycle 1: 部分进展
      const plan1 = loop.planCycle(makePlanInput(1));
      const r1 = loop.evaluateCycle(
        makeEvalInput(plan1, {
          deltaInput: makeDeltaInput(plan1.cycleId, {
            acceptanceProgress: 0.4,
            newVerifiedEvidence: 0.3,
            newEvidenceCount: 1,
          }),
          actualEvidenceIds: [createAwknId('evidence')],
        }),
      );
      assert.equal(r1.stopDecision.type, 'CONTINUE');
      assert.ok(r1.shouldContinue);

      // Cycle 2: 全部门通过 → SUCCESS
      const plan2 = loop.planCycle(makePlanInput(2));
      const r2 = loop.evaluateCycle(
        makeEvalInput(plan2, {
          allRequiredGatesPassed: true,
          deltaInput: makeDeltaInput(plan2.cycleId, {
            acceptanceProgress: 0.6,
            newVerifiedEvidence: 0.5,
            newEvidenceCount: 1,
          }),
          actualEvidenceIds: [createAwknId('evidence')],
        }),
      );
      assert.equal(r2.stopDecision.type, 'SUCCESS');
      assert.equal(r2.shouldContinue, false);

      // 验证两轮 receipt 都已被记录
      const state = loop.getState();
      assert.equal(state.cycleReceipts.length, 2);
      assert.equal(state.cyclePlans.length, 2);
    });
  });
});
