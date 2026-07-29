/**
 * Evidence-Gain Loop Coordinator (Phase 6 / C06 / WP-AOS-12)
 *
 * 设计文档: docs/agent-os-3.0/07-Evidence-Gain-Loop.md
 *
 * 职责：
 * - 协调 Evidence-Gain Loop 各组件（cycle-planner, evidence-delta, deviation, strategy-switcher, stop-controller）
 * - 提供 agent-loop.ts runL2 可调用的证据收集 API
 * - 生成 CycleReceipt（每轮执行的可观测回执）
 *
 * 集成方式（设计文档第十节 UPGRADE）：
 *   runL2 cycle {
 *     1. planCycle() → EvidenceCyclePlan
 *     2. runL1() 执行
 *     3. gates 执行
 *     4. evaluateCycle() → CycleReceipt + 策略决策
 *     5. 根据策略决策：CONTINUE / SWITCH / PAUSE / STOP
 *   }
 *
 * 不变量：
 * - 每轮都有 Cycle Receipt（设计文档验收 1）
 * - 连续无增量时系统不会盲目循环（设计文档验收 2）
 * - Strategy Switch 可观测（设计文档验收 3）
 * - Evidence 与 Acceptance 进度可查询（设计文档验收 4）
 *
 * Mode 0：纯协调器，不直接执行 LLM/工具调用
 */

import type {
  EvidenceCyclePlan,
  CycleReceipt,
  StrategyAttempt,
  StrategyDecision,
} from '../contracts/evidence-loop.js';
import {
  CycleReceiptSchema,
  computeCycleReceiptHash,
  createCycleReceiptId,
} from '../contracts/evidence-loop.js';
import type { EvidenceDelta } from '../contracts/evidence.js';
import { buildCyclePlan, type CyclePlanInput } from './cycle-planner.js';
import { calculateEvidenceDelta, type DeltaInput } from './evidence-delta.js';
import { diagnoseDeviation, recommendStrategyDecision, type DeviationInput } from './deviation.js';
import { evaluateStrategySwitch, recordStrategyAttempt, type StrategySwitchResult } from './strategy-switcher.js';
import { evaluateStopCondition, shouldStop, type StopControlInput, type StopDecision } from './stop-controller.js';
import { toUtcTimestamp } from '../contracts/time.js';

/** Evidence-Gain Loop 错误 */
export class EvidenceLoopError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'EvidenceLoopError';
  }
}

/** Cycle 评估输入 */
export interface CycleEvaluationInput {
  readonly cyclePlan: EvidenceCyclePlan;
  readonly deltaInput: DeltaInput;
  readonly deviationInput: Omit<DeviationInput, 'deltaScore' | 'gainType' | 'acceptanceProgress'>;
  readonly allRequiredGatesPassed: boolean;
  readonly budgetExhausted: boolean;
  readonly blockedByPolicy: boolean;
  readonly reachedMaxCycles: boolean;
  readonly waitingForUser: boolean;
  readonly waitingForExternal: boolean;
  readonly preconditionFailed: boolean;
  /** 实际收集的证据 ID（必须是 ev_ 前缀） */
  readonly actualEvidenceIds?: ReadonlyArray<string>;
  /** 本轮消耗的 tokens */
  readonly tokens?: number;
  /** 本轮耗时（毫秒） */
  readonly durationMs?: number;
  readonly now?: Date;
}

/** Cycle 评估结果 */
export interface CycleEvaluationResult {
  readonly receipt: CycleReceipt;
  readonly delta: EvidenceDelta;
  readonly deviationType: import('../contracts/evidence-loop.js').DeviationType;
  readonly strategyDecision: StrategyDecision;
  readonly strategySwitch: StrategySwitchResult;
  readonly stopDecision: StopDecision;
  readonly shouldContinue: boolean;
}

/** Evidence-Gain Loop 状态（内部可变） */
export interface EvidenceLoopState {
  readonly cyclePlans: EvidenceCyclePlan[];
  readonly cycleReceipts: CycleReceipt[];
  readonly strategyAttempts: StrategyAttempt[];
  readonly hasSwitchedBefore: boolean;
}

/** 内部可变状态 */
interface MutableLoopState {
  cyclePlans: EvidenceCyclePlan[];
  cycleReceipts: CycleReceipt[];
  strategyAttempts: StrategyAttempt[];
  hasSwitchedBefore: boolean;
}

/** 创建初始状态 */
export function createInitialEvidenceLoopState(): EvidenceLoopState {
  return {
    cyclePlans: [],
    cycleReceipts: [],
    strategyAttempts: [],
    hasSwitchedBefore: false,
  };
}

/**
 * Evidence-Gain Loop 协调器
 *
 * 用法：
 * ```typescript
 * const loop = createEvidenceGainLoop();
 * const plan = loop.planCycle(planInput);
 * // ... 执行 L1, gates ...
 * const result = loop.evaluateCycle(evalInput);
 * if (result.shouldContinue) { ... } else { ... }
 * ```
 */
export interface EvidenceGainLoop {
  planCycle(input: CyclePlanInput): EvidenceCyclePlan;
  evaluateCycle(input: CycleEvaluationInput): CycleEvaluationResult;
  getState(): EvidenceLoopState;
  recordStrategyAttempt(attempt: StrategyAttempt): void;
}

export function createEvidenceGainLoop(
  initialState: EvidenceLoopState = createInitialEvidenceLoopState(),
): EvidenceGainLoop {
  const state: MutableLoopState = {
    cyclePlans: [...initialState.cyclePlans],
    cycleReceipts: [...initialState.cycleReceipts],
    strategyAttempts: [...initialState.strategyAttempts],
    hasSwitchedBefore: initialState.hasSwitchedBefore,
  };

  return {
    planCycle(input: CyclePlanInput): EvidenceCyclePlan {
      const plan = buildCyclePlan(input);
      state.cyclePlans.push(plan);
      return plan;
    },

    evaluateCycle(input: CycleEvaluationInput): CycleEvaluationResult {
      // 1. 计算 EvidenceDelta
      const delta = calculateEvidenceDelta(input.deltaInput);

      // 2. 诊断偏差
      const deviation = diagnoseDeviation({
        ...input.deviationInput,
        deltaScore: delta.deltaScore,
        gainType: delta.gainType,
        acceptanceProgress: delta.components.acceptanceProgress,
      });

      // 3. 评估策略切换
      const strategySwitch = evaluateStrategySwitch(
        state.strategyAttempts,
        delta.deltaScore,
        state.hasSwitchedBefore,
      );

      // 4. 推荐策略决策
      const recommendedDecision = recommendStrategyDecision(
        deviation.deviationType,
        state.hasSwitchedBefore,
      );
      // 如果策略切换建议 SWITCH，覆盖推荐决策
      const strategyDecision: StrategyDecision =
        strategySwitch.shouldSwitch ? strategySwitch.decision : recommendedDecision;

      // 5. 评估停止条件
      const stopInput: StopControlInput = {
        cycleReceipts: state.cycleReceipts,
        strategyAttempts: state.strategyAttempts,
        allRequiredGatesPassed: input.allRequiredGatesPassed,
        budgetExhausted: input.budgetExhausted,
        blockedByPolicy: input.blockedByPolicy,
        waitingForUser: input.waitingForUser,
        waitingForExternal: input.waitingForExternal,
        reachedMaxCycles: input.reachedMaxCycles,
        preconditionFailed: input.preconditionFailed,
      };
      const stopDecision = evaluateStopCondition(stopInput);

      // 6. 生成 CycleReceipt
      const receipt = buildCycleReceipt({
        cyclePlan: input.cyclePlan,
        delta,
        deviationType: deviation.deviationType,
        strategyDecision,
        nextStrategy: strategySwitch.nextStrategy,
        actualEvidenceIds: input.actualEvidenceIds ?? [],
        tokens: input.tokens ?? 0,
        durationMs: input.durationMs ?? 0,
        now: input.now,
      });

      // 7. 更新状态
      state.cycleReceipts.push(receipt);

      // 8. 标记是否已切换过
      if (strategySwitch.shouldSwitch && !state.hasSwitchedBefore) {
        state.hasSwitchedBefore = true;
      }

      const shouldContinue = !shouldStop(stopDecision)
        && strategyDecision !== 'STOP'
        && strategyDecision !== 'PAUSE';

      return {
        receipt,
        delta,
        deviationType: deviation.deviationType,
        strategyDecision,
        strategySwitch,
        stopDecision,
        shouldContinue,
      };
    },

    getState(): EvidenceLoopState {
      return { ...state };
    },

    recordStrategyAttempt(attempt: StrategyAttempt): void {
      state.strategyAttempts = recordStrategyAttempt(state.strategyAttempts, attempt);
    },
  };
}

/** CycleReceipt 构建输入 */
interface CycleReceiptBuilderInput {
  readonly cyclePlan: EvidenceCyclePlan;
  readonly delta: EvidenceDelta;
  readonly deviationType: import('../contracts/evidence-loop.js').DeviationType;
  readonly strategyDecision: StrategyDecision;
  readonly nextStrategy?: string;
  readonly actualEvidenceIds: ReadonlyArray<string>;
  readonly tokens: number;
  readonly durationMs: number;
  readonly now?: Date;
}

/**
 * 构建 CycleReceipt
 */
function buildCycleReceipt(input: CycleReceiptBuilderInput): CycleReceipt {
  const receiptId = createCycleReceiptId();
  const createdAt = toUtcTimestamp((input.now ?? new Date()).toISOString());

  const receiptContent = {
    schema: 'awkn-cycle-receipt/v1' as const,
    receiptId,
    runId: input.cyclePlan.runId,
    cycle: input.cyclePlan.cycleNumber,
    hypothesis: input.cyclePlan.hypothesis.statement,
    expectedEvidenceIds: input.cyclePlan.expectedEvidence.map((e) => e.expectedEvidenceId),
    actualEvidenceIds: [...input.actualEvidenceIds],
    deltaScore: input.delta.deltaScore,
    gainType: input.delta.gainType,
    deviationType: input.deviationType,
    strategyDecision: input.strategyDecision,
    nextStrategy: input.nextStrategy,
    tokens: input.tokens,
    durationMs: input.durationMs,
    createdAt,
  };

  // 计算 hash（hash 不含 receiptId 和 createdAt）
  const _receiptHash = computeCycleReceiptHash(receiptContent);
  void _receiptHash;

  // 校验通过 schema
  const result = CycleReceiptSchema.safeParse(receiptContent);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new EvidenceLoopError(
      `CycleReceipt validation failed: ${issues}`,
      'RECEIPT_VALIDATION_FAILED',
    );
  }

  return result.data;
}
