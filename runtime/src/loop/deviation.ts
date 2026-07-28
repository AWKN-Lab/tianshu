/**
 * Deviation Diagnoser (Phase 6 / C06 / WP-AOS-11)
 *
 * 设计文档：`docs/agent-os-3.0/07-Evidence-Gain-Loop.md` 第六节
 *
 * 根据执行结果分类偏差类型，fail-closed（未知情况归为 EXECUTION_ERROR）。
 *
 * | 类型 | 含义 | 默认动作 |
 * |---|---|---|
 * | EXECUTION_ERROR        | 工具/命令/代码执行失败   | 修复执行错误 |
 * | HYPOTHESIS_REJECTED    | 证据推翻当前假设         | 切换假设 |
 * | CONTEXT_GAP            | 缺少必要事实或文件       | 请求 Context Planner 增补 |
 * | AUTHORIZATION_GAP      | 权限不足                 | WAITING_AUTHORIZATION |
 * | CAPABILITY_GAP         | 模型/工具能力不足        | 请求 Broker 切换 |
 * | ACCEPTANCE_MISMATCH    | 执行成功但不满足验收     | 调整计划 |
 * | REPEATED_PATTERN       | 动作和错误重复           | 强制策略切换 |
 * | NO_EVIDENCE            | 没有新证据               | 停止或人工介入 |
 * | REGRESSION             | 新动作破坏已有能力       | 回滚或隔离 |
 */

import type { DeviationType } from '../contracts/evidence-loop.js';

/** Deviation Diagnoser 错误 */
export class DeviationDiagnoserError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'DeviationDiagnoserError';
  }
}

/** 偏差诊断输入 */
export interface DeviationInput {
  /** 执行是否失败（工具/命令/LLM 异常） */
  executionFailed: boolean;
  /** 错误指纹（用于检测重复错误） */
  errorFingerprint?: string;
  /** 是否检测到重复模式（同一 actionFingerprint 重复） */
  repeatedPattern: boolean;
  /** 是否缺少必要上下文（文件、配置等） */
  contextMissing: boolean;
  /** 是否权限不足 */
  authorizationDenied: boolean;
  /** 是否能力不足（模型/工具无法满足需求） */
  capabilityInsufficient: boolean;
  /** 是否发生回归（破坏已有能力） */
  regression: boolean;
  /** 是否收集到新证据 */
  hasNewEvidence: boolean;
  /** 是否证据推翻当前假设 */
  hypothesisRejected: boolean;
  /** 是否执行成功但未通过验收 */
  acceptanceMismatch: boolean;
}

/**
 * 诊断偏差类型
 *
 * 优先级顺序（从前到后）：
 * 1. REPEATED_PATTERN  - 重复模式优先级最高，强制切换策略
 * 2. REGRESSION        - 回滚或隔离
 * 3. AUTHORIZATION_GAP - 等待授权
 * 4. CAPABILITY_GAP    - 请求 Broker 切换
 * 5. CONTEXT_GAP       - 请求 Context Planner 增补
 * 6. EXECUTION_ERROR   - 执行错误
 * 7. HYPOTHESIS_REJECTED - 切换假设
 * 8. NO_EVIDENCE       - 无新证据
 * 9. ACCEPTANCE_MISMATCH - 调整计划
 * 10. fallback → EXECUTION_ERROR (fail-closed)
 *
 * 注意：REPEATED_PATTERN 优先级最高是因为重复模式会浪费预算且通常掩盖其他问题。
 */
export function diagnoseDeviation(input: DeviationInput): DeviationType {
  // 1. 重复模式优先
  if (input.repeatedPattern) {
    return 'REPEATED_PATTERN';
  }

  // 2. 回归（破坏已有能力）
  if (input.regression) {
    return 'REGRESSION';
  }

  // 3. 授权不足
  if (input.authorizationDenied) {
    return 'AUTHORIZATION_GAP';
  }

  // 4. 能力不足
  if (input.capabilityInsufficient) {
    return 'CAPABILITY_GAP';
  }

  // 5. 上下文缺失
  if (input.contextMissing) {
    return 'CONTEXT_GAP';
  }

  // 6. 执行失败
  if (input.executionFailed) {
    return 'EXECUTION_ERROR';
  }

  // 7. 假设被推翻
  if (input.hypothesisRejected) {
    return 'HYPOTHESIS_REJECTED';
  }

  // 8. 无新证据（执行成功但没收集到证据）
  if (!input.hasNewEvidence) {
    return 'NO_EVIDENCE';
  }

  // 9. 验收不匹配（执行成功、有证据，但未通过验收）
  if (input.acceptanceMismatch) {
    return 'ACCEPTANCE_MISMATCH';
  }

  // 10. fail-closed：未知情况归为 EXECUTION_ERROR
  return 'EXECUTION_ERROR';
}

/**
 * 根据偏差类型推断默认策略决策
 *
 * 设计文档第六节"默认动作"映射到 StrategyDecision：
 * - EXECUTION_ERROR        → CONTINUE（修复后继续）
 * - HYPOTHESIS_REJECTED    → SWITCH（切换假设）
 * - CONTEXT_GAP            → PAUSE（请求 Context Planner 增补后恢复）
 * - AUTHORIZATION_GAP      → PAUSE（等待授权）
 * - CAPABILITY_GAP         → SWITCH（请求 Broker 切换）
 * - ACCEPTANCE_MISMATCH    → CONTINUE（调整计划后继续）
 * - REPEATED_PATTERN       → SWITCH（强制切换）
 * - NO_EVIDENCE            → PAUSE（停止或人工介入）
 * - REGRESSION             → SWITCH（回滚或隔离，需要切换策略）
 */
export function defaultStrategyDecision(deviation: DeviationType): 'CONTINUE' | 'SWITCH' | 'PAUSE' | 'STOP' {
  switch (deviation) {
    case 'EXECUTION_ERROR':
      return 'CONTINUE';
    case 'HYPOTHESIS_REJECTED':
      return 'SWITCH';
    case 'CONTEXT_GAP':
      return 'PAUSE';
    case 'AUTHORIZATION_GAP':
      return 'PAUSE';
    case 'CAPABILITY_GAP':
      return 'SWITCH';
    case 'ACCEPTANCE_MISMATCH':
      return 'CONTINUE';
    case 'REPEATED_PATTERN':
      return 'SWITCH';
    case 'NO_EVIDENCE':
      return 'PAUSE';
    case 'REGRESSION':
      return 'SWITCH';
    default:
      // fail-closed：未知归为 EXECUTION_ERROR 的语义 → CONTINUE 不合适，应为 STOP
      return 'STOP';
  }
}
