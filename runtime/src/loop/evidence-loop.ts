/**
 * Evidence Loop 主入口 (Phase 6 / C06 / WP-AOS-11)
 *
 * 设计文档：`docs/agent-os-3.0/07-Evidence-Gain-Loop.md` 第二节
 *
 * 主流程：
 * ```text
 * GoalSpec
 * → Build Cycle Plan (Declare Hypothesis, Expected Evidence)
 * → Execute Actions
 * → Collect Evidence
 * → Calculate Evidence Delta
 * → Evaluate Gates
 * → Diagnose Deviation
 * → Continue / Switch / Pause / Stop
 * → Record Cycle Receipt
 * ```
 *
 * 本模块为纯编排层，不直接执行 LLM 调用或工具调用。
 * 上层（AgentLoop.runL2）负责实际执行，通过 ExecutionResult 把结果回传给本模块。
 */

import type {
  CycleReceipt,
  DeviationType,
  EvidenceCyclePlan,
  EvidenceDelta,
  StrategyAttempt,
  StrategyDecision,
} from '../contracts/evidence-loop.js';
import { CycleReceiptSchema, createCycleId } from '../contracts/evidence-loop.js';
import { createAwknId } from '../contracts/ids.js';
import { toUtcTimestamp } from '../contracts/time.js';
import {
  buildStrategyAttempt,
  StrategySwitcher,
  type StrategySwitcherConfig,
  type SwitchAssessment,
} from './strategy-switcher.js';
import { calculateEvidenceDelta, type EvidenceDeltaInput } from './evidence-delta.js';
import {
  defaultStrategyDecision,
  diagnoseDeviation,
  type DeviationInput,
} from './deviation.js';
import {
  assessStop,
  DEFAULT_STOP_CONFIG,
  isGoalAchieved,
  type StopAssessment,
  type StopAssessmentInput,
  type StopControllerConfig,
} from './stop-controller.js';
import { buildCyclePlan, type CyclePlanInput } from './cycle-planner.js';

/** Evidence Loop 错误 */
export class EvidenceLoopError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'EvidenceLoopError';
  }
}

/** Cycle 执行结果（由上层 AgentLoop 提供） */
export interface CycleExecutionResult {
  /** 实际收集到的证据 ID（来自 EvidenceRecord） */
  actualEvidenceIds: string[];
  /** 该 Cycle 消耗的 token 数 */
  tokens: number;
  /** 该 Cycle 持续时间（毫秒） */
  durationMs: number;
  /** 执行是否失败 */
  executionFailed: boolean;
  /** 错误指纹（如有） */
  errorFingerprint?: string;
  /** 即将执行的动作指纹（用于重复检测） */
  actionFingerprint: string;
  /** 结果指纹（用于策略历史） */
  resultFingerprint: string;
  /** 是否缺少必要上下文 */
  contextMissing: boolean;
  /** 是否权限不足 */
  authorizationDenied: boolean;
  /** 是否能力不足 */
  capabilityInsufficient: boolean;
  /** 是否发生回归 */
  regression: boolean;
  /** 是否证据推翻当前假设 */
  hypothesisRejected: boolean;
  /** 是否执行成功但未通过验收 */
  acceptanceMismatch: boolean;
  /** 是否排除了一个错误策略 */
  strategyEliminated: boolean;
  /** 是否减少了风险 */
  riskReduced: boolean;
  /** 是否确认了根因 */
  rootCauseConfirmed: boolean;
  /** 是否发现了新的约束 */
  constraintDiscovered: boolean;
}

/** Cycle 评估输入（上层提供 Gate/验收/预算等信号） */
export interface CycleEvaluationContext {
  /** 已通过的 Required 验收项数 */
  acceptancePassed: number;
  /** 总 Required 验收项数 */
  acceptanceTotal: number;
  /** 所有 Required Acceptance 是否全部通过 */
  allRequiredAcceptancePassed: boolean;
  /** Delivery 前置条件是否满足 */
  deliveryPreconditionsMet: boolean;
  /** 是否存在阻断 Policy */
  hasBlockingPolicy: boolean;
  /** Evidence 等级是否满足 Goal 要求 */
  evidenceLevelSatisfied: boolean;
  /** 所有 Gate 是否通过（包括 typecheck/test/lint/review） */
  allGatesPassed: boolean;

  /** 预算是否耗尽 */
  budgetExhausted: boolean;
  /** 是否无可用执行能力 */
  noCapability: boolean;
  /** 前提是否失效 */
  prerequisiteFailed: boolean;
  /** 安全/权限 Policy 是否阻断 */
  policyBlocked: boolean;
  /** 是否不可恢复的外部失败 */
  unrecoverableExternalFailure: boolean;

  /** 前几轮的 delta 历史（最新的在末尾） */
  recentDeltaScores: number[];
  /** 前几轮的 actionFingerprint 历史（最新的在末尾） */
  recentActionFingerprints: string[];
  /** 前几轮的 errorFingerprint 历史（最新的在末尾） */
  recentErrorFingerprints: string[];

  /** uncertainty / acceptanceProgress 状态（由上层从 GoalManager 获取） */
  uncertaintyBefore: number;
  uncertaintyAfter: number;
  acceptanceProgressBefore: number;
  acceptanceProgressAfter: number;
}

/** Cycle 评估输出 */
export interface CycleAssessment {
  /** 生成的 Cycle Receipt */
  receipt: CycleReceipt;
  /** 计算出的 Evidence Delta */
  delta: EvidenceDelta;
  /** 诊断出的偏差类型 */
  deviationType: DeviationType;
  /** 策略评估 */
  switchAssessment: SwitchAssessment;
  /** Stop 评估 */
  stopAssessment: StopAssessment;
  /** 最终决策（综合 switch + stop + deviation） */
  decision: StrategyDecision;
  /** 推荐的下一个策略（如有） */
  nextStrategy?: string;
  /** 是否达成 Goal */
  goalAchieved: boolean;
}

/** Evidence Loop 配置 */
export interface EvidenceLoopConfig {
  switcherConfig?: Partial<StrategySwitcherConfig>;
  stopConfig?: Partial<StopControllerConfig>;
}

/**
 * Evidence Loop
 *
 * 状态持有人：维护 StrategySwitcher（策略历史）。
 * 一个 EvidenceLoop 实例对应一个 Run。
 */
export class EvidenceLoop {
  private readonly switcher: StrategySwitcher;
  private readonly stopConfig: StopControllerConfig;
  private currentStrategyId: string;
  private currentHypothesis: string;
  private hasSwitchedStrategy = false;

  constructor(initialStrategyId: string, initialHypothesis: string, config: EvidenceLoopConfig = {}) {
    this.switcher = new StrategySwitcher(config.switcherConfig);
    this.stopConfig = { ...DEFAULT_STOP_CONFIG, ...config.stopConfig };
    this.currentStrategyId = initialStrategyId;
    this.currentHypothesis = initialHypothesis;
  }

  /** 当前策略 ID */
  get strategyId(): string {
    return this.currentStrategyId;
  }

  /** 当前假设 */
  get hypothesis(): string {
    return this.currentHypothesis;
  }

  /** 是否已切换过策略 */
  get hasSwitched(): boolean {
    return this.hasSwitchedStrategy;
  }

  /** Strategy Switcher 历史快照 */
  get strategyHistory() {
    return this.switcher.getHistory();
  }

  /**
   * 构建 Cycle Plan
   */
  buildPlan(input: Omit<CyclePlanInput, 'runId'> & { runId: string }): EvidenceCyclePlan {
    return buildCyclePlan(input);
  }

  /**
   * 评估一个 Cycle 的执行结果
   *
   * 主流程：
   * 1. 计算 EvidenceDelta
   * 2. 诊断 Deviation
   * 3. 评估 Strategy Switch
   * 4. 评估 Stop 条件
   * 5. 综合决策（CONTINUE / SWITCH / PAUSE / STOP）
   * 6. 生成 Cycle Receipt
   * 7. 记录策略尝试到 Switcher
   */
  assessCycle(input: {
    plan: EvidenceCyclePlan;
    execution: CycleExecutionResult;
    evaluation: CycleEvaluationContext;
  }): CycleAssessment {
    const { plan, execution, evaluation } = input;

    // 1. 计算 Evidence Delta
    const deltaInput: EvidenceDeltaInput = {
      cycleId: plan.cycleId,
      uncertaintyBefore: evaluation.uncertaintyBefore,
      uncertaintyAfter: evaluation.uncertaintyAfter,
      acceptanceProgressBefore: evaluation.acceptanceProgressBefore,
      acceptanceProgressAfter: evaluation.acceptanceProgressAfter,
      addedEvidenceIds: execution.actualEvidenceIds,
      removedOrInvalidatedEvidenceIds: [],
      confirmedClaimIds: [],
      disputedClaimIds: [],
      strategyEliminated: execution.strategyEliminated,
      riskReduced: execution.riskReduced,
      regression: execution.regression,
      rootCauseConfirmed: execution.rootCauseConfirmed,
      constraintDiscovered: execution.constraintDiscovered,
    };
    const delta = calculateEvidenceDelta(deltaInput);

    // 2. 诊断 Deviation
    const deviationInput: DeviationInput = {
      executionFailed: execution.executionFailed,
      errorFingerprint: execution.errorFingerprint,
      repeatedPattern: this.detectRepeatedPattern(execution.actionFingerprint, evaluation.recentActionFingerprints),
      contextMissing: execution.contextMissing,
      authorizationDenied: execution.authorizationDenied,
      capabilityInsufficient: execution.capabilityInsufficient,
      regression: execution.regression,
      hasNewEvidence: execution.actualEvidenceIds.length > 0,
      hypothesisRejected: execution.hypothesisRejected,
      acceptanceMismatch: execution.acceptanceMismatch,
    };
    const deviationType = diagnoseDeviation(deviationInput);

    // 3. 评估 Strategy Switch
    const switchAssessment = this.switcher.assess({
      nextActionFingerprint: execution.actionFingerprint,
      nextErrorFingerprint: execution.errorFingerprint,
      hypothesisRejected: execution.hypothesisRejected,
      regressionDetected: execution.regression,
      capabilityGap: execution.capabilityInsufficient,
    });

    // 4. 评估 Stop
    const consecutiveLowDelta = countConsecutiveLowDelta(evaluation.recentDeltaScores.concat(delta.deltaScore));
    const consecutiveSameAction = countConsecutiveSame(evaluation.recentActionFingerprints.concat(execution.actionFingerprint));
    const consecutiveSameError = execution.errorFingerprint
      ? countConsecutiveSame(evaluation.recentErrorFingerprints.concat(execution.errorFingerprint))
      : 0;

    const stopInput: StopAssessmentInput = {
      allRequiredAcceptancePassed: evaluation.allRequiredAcceptancePassed,
      deliveryPreconditionsMet: evaluation.deliveryPreconditionsMet,
      hasBlockingPolicy: evaluation.hasBlockingPolicy,
      evidenceLevelSatisfied: evaluation.evidenceLevelSatisfied,
      acceptancePassed: evaluation.acceptancePassed,
      acceptanceTotal: evaluation.acceptanceTotal,
      budgetExhausted: evaluation.budgetExhausted,
      noCapability: evaluation.noCapability,
      prerequisiteFailed: evaluation.prerequisiteFailed,
      policyBlocked: evaluation.policyBlocked,
      unrecoverableExternalFailure: evaluation.unrecoverableExternalFailure,
      consecutiveLowDeltaCount: consecutiveLowDelta,
      consecutiveSameActionCount: consecutiveSameAction,
      consecutiveSameErrorCount: consecutiveSameError,
      hasSwitchedStrategy: this.hasSwitchedStrategy,
      deviationType,
    };
    const stopAssessment = assessStop(stopInput, this.stopConfig);

    // 5. 综合决策
    const { decision, nextStrategy } = this.combineDecisions({
      deviationType,
      switchAssessment,
      stopAssessment,
    });

    // 6. 记录策略尝试
    const attempt = buildStrategyAttempt({
      strategyId: this.currentStrategyId,
      hypothesis: this.currentHypothesis,
      actionFingerprint: execution.actionFingerprint,
      resultFingerprint: execution.resultFingerprint,
      evidenceDeltaScore: delta.deltaScore,
      failureType: execution.errorFingerprint,
    });
    this.switcher.recordAttempt(attempt);

    // 7. 生成 Cycle Receipt
    const receipt: CycleReceipt = {
      schema: 'awkn-cycle-receipt/v1',
      receiptId: createAwknId('receipt'),
      runId: plan.runId,
      cycleId: plan.cycleId,
      cycle: plan.cycleNumber,
      hypothesis: plan.hypothesis,
      expectedEvidenceIds: plan.expectedEvidence.map((entry) => entry.expectedEvidenceId),
      actualEvidenceIds: execution.actualEvidenceIds,
      deltaScore: delta.deltaScore,
      deviationType,
      strategyDecision: decision,
      nextStrategy,
      tokens: execution.tokens,
      durationMs: execution.durationMs,
      createdAt: toUtcTimestamp(new Date()),
    };

    // 校验 Receipt
    CycleReceiptSchema.parse(receipt);

    // 8. 如果决策是 SWITCH，标记已切换并更新当前策略
    if (decision === 'SWITCH' && nextStrategy) {
      this.hasSwitchedStrategy = true;
      this.currentStrategyId = nextStrategy;
    }

    // 9. Goal 达成判定（Evidence + Gate 同时通过）
    const goalAchieved = isGoalAchieved({
      allRequiredAcceptancePassed: evaluation.allRequiredAcceptancePassed,
      allGatesPassed: evaluation.allGatesPassed,
      evidenceLevelSatisfied: evaluation.evidenceLevelSatisfied,
      deliveryPreconditionsMet: evaluation.deliveryPreconditionsMet,
      hasBlockingPolicy: evaluation.hasBlockingPolicy,
    });

    return {
      receipt,
      delta,
      deviationType,
      switchAssessment,
      stopAssessment,
      decision,
      nextStrategy,
      goalAchieved,
    };
  }

  /**
   * 恢复 Run 时重放历史策略尝试
   *
   * 用于 Run 恢复场景：通过 Event 重放恢复 Cycle 状态（设计文档第十四节验收）。
   * 注意：恢复不会重复已确认副作用（设计文档第十三节测试 10），
   * 因此本方法只更新内部状态，不触发任何外部执行。
   */
  replayHistory(attempts: readonly StrategyAttempt[]): void {
    this.switcher.reset();
    for (const attempt of attempts) {
      this.switcher.recordAttempt(attempt);
    }
    if (attempts.length > 0) {
      const last = attempts[attempts.length - 1]!;
      this.currentStrategyId = last.strategyId;
      this.currentHypothesis = last.hypothesis;
      this.hasSwitchedStrategy = new Set(attempts.map((a) => a.strategyId)).size > 1;
    }
  }

  // ===== 内部辅助 =====

  /**
   * 综合决策：将 deviation / switch / stop 三个信号合并为最终决策
   *
   * 优先级（从高到低）：
   * 1. StopAssessment.decision = STOP → 直接 STOP
   * 2. StopAssessment.decision = SWITCH（No-Gain 强制切换）→ SWITCH
   * 3. switchAssessment.shouldSwitch = true → SWITCH
   * 4. deviation 默认决策 → CONTINUE / SWITCH / PAUSE
   */
  private combineDecisions(input: {
    deviationType: DeviationType;
    switchAssessment: SwitchAssessment;
    stopAssessment: StopAssessment;
  }): { decision: StrategyDecision; nextStrategy?: string } {
    const { deviationType, switchAssessment, stopAssessment } = input;

    // Stop 优先
    if (stopAssessment.decision === 'STOP') {
      return { decision: 'STOP' };
    }
    if (stopAssessment.decision === 'SWITCH') {
      return {
        decision: 'SWITCH',
        nextStrategy: switchAssessment.suggestedNextStrategy ?? 'no-gain-replan',
      };
    }
    if (stopAssessment.decision === 'PAUSE') {
      return { decision: 'PAUSE' };
    }

    // Switcher 评估
    if (switchAssessment.shouldSwitch) {
      return {
        decision: 'SWITCH',
        nextStrategy: switchAssessment.suggestedNextStrategy,
      };
    }

    // Deviation 默认决策
    const deviationDecision = defaultStrategyDecision(deviationType);
    if (deviationDecision === 'SWITCH') {
      return {
        decision: 'SWITCH',
        nextStrategy: switchAssessment.suggestedNextStrategy ?? `switch-after-${deviationType.toLowerCase()}`,
      };
    }
    if (deviationDecision === 'PAUSE') {
      return { decision: 'PAUSE' };
    }
    if (deviationDecision === 'STOP') {
      return { decision: 'STOP' };
    }
    return { decision: 'CONTINUE' };
  }

  /**
   * 检测重复模式：当前 actionFingerprint 与最近的 N-1 个都相同 → 重复
   */
  private detectRepeatedPattern(currentFingerprint: string, recentFingerprints: readonly string[]): boolean {
    if (recentFingerprints.length === 0) return false;
    const window = recentFingerprints.slice(-2); // 最近 2 个
    return window.every((fp) => fp === currentFingerprint);
  }
}

// ===== 模块级辅助函数 =====

/** 计算数组末尾连续 <= 0 的元素个数 */
function countConsecutiveLowDelta(scores: readonly number[], threshold = 0): number {
  let count = 0;
  for (let i = scores.length - 1; i >= 0; i -= 1) {
    if (scores[i]! <= threshold) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

/** 计算数组末尾连续相同元素的个数 */
function countConsecutiveSame(values: readonly string[]): number {
  if (values.length === 0) return 0;
  let count = 1;
  const last = values[values.length - 1]!;
  for (let i = values.length - 2; i >= 0; i -= 1) {
    if (values[i] === last) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

// ===== 便捷工厂 =====

/** 创建一个新的 EvidenceLoop 实例 */
export function createEvidenceLoop(
  initialStrategyId: string,
  initialHypothesis: string,
  config?: EvidenceLoopConfig,
): EvidenceLoop {
  return new EvidenceLoop(initialStrategyId, initialHypothesis, config);
}

/** 生成新的 CycleId（便捷导出） */
export function newCycleId(): string {
  return createCycleId();
}
