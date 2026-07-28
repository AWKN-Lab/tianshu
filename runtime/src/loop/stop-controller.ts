/**
 * Stop Controller (Phase 6 / C06 / WP-AOS-11)
 *
 * 设计文档：`docs/agent-os-3.0/07-Evidence-Gain-Loop.md` 第八节
 *
 * 三类停止判定：
 *
 * 1. 成功（SUCCESS）
 *    - 所有 Required Acceptance 通过
 *    - Delivery 前置条件满足
 *    - 无阻断 Policy
 *    - Evidence 等级满足 Goal 要求
 *
 * 2. 失败（FAILURE）
 *    - 预算耗尽
 *    - 无可用执行能力
 *    - 前提失效
 *    - 安全或权限 Policy 阻断
 *    - 无法恢复的外部失败
 *
 * 3. No-Gain（默认）
 *    - 连续3轮 deltaScore <= 0
 *    - 或 连续3轮 actionFingerprint 相同
 *    - 或 连续3轮 errorFingerprint 相同
 *
 * 处理顺序：
 * 1. 强制 Strategy Switch
 * 2. 已切换过且仍无增量 → PAUSED 或 FAILED
 * 3. 输出已证实内容、未解决问题和下一步建议
 */

import type { DeviationType, StrategyDecision } from '../contracts/evidence-loop.js';

/** Stop Controller 错误 */
export class StopControllerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'StopControllerError';
  }
}

/** Stop 判定结果 */
export interface StopAssessment {
  decision: StrategyDecision;
  reason: StopReason;
  /** 已达成的验收项数 */
  acceptancePassed: number;
  /** 总验收项数 */
  acceptanceTotal: number;
  /** 诊断说明 */
  detail: string;
}

/** Stop 原因 */
export type StopReason =
  | 'SUCCESS'
  | 'BUDGET_EXHAUSTED'
  | 'NO_CAPABILITY'
  | 'PREREQUISITE_FAILED'
  | 'POLICY_BLOCKED'
  | 'UNRECOVERABLE_EXTERNAL_FAILURE'
  | 'NO_GAIN_CONSECUTIVE_LOW_DELTA'
  | 'NO_GAIN_REPEATED_ACTION'
  | 'NO_GAIN_REPEATED_ERROR'
  | 'CONTINUE';

/** Stop Controller 配置 */
export interface StopControllerConfig {
  /** 连续多少轮 deltaScore <= 0 触发 No-Gain（默认 3） */
  noGainLowDeltaLimit: number;
  /** 连续多少轮同一 actionFingerprint 触发 No-Gain（默认 3） */
  noGainRepeatedActionLimit: number;
  /** 连续多少轮同一 errorFingerprint 触发 No-Gain（默认 3） */
  noGainRepeatedErrorLimit: number;
}

export const DEFAULT_STOP_CONFIG: StopControllerConfig = {
  noGainLowDeltaLimit: 3,
  noGainRepeatedActionLimit: 3,
  noGainRepeatedErrorLimit: 3,
};

/** Stop 评估输入 */
export interface StopAssessmentInput {
  // === 成功条件 ===
  /** 所有 Required Acceptance 是否通过 */
  allRequiredAcceptancePassed: boolean;
  /** Delivery 前置条件是否满足 */
  deliveryPreconditionsMet: boolean;
  /** 是否存在阻断 Policy */
  hasBlockingPolicy: boolean;
  /** Evidence 等级是否满足 Goal 要求 */
  evidenceLevelSatisfied: boolean;
  /** 已通过的 Required 验收项数 */
  acceptancePassed: number;
  /** 总 Required 验收项数 */
  acceptanceTotal: number;

  // === 失败条件 ===
  /** 预算是否耗尽 */
  budgetExhausted: boolean;
  /** 是否无可用执行能力 */
  noCapability: boolean;
  /** 前提是否失效（如 GoalSpec.assumptions 被推翻） */
  prerequisiteFailed: boolean;
  /** 安全/权限 Policy 是否阻断 */
  policyBlocked: boolean;
  /** 是否不可恢复的外部失败 */
  unrecoverableExternalFailure: boolean;

  // === No-Gain 信号 ===
  /** 连续低 Delta 轮数 */
  consecutiveLowDeltaCount: number;
  /** 当前 actionFingerprint 连续重复次数 */
  consecutiveSameActionCount: number;
  /** 当前 errorFingerprint 连续重复次数 */
  consecutiveSameErrorCount: number;
  /** 是否已经切换过策略（用于决定 No-Gain 后是 PAUSE 还是 STOP） */
  hasSwitchedStrategy: boolean;

  // === 偏差类型（用于辅助决策） ===
  deviationType: DeviationType;
}

/**
 * 评估停止条件
 *
 * 评估顺序：
 * 1. 成功条件全部满足 → decision=STOP, reason=SUCCESS
 * 2. 失败条件 → decision=STOP, reason=FAILURE_*
 * 3. No-Gain 条件 → decision=STOP 或 PAUSE（视是否切换过策略）
 * 4. 否则 → decision=CONTINUE
 */
export function assessStop(input: StopAssessmentInput, config: StopControllerConfig = DEFAULT_STOP_CONFIG): StopAssessment {
  // 1. 成功判定
  if (
    input.allRequiredAcceptancePassed
    && input.deliveryPreconditionsMet
    && !input.hasBlockingPolicy
    && input.evidenceLevelSatisfied
  ) {
    return {
      decision: 'STOP',
      reason: 'SUCCESS',
      acceptancePassed: input.acceptancePassed,
      acceptanceTotal: input.acceptanceTotal,
      detail: 'all required acceptance passed, delivery preconditions met, no blocking policy, evidence level satisfied',
    };
  }

  // 2. 失败判定
  if (input.budgetExhausted) {
    return {
      decision: 'STOP',
      reason: 'BUDGET_EXHAUSTED',
      acceptancePassed: input.acceptancePassed,
      acceptanceTotal: input.acceptanceTotal,
      detail: 'budget exhausted',
    };
  }
  if (input.noCapability) {
    return {
      decision: 'STOP',
      reason: 'NO_CAPABILITY',
      acceptancePassed: input.acceptancePassed,
      acceptanceTotal: input.acceptanceTotal,
      detail: 'no execution capability available',
    };
  }
  if (input.prerequisiteFailed) {
    return {
      decision: 'STOP',
      reason: 'PREREQUISITE_FAILED',
      acceptancePassed: input.acceptancePassed,
      acceptanceTotal: input.acceptanceTotal,
      detail: 'prerequisite (assumption) invalidated',
    };
  }
  if (input.policyBlocked) {
    return {
      decision: 'STOP',
      reason: 'POLICY_BLOCKED',
      acceptancePassed: input.acceptancePassed,
      acceptanceTotal: input.acceptanceTotal,
      detail: 'safety or authorization policy blocked execution',
    };
  }
  if (input.unrecoverableExternalFailure) {
    return {
      decision: 'STOP',
      reason: 'UNRECOVERABLE_EXTERNAL_FAILURE',
      acceptancePassed: input.acceptancePassed,
      acceptanceTotal: input.acceptanceTotal,
      detail: 'unrecoverable external system failure',
    };
  }

  // 3. No-Gain 判定
  if (input.consecutiveLowDeltaCount >= config.noGainLowDeltaLimit) {
    return decideNoGain(input, 'NO_GAIN_CONSECUTIVE_LOW_DELTA', `consecutive low delta cycles: ${input.consecutiveLowDeltaCount}`);
  }
  if (input.consecutiveSameActionCount >= config.noGainRepeatedActionLimit) {
    return decideNoGain(input, 'NO_GAIN_REPEATED_ACTION', `consecutive same actionFingerprint: ${input.consecutiveSameActionCount}`);
  }
  if (input.consecutiveSameErrorCount >= config.noGainRepeatedErrorLimit) {
    return decideNoGain(input, 'NO_GAIN_REPEATED_ERROR', `consecutive same errorFingerprint: ${input.consecutiveSameErrorCount}`);
  }

  // 4. 继续
  return {
    decision: 'CONTINUE',
    reason: 'CONTINUE',
    acceptancePassed: input.acceptancePassed,
    acceptanceTotal: input.acceptanceTotal,
    detail: 'no stop condition met',
  };
}

/**
 * No-Gain 决策
 *
 * 处理顺序（设计文档第 8.4 节）：
 * 1. 强制 Strategy Switch
 * 2. 已切换过且仍无增量 → PAUSED 或 FAILED
 * 3. 输出已证实内容、未解决问题和下一步建议
 *
 * 此处：
 * - 如果未切换过策略 → SWITCH（让上层执行切换）
 * - 如果已切换过且仍 No-Gain → STOP（FAILED）或 PAUSE
 *
 * 简化策略：已切换过 → STOP；未切换过 → SWITCH
 */
function decideNoGain(
  input: StopAssessmentInput,
  reason: StopReason,
  detail: string,
): StopAssessment {
  if (input.hasSwitchedStrategy) {
    // 已切换过且仍 No-Gain → STOP（FAILED）
    return {
      decision: 'STOP',
      reason,
      acceptancePassed: input.acceptancePassed,
      acceptanceTotal: input.acceptanceTotal,
      detail: `no-gain after strategy switch: ${detail}`,
    };
  }
  // 未切换过 → 强制 SWITCH
  return {
    decision: 'SWITCH',
    reason,
    acceptancePassed: input.acceptancePassed,
    acceptanceTotal: input.acceptanceTotal,
    detail: `forcing strategy switch due to: ${detail}`,
  };
}

/**
 * 判定是否达成 Goal（用于 EvidenceLoop 上层判断）
 *
 * Goal 达成需要 Evidence 与 Gate 同时通过（设计文档第十三节测试 9）。
 */
export function isGoalAchieved(input: {
  allRequiredAcceptancePassed: boolean;
  allGatesPassed: boolean;
  evidenceLevelSatisfied: boolean;
  deliveryPreconditionsMet: boolean;
  hasBlockingPolicy: boolean;
}): boolean {
  return (
    input.allRequiredAcceptancePassed
    && input.allGatesPassed
    && input.evidenceLevelSatisfied
    && input.deliveryPreconditionsMet
    && !input.hasBlockingPolicy
  );
}
