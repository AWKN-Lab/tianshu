/**
 * 循环异常检测 — 从 awkn-agent 抽取
 *
 * 来源：awkn-agent/src/core/loop-monitor.ts
 * 改动：logger 从 awkn-agent 的 observability/logger 换成本地 logger
 *
 * 三类异常检测：
 * - 3-strike：连续失败超阈值
 * - 重复模式：工具调用历史里出现循环模式
 * - token 异常增长：最近 3 轮 token 增长超阈值
 */

import { createLogger } from './logger.js';

const logger = createLogger('LoopMonitor');

export interface LoopMonitorConfig {
  maxConsecutiveFailures: number;
  maxRepeatingPattern: number;
  maxTokenGrowth: number;
}

const DEFAULT_CONFIG: LoopMonitorConfig = {
  maxConsecutiveFailures: 3,
  maxRepeatingPattern: 3,
  maxTokenGrowth: 2.0,
};

export class LoopMonitor {
  private consecutiveFailures = 0;
  private toolCallHistory: string[] = [];
  private tokenHistory: number[] = [];
  private config: LoopMonitorConfig;

  constructor(config: Partial<LoopMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): boolean {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      logger.warn('Consecutive failure threshold reached', {
        count: this.consecutiveFailures,
      });
      return true;
    }
    return false;
  }

  recordToolCall(toolName: string): boolean {
    this.toolCallHistory.push(toolName);
    if (this.toolCallHistory.length > 20) {
      this.toolCallHistory = this.toolCallHistory.slice(-20);
    }
    return this.detectRepeatingPattern();
  }

  private detectRepeatingPattern(): boolean {
    const h = this.toolCallHistory;
    if (h.length < 4) return false;

    for (
      let patternLen = 1;
      patternLen <= Math.min(4, Math.floor(h.length / 2));
      patternLen++
    ) {
      const pattern = h.slice(-patternLen);
      let repeats = 0;
      for (let i = h.length - patternLen; i >= patternLen; i -= patternLen) {
        const candidate = h.slice(i - patternLen, i);
        if (JSON.stringify(candidate) === JSON.stringify(pattern)) {
          repeats++;
        } else {
          break;
        }
      }
      if (repeats >= this.config.maxRepeatingPattern) {
        logger.warn('Repeating pattern detected', { pattern, repeats });
        return true;
      }
    }
    return false;
  }

  recordTokenUsage(tokens: number): boolean {
    // M3 进阶-27（2026-07-23）：防御性 fail-closed
    //   原版：tokens 为 NaN/负数时直接 push → NaN > 2.0 = false → 静默通过 → "无信号被当作成功"
    //   修复：非有限正数视为异常（throw 让 caller 决定如何处理），不污染历史
    if (!Number.isFinite(tokens) || tokens < 0) {
      logger.warn('Invalid token count received, treating as anomaly', { tokens });
      return true;
    }
    this.tokenHistory.push(tokens);
    if (this.tokenHistory.length > 10) {
      this.tokenHistory = this.tokenHistory.slice(-10);
    }
    if (this.tokenHistory.length >= 3) {
      const recent = this.tokenHistory.slice(-3);
      if (recent[0] > 0 && recent[2] / recent[0] > this.config.maxTokenGrowth) {
        logger.warn('Token growth anomaly detected', { recent });
        return true;
      }
    }
    return false;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.toolCallHistory = [];
    this.tokenHistory = [];
  }

  getStatus(): { consecutiveFailures: number; historyLength: number } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      historyLength: this.toolCallHistory.length,
    };
  }
}
