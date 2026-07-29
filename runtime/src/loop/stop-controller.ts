/**
 * Stop Controller (Phase 6 / C06 / WP-AOS-12)
 *
 * 设计文档: docs/agent-os-3.0/07-Evidence-Gain-Loop.md 第八节
 *
 * 职责：
 * - 评估停止条件（成功/失败/暂停/No-Gain）
 * - 包装 contracts/evaluateNoGainStop
 * - 统一输出停止决策
 *
 * 停止类型：
 * 8.1 成功：所有 Required Acceptance 通过、Delivery 前置满足、无阻断 Policy、Evidence 等级满足
 * 8.2 失败：预算耗尽、无可用能力、前提失效、安全阻断、外部失败
 * 8.3 暂停：等待用户/外部/定时/审核
 * 8.4 No-Gain：连续 3 轮 deltaScore<=0 或相同 action/error fingerprint
 *
 * Mode 0：纯函数，不持久化
 */

import type { CycleReceipt, StrategyAttempt, NoGainStopCondition } from '../contracts/evidence-loop.js';
import { evaluateNoGainStop } from '../contracts/evidence-loop.js';

/** 停止决策类型 */
export type StopDecision =
  | { type: 'CONTINUE' }
  | { type: 'SUCCESS'; reason: string }
  | { type: 'FAILURE'; reason: string }
  | { type: 'PAUSE'; reason: string }
  | { type: 'NO_GAIN_STOP'; condition: NoGainStopCondition; reason: string };

/** 停止控制输入 */
export interface StopControlInput {
  readonly cycleReceipts: ReadonlyArray<CycleReceipt>;
  readonly strategyAttempts: ReadonlyArray<StrategyAttempt>;
  /** 所有 required gate 是否通过 */
  readonly allRequiredGatesPassed: boolean;
  /** 预算是否耗尽 */
  readonly budgetExhausted: boolean;
  /** 是否有阻断 Policy */
  readonly blockedByPolicy: boolean;
  /** 是否等待用户确认 */
  readonly waitingForUser: boolean;
  /** 是否等待外部系统 */
  readonly waitingForExternal: boolean;
  /** 是否达到最大循环数 */
  readonly reachedMaxCycles: boolean;
  /** 前提是否失效 */
  readonly preconditionFailed: boolean;
}

/**
 * 评估停止条件
 *
 * 优先级：
 * 1. SUCCESS：所有 required gate 通过
 * 2. FAILURE：预算耗尽 / 前提失效 / Policy 阻断 / 最大循环
 * 3. PAUSE：等待用户 / 等待外部
 * 4. NO_GAIN_STOP：连续 3 轮无增量
 * 5. CONTINUE
 */
export function evaluateStopCondition(input: StopControlInput): StopDecision {
  // 1. SUCCESS
  if (input.allRequiredGatesPassed) {
    return {
      type: 'SUCCESS',
      reason: 'all required acceptance gates passed',
    };
  }

  // 2. FAILURE
  if (input.budgetExhausted) {
    return {
      type: 'FAILURE',
      reason: 'budget exhausted',
    };
  }
  if (input.preconditionFailed) {
    return {
      type: 'FAILURE',
      reason: 'precondition failed',
    };
  }
  if (input.blockedByPolicy) {
    return {
      type: 'FAILURE',
      reason: 'blocked by policy',
    };
  }
  if (input.reachedMaxCycles) {
    return {
      type: 'FAILURE',
      reason: 'reached max L2 cycles',
    };
  }

  // 3. PAUSE
  if (input.waitingForUser) {
    return {
      type: 'PAUSE',
      reason: 'waiting for user confirmation',
    };
  }
  if (input.waitingForExternal) {
    return {
      type: 'PAUSE',
      reason: 'waiting for external system',
    };
  }

  // 4. NO_GAIN_STOP
  const noGainCondition = evaluateNoGainStop(
    input.cycleReceipts,
    input.strategyAttempts,
  );
  if (
    noGainCondition.consecutiveLowDeltaCycles >= 3
    || noGainCondition.consecutiveSameActionCycles >= 3
    || noGainCondition.consecutiveSameErrorCycles >= 3
  ) {
    return {
      type: 'NO_GAIN_STOP',
      condition: noGainCondition,
      reason: `no-gain detected: ${noGainCondition.consecutiveLowDeltaCycles} low-delta, ${noGainCondition.consecutiveSameActionCycles} same-action, ${noGainCondition.consecutiveSameErrorCycles} same-error`,
    };
  }

  // 5. CONTINUE
  return { type: 'CONTINUE' };
}

/**
 * 判断是否应该停止
 */
export function shouldStop(decision: StopDecision): boolean {
  return decision.type !== 'CONTINUE';
}
