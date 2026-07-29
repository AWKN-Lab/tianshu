/**
 * Strategy Switcher (Phase 6 / C06 / WP-AOS-12)
 *
 * 设计文档: docs/agent-os-3.0/07-Evidence-Gain-Loop.md 第七节
 *
 * 职责：
 * - 维护策略尝试历史（StrategyAttempt[]）
 * - 评估是否应触发策略切换（包装 contracts/assessStrategySwitch）
 * - 选择切换策略（更换假设/Skill/模型/工具/缩小范围/回滚/请求用户/结束）
 *
 * 切换触发（设计文档第七节）：
 * - 同一 Action Fingerprint 重复
 * - 同一错误指纹达到阈值
 * - 连续两轮 Delta 过低
 * - 当前假设被推翻
 * - Reviewer 指出架构级问题
 * - 成本继续上升且验收无进展
 *
 * Mode 0：纯函数，不持久化
 */

import type { StrategyAttempt, StrategyDecision } from '../contracts/evidence-loop.js';
import { assessStrategySwitch } from '../contracts/evidence-loop.js';

/** 策略切换选项 */
export const STRATEGY_SWITCH_OPTIONS = [
  'replace_hypothesis',
  'replace_skill',
  'replace_model',
  'replace_tool',
  'narrow_scope',
  'rollback_to_plan_freeze',
  'request_user_choice',
  'terminate_with_blocker',
] as const;
export type StrategySwitchOption = (typeof STRATEGY_SWITCH_OPTIONS)[number];

/** 策略切换结果 */
export interface StrategySwitchResult {
  readonly decision: StrategyDecision;
  readonly shouldSwitch: boolean;
  readonly reasons: ReadonlyArray<string>;
  readonly recommendedOption?: StrategySwitchOption;
  readonly nextStrategy?: string;
}

/**
 * 评估策略切换
 *
 * 包装 contracts/assessStrategySwitch，增加推荐选项
 */
export function evaluateStrategySwitch(
  attempts: ReadonlyArray<StrategyAttempt>,
  currentDeltaScore: number,
  hasSwitchedBefore: boolean,
): StrategySwitchResult {
  const assessment = assessStrategySwitch(attempts, currentDeltaScore);

  if (!assessment.shouldSwitch) {
    return {
      decision: 'CONTINUE',
      shouldSwitch: false,
      reasons: assessment.reasons,
    };
  }

  // 推荐切换选项
  const recommendedOption = recommendSwitchOption(assessment.reasons, hasSwitchedBefore);
  const decision: StrategyDecision = hasSwitchedBefore && recommendedOption === 'terminate_with_blocker'
    ? 'STOP'
    : 'SWITCH';

  return {
    decision,
    shouldSwitch: true,
    reasons: assessment.reasons,
    recommendedOption,
    nextStrategy: recommendedOption,
  };
}

/**
 * 根据切换原因推荐选项
 */
function recommendSwitchOption(
  reasons: ReadonlyArray<string>,
  hasSwitchedBefore: boolean,
): StrategySwitchOption {
  // 如果已切换过且仍无增量，终止
  if (hasSwitchedBefore && reasons.some((r) => r.includes('delta score non-positive'))) {
    return 'terminate_with_blocker';
  }

  // 假设被推翻 → 更换假设
  if (reasons.some((r) => r.includes('hypothesis rejected'))) {
    return 'replace_hypothesis';
  }

  // 动作重复 → 更换 Skill
  if (reasons.some((r) => r.includes('repeated action'))) {
    return 'replace_skill';
  }

  // 错误重复 → 更换工具
  if (reasons.some((r) => r.includes('repeated failure'))) {
    return 'replace_tool';
  }

  // 连续低 Delta → 缩小范围
  if (reasons.some((r) => r.includes('consecutive low delta'))) {
    return hasSwitchedBefore ? 'request_user_choice' : 'narrow_scope';
  }

  // 默认：缩小范围
  return 'narrow_scope';
}

/**
 * 记录策略尝试
 */
export function recordStrategyAttempt(
  attempts: ReadonlyArray<StrategyAttempt>,
  newAttempt: StrategyAttempt,
  maxHistory = 10,
): StrategyAttempt[] {
  const updated = [...attempts, newAttempt];
  // 保留最近 maxHistory 条
  return updated.slice(-maxHistory);
}
