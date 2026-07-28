/**
 * Strategy Switcher (Phase 6 / C06 / WP-AOS-11)
 *
 * 设计文档：`docs/agent-os-3.0/07-Evidence-Gain-Loop.md` 第七节
 *
 * 维护策略历史，检测：
 * - 同一 Action Fingerprint 重复
 * - 同一错误指纹达到阈值
 * - 连续两轮 Delta 过低
 * - 当前假设被推翻
 *
 * 切换选项（设计文档第七节）：
 * - 更换假设
 * - 更换 Skill
 * - 更换模型
 * - 更换工具
 * - 缩小任务范围
 * - 回到方案冻结
 * - 请求用户选择
 * - 结束并输出阻塞证据
 */

import type { StrategyAttempt } from '../contracts/evidence-loop.js';
import { toUtcTimestamp } from '../contracts/time.js';

/** Strategy Switcher 错误 */
export class StrategySwitcherError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'StrategySwitcherError';
  }
}

/** Switcher 配置 */
export interface StrategySwitcherConfig {
  /** 同一 actionFingerprint 重复多少次触发切换（默认 2，即第 2 次出现就切换） */
  actionFingerprintRepeatThreshold: number;
  /** 同一 errorFingerprint 达到多少次触发切换 */
  errorFingerprintRepeatThreshold: number;
  /** 连续多少轮 deltaScore <= lowDeltaThreshold 触发切换 */
  consecutiveLowDeltaLimit: number;
  /** 低 Delta 阈值 */
  lowDeltaThreshold: number;
  /** 历史窗口大小（仅保留最近 N 条 StrategyAttempt） */
  historyWindowSize: number;
}

export const DEFAULT_SWITCHER_CONFIG: StrategySwitcherConfig = {
  actionFingerprintRepeatThreshold: 2,
  errorFingerprintRepeatThreshold: 2,
  consecutiveLowDeltaLimit: 2,
  lowDeltaThreshold: 0,
  historyWindowSize: 20,
};

/** 切换触发原因 */
export type SwitchReason =
  | 'ACTION_FINGERPRINT_REPEAT'
  | 'ERROR_FINGERPRINT_REPEAT'
  | 'CONSECUTIVE_LOW_DELTA'
  | 'HYPOTHESIS_REJECTED'
  | 'REGRESSION_DETECTED'
  | 'CAPABILITY_GAP';

/** Switcher 评估结果 */
export interface SwitchAssessment {
  shouldSwitch: boolean;
  reason?: SwitchReason;
  /** 推荐的下一个策略（语义提示，由上层决定具体策略） */
  suggestedNextStrategy?: string;
  /** 触发切换的指纹（如有） */
  triggeringFingerprint?: string;
  /** 当前已尝试的独立策略数 */
  strategyCount: number;
}

/**
 * Strategy Switcher
 *
 * 状态持有人：维护 StrategyAttempt 历史，无副作用。
 * 上层（EvidenceLoop）负责根据 SwitchAssessment 决定是否真的切换。
 */
export class StrategySwitcher {
  private history: StrategyAttempt[] = [];
  private readonly config: StrategySwitcherConfig;

  constructor(config: Partial<StrategySwitcherConfig> = {}) {
    this.config = { ...DEFAULT_SWITCHER_CONFIG, ...config };
  }

  /** 记录一次策略尝试 */
  recordAttempt(attempt: StrategyAttempt): void {
    this.history.push(attempt);
    if (this.history.length > this.config.historyWindowSize) {
      this.history = this.history.slice(-this.config.historyWindowSize);
    }
  }

  /** 获取历史快照（不可变） */
  getHistory(): readonly StrategyAttempt[] {
    return [...this.history];
  }

  /** 已尝试的独立策略数 */
  get strategyCount(): number {
    return new Set(this.history.map((entry) => entry.strategyId)).size;
  }

  /**
   * 评估是否应该切换策略
   *
   * @param nextActionFingerprint 即将执行的动作指纹（用于预测重复）
   * @param nextErrorFingerprint 即将出现的错误指纹（如有，用于预测重复）
   * @param hypothesisRejected 当前假设是否被推翻
   * @param regressionDetected 是否检测到回归
   * @param capabilityGap 是否能力不足
   */
  assess(input: {
    nextActionFingerprint?: string;
    nextErrorFingerprint?: string;
    hypothesisRejected?: boolean;
    regressionDetected?: boolean;
    capabilityGap?: boolean;
  }): SwitchAssessment {
    const strategyCount = this.strategyCount;

    // 1. 假设被推翻 → 必须切换
    if (input.hypothesisRejected) {
      return {
        shouldSwitch: true,
        reason: 'HYPOTHESIS_REJECTED',
        suggestedNextStrategy: 'revise-hypothesis',
        strategyCount,
      };
    }

    // 2. 回归 → 必须切换
    if (input.regressionDetected) {
      return {
        shouldSwitch: true,
        reason: 'REGRESSION_DETECTED',
        suggestedNextStrategy: 'rollback-or-isolate',
        strategyCount,
      };
    }

    // 3. 能力不足 → 切换（请求 Broker）
    if (input.capabilityGap) {
      return {
        shouldSwitch: true,
        reason: 'CAPABILITY_GAP',
        suggestedNextStrategy: 'request-broker-switch',
        strategyCount,
      };
    }

    // 4. 同一 actionFingerprint 重复
    //    counting：历史出现次数 + 1（即将执行的这一次），达到阈值则切换
    //    例：threshold=2，历史 1 次 + 即将 1 次 = 2 → 触发（第 2 次出现）
    if (input.nextActionFingerprint) {
      const historicalCount = this.countActionFingerprint(input.nextActionFingerprint);
      const totalCount = historicalCount + 1; // +1 for the upcoming action
      if (totalCount >= this.config.actionFingerprintRepeatThreshold) {
        return {
          shouldSwitch: true,
          reason: 'ACTION_FINGERPRINT_REPEAT',
          suggestedNextStrategy: 'change-tool-or-approach',
          triggeringFingerprint: input.nextActionFingerprint,
          strategyCount,
        };
      }
    }

    // 5. 同一 errorFingerprint 达到阈值
    //    counting：历史出现次数 + 1（即将出现的这一次），达到阈值则切换
    if (input.nextErrorFingerprint) {
      const historicalCount = this.countErrorFingerprint(input.nextErrorFingerprint);
      const totalCount = historicalCount + 1; // +1 for the upcoming error
      if (totalCount >= this.config.errorFingerprintRepeatThreshold) {
        return {
          shouldSwitch: true,
          reason: 'ERROR_FINGERPRINT_REPEAT',
          suggestedNextStrategy: 'change-strategy-after-error-repeat',
          triggeringFingerprint: input.nextErrorFingerprint,
          strategyCount,
        };
      }
    }

    // 6. 连续 N 轮 deltaScore <= lowDeltaThreshold
    const consecutiveLow = this.countConsecutiveLowDelta();
    if (consecutiveLow >= this.config.consecutiveLowDeltaLimit) {
      return {
        shouldSwitch: true,
        reason: 'CONSECUTIVE_LOW_DELTA',
        suggestedNextStrategy: 'narrow-scope-or-replan',
        strategyCount,
      };
    }

    return { shouldSwitch: false, strategyCount };
  }

  /** 重置历史（用于新 Run） */
  reset(): void {
    this.history = [];
  }

  // ===== 内部辅助 =====

  private countActionFingerprint(fingerprint: string): number {
    return this.history.filter((entry) => entry.actionFingerprint === fingerprint).length;
  }

  private countErrorFingerprint(fingerprint: string): number {
    return this.history.filter((entry) => entry.failureType === fingerprint).length;
  }

  private countConsecutiveLowDelta(): number {
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const entry = this.history[i]!;
      if (entry.evidenceDeltaScore <= this.config.lowDeltaThreshold) {
        count += 1;
      } else {
        break;
      }
    }
    return count;
  }
}

/**
 * 构造 StrategyAttempt 的辅助函数
 *
 * 用于在 Cycle 结束后记录本次策略尝试。
 */
export function buildStrategyAttempt(input: {
  strategyId: string;
  hypothesis: string;
  actionFingerprint: string;
  resultFingerprint: string;
  evidenceDeltaScore: number;
  failureType?: string;
  usedAt?: string;
}): StrategyAttempt {
  return {
    strategyId: input.strategyId,
    hypothesis: input.hypothesis,
    actionFingerprint: input.actionFingerprint,
    resultFingerprint: input.resultFingerprint,
    evidenceDeltaScore: input.evidenceDeltaScore,
    failureType: input.failureType,
    usedAt: input.usedAt ?? toUtcTimestamp(new Date()),
  };
}
