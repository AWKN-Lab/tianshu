/**
 * Deviation Diagnoser (Phase 6 / C06 / WP-AOS-12)
 *
 * 设计文档: docs/agent-os-3.0/07-Evidence-Gain-Loop.md 第六节
 *
 * 职责：
 * - 根据 gate 结果、工具执行结果、evidence delta 诊断偏差类型
 * - 输出 DeviationType 和建议动作
 *
 * 偏差分类（9 种）：
 * - EXECUTION_ERROR: 工具/命令/代码执行失败
 * - HYPOTHESIS_REJECTED: 证据推翻当前假设
 * - CONTEXT_GAP: 缺少必要事实或文件
 * - AUTHORIZATION_GAP: 权限不足
 * - CAPABILITY_GAP: 当前模型或工具能力不足
 * - ACCEPTANCE_MISMATCH: 执行成功但不满足验收
 * - REPEATED_PATTERN: 动作和错误重复
 * - NO_EVIDENCE: 没有新证据
 * - REGRESSION: 新动作破坏已有能力
 *
 * Mode 0：纯函数，不持久化
 */

import type { DeviationType } from '../contracts/evidence-loop.js';

/** Deviation 诊断错误 */
export class DeviationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'DeviationError';
  }
}

/** Gate 结果摘要 */
export interface GateOutcome {
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
  readonly suggestion?: string;
}

/** 工具执行结果摘要 */
export interface ToolExecutionOutcome {
  readonly toolName: string;
  readonly succeeded: boolean;
  readonly errorMessage?: string;
}

/** Deviation 诊断输入 */
export interface DeviationInput {
  readonly gates: ReadonlyArray<GateOutcome>;
  readonly toolExecutions: ReadonlyArray<ToolExecutionOutcome>;
  readonly deltaScore: number;
  readonly gainType: string;
  readonly acceptanceProgress: number;
  /** 当前 cycle 的 actionFingerprint */
  readonly currentActionFingerprint?: string;
  /** 历史 actionFingerprint（最近 3 轮） */
  readonly recentActionFingerprints: ReadonlyArray<string>;
  /** 历史 errorFingerprint（最近 3 轮） */
  readonly recentErrorFingerprints: ReadonlyArray<string>;
  /** 当前假设 */
  readonly hypothesis?: string;
  /** 证据是否推翻假设 */
  readonly hypothesisRejected?: boolean;
  /** 是否检测到回滚或破坏 */
  readonly regressionDetected?: boolean;
}

/** Deviation 诊断结果 */
export interface DeviationDiagnosis {
  readonly deviationType: DeviationType;
  readonly reason: string;
  readonly recommendedAction: string;
}

/**
 * 诊断偏差类型
 *
 * 优先级（高 → 低）：
 * 1. REGRESSION: 检测到回滚或破坏
 * 2. EXECUTION_ERROR: 工具执行失败
 * 3. HYPOTHESIS_REJECTED: 证据推翻假设
 * 4. REPEATED_PATTERN: 动作/错误重复
 * 5. AUTHORIZATION_GAP: 权限不足
 * 6. CONTEXT_GAP: 缺少必要文件/事实
 * 7. CAPABILITY_GAP: 能力不足
 * 8. ACCEPTANCE_MISMATCH: 执行成功但不满足验收
 * 9. NO_EVIDENCE: 没有新证据
 */
export function diagnoseDeviation(input: DeviationInput): DeviationDiagnosis {
  // 1. REGRESSION
  if (input.regressionDetected || input.gainType === 'regression') {
    return {
      deviationType: 'REGRESSION',
      reason: 'new action damaged existing capability or deltaScore indicates regression',
      recommendedAction: 'rollback or isolate the regression change',
    };
  }

  // 2. EXECUTION_ERROR
  const failedTools = input.toolExecutions.filter((t) => !t.succeeded);
  if (failedTools.length > 0) {
    const toolNames = failedTools.map((t) => t.toolName).join(', ');
    return {
      deviationType: 'EXECUTION_ERROR',
      reason: `tool(s) failed: ${toolNames}`,
      recommendedAction: 'fix the execution error before proceeding',
    };
  }

  // 3. HYPOTHESIS_REJECTED
  if (input.hypothesisRejected) {
    return {
      deviationType: 'HYPOTHESIS_REJECTED',
      reason: `evidence rejected hypothesis: ${input.hypothesis ?? '(unknown)'}`,
      recommendedAction: 'switch to alternative hypothesis',
    };
  }

  // 4. REPEATED_PATTERN
  if (input.currentActionFingerprint && input.recentActionFingerprints.length >= 2) {
    const lastTwo = input.recentActionFingerprints.slice(-2);
    if (lastTwo.every((f) => f === input.currentActionFingerprint)) {
      return {
        deviationType: 'REPEATED_PATTERN',
        reason: `action fingerprint "${input.currentActionFingerprint}" repeated in consecutive cycles`,
        recommendedAction: 'force strategy switch to break the loop',
      };
    }
  }
  if (input.recentErrorFingerprints.length >= 2) {
    const lastTwo = input.recentErrorFingerprints.slice(-2);
    if (lastTwo[0] === lastTwo[1] && lastTwo[0]) {
      return {
        deviationType: 'REPEATED_PATTERN',
        reason: `error fingerprint "${lastTwo[0]}" repeated in consecutive cycles`,
        recommendedAction: 'force strategy switch to break the error loop',
      };
    }
  }

  // 5. AUTHORIZATION_GAP
  const authFailure = input.gates.find(
    (g) => !g.passed && /auth|permission|denied|forbidden/i.test(g.details ?? g.name),
  );
  if (authFailure) {
    return {
      deviationType: 'AUTHORIZATION_GAP',
      reason: `authorization denied: ${authFailure.details ?? authFailure.name}`,
      recommendedAction: 'request elevated authorization or user confirmation',
    };
  }

  // 6. CONTEXT_GAP
  const contextFailure = input.gates.find(
    (g) => !g.passed && /not found|missing|enoent|no such file/i.test(g.details ?? ''),
  );
  if (contextFailure) {
    return {
      deviationType: 'CONTEXT_GAP',
      reason: `missing context: ${contextFailure.details ?? contextFailure.name}`,
      recommendedAction: 'request Context Planner to supplement missing facts or files',
    };
  }

  // 7. CAPABILITY_GAP
  const capabilityFailure = input.gates.find(
    (g) => !g.passed && /timeout|out of memory|capacity|unsupported/i.test(g.details ?? ''),
  );
  if (capabilityFailure) {
    return {
      deviationType: 'CAPABILITY_GAP',
      reason: `capability insufficient: ${capabilityFailure.details ?? capabilityFailure.name}`,
      recommendedAction: 'request Broker to switch model or tool',
    };
  }

  // 8. ACCEPTANCE_MISMATCH
  const failedGates = input.gates.filter((g) => !g.passed);
  if (failedGates.length > 0 && input.deltaScore <= 0) {
    return {
      deviationType: 'ACCEPTANCE_MISMATCH',
      reason: `execution completed but ${failedGates.length} gate(s) failed and no progress`,
      recommendedAction: 'adjust the cycle plan or refine the approach',
    };
  }

  // 9. NO_EVIDENCE
  if (input.gainType === 'none' && input.deltaScore <= 0) {
    return {
      deviationType: 'NO_EVIDENCE',
      reason: 'no new evidence gained in this cycle',
      recommendedAction: 'consider pausing or escalating for human intervention',
    };
  }

  // 默认：如果有进展则视为可接受（非偏差）
  // 调用方应根据返回值判断是否需要切换策略
  return {
    deviationType: 'ACCEPTANCE_MISMATCH',
    reason: 'no specific deviation detected, but gates not all passed',
    recommendedAction: 'review gate details and adjust plan',
  };
}

/**
 * 根据 DeviationType 推荐默认策略决策
 */
export function recommendStrategyDecision(
  deviationType: DeviationType,
  hasSwitchedBefore: boolean,
): 'CONTINUE' | 'SWITCH' | 'PAUSE' | 'STOP' | 'WAITING_USER' | 'WAITING_AUTHORIZATION' {
  switch (deviationType) {
    case 'EXECUTION_ERROR':
      return hasSwitchedBefore ? 'PAUSE' : 'CONTINUE';
    case 'HYPOTHESIS_REJECTED':
      return 'SWITCH';
    case 'CONTEXT_GAP':
      return 'PAUSE';
    case 'AUTHORIZATION_GAP':
      return 'WAITING_AUTHORIZATION';
    case 'CAPABILITY_GAP':
      return 'SWITCH';
    case 'ACCEPTANCE_MISMATCH':
      return hasSwitchedBefore ? 'PAUSE' : 'CONTINUE';
    case 'REPEATED_PATTERN':
      return 'SWITCH';
    case 'NO_EVIDENCE':
      return hasSwitchedBefore ? 'STOP' : 'SWITCH';
    case 'REGRESSION':
      return 'STOP';
    default:
      return 'CONTINUE';
  }
}
