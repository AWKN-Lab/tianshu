/**
 * Evidence Delta Calculator (Phase 6 / C06 / WP-AOS-12)
 *
 * 设计文档: docs/agent-os-3.0/07-Evidence-Gain-Loop.md 第五节
 *
 * 职责：
 * - 计算 EvidenceDelta（每轮执行后必须计算证据增量）
 * - DeltaScore 公式：0.35×Acceptance + 0.25×UncertaintyReduction + 0.20×NewEvidence + 0.10×StrategyElimination + 0.10×RiskReduction - 0.30×Regression
 * - 推断 gainType
 *
 * 不变量（设计文档测试 2）：
 * - 无新增证据不能生成正 Delta
 * - deltaScore 范围 [-1, 1]
 *
 * Mode 0：纯函数，不持久化
 */

import type { EvidenceDelta } from '../contracts/evidence.js';
import { EvidenceDeltaSchema } from '../contracts/evidence.js';

/** Delta Calculator 版本 */
export const DELTA_CALCULATOR_VERSION = 'awkn-evidence-delta-calculator/v1';

/** Delta 权重（设计文档第五节 5.1） */
export const DELTA_WEIGHTS = {
  acceptanceProgress: 0.35,
  uncertaintyReduction: 0.25,
  newVerifiedEvidence: 0.20,
  strategyElimination: 0.10,
  riskReduction: 0.10,
  regression: -0.30,
} as const;

/** Delta Calculator 错误 */
export class EvidenceDeltaError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'EvidenceDeltaError';
  }
}

/** Delta 计算输入 */
export interface DeltaInput {
  readonly cycleId: string;
  readonly acceptanceProgress: number;
  readonly uncertaintyReduction: number;
  readonly newVerifiedEvidence: number;
  readonly strategyElimination: number;
  readonly riskReduction: number;
  readonly regression: number;
  /** 新增验证证据数量（用于不变量检查：无新增证据不能生成正 Delta） */
  readonly newEvidenceCount?: number;
}

/**
 * 计算 DeltaScore
 *
 * 公式（设计文档 5.1）：
 * DeltaScore = 0.35×AcceptanceProgress + 0.25×UncertaintyReduction
 *            + 0.20×NewVerifiedEvidence + 0.10×StrategyElimination
 *            + 0.10×RiskReduction - 0.30×Regression
 */
export function computeDeltaScore(input: DeltaInput): number {
  const score =
    DELTA_WEIGHTS.acceptanceProgress * input.acceptanceProgress +
    DELTA_WEIGHTS.uncertaintyReduction * input.uncertaintyReduction +
    DELTA_WEIGHTS.newVerifiedEvidence * input.newVerifiedEvidence +
    DELTA_WEIGHTS.strategyElimination * input.strategyElimination +
    DELTA_WEIGHTS.riskReduction * input.riskReduction +
    DELTA_WEIGHTS.regression * input.regression;
  // 限制到 [-1, 1]
  return Math.max(-1, Math.min(1, score));
}

/**
 * 推断 gainType
 *
 * 规则：
 * 1. regression > 0 且 deltaScore < 0 → 'regression'
 * 2. acceptanceProgress > 0 → 'progress'
 * 3. uncertaintyReduction > 0 且 newVerifiedEvidence = 0 → 'root_cause'
 * 4. strategyElimination > 0 → 'strategy_elimination'
 * 5. deltaScore > 0 → 'constraint_discovery'
 * 6. 其他 → 'none'
 */
export function inferGainType(input: DeltaInput, deltaScore: number): EvidenceDelta['gainType'] {
  if (input.regression > 0 && deltaScore < 0) {
    return 'regression';
  }
  if (input.acceptanceProgress > 0) {
    return 'progress';
  }
  if (input.uncertaintyReduction > 0 && input.newVerifiedEvidence === 0) {
    return 'root_cause';
  }
  if (input.strategyElimination > 0) {
    return 'strategy_elimination';
  }
  if (deltaScore > 0) {
    return 'constraint_discovery';
  }
  return 'none';
}

/**
 * 计算 EvidenceDelta
 *
 * 不变量（设计文档测试 2）：
 * - 无新增证据不能生成正 Delta
 *
 * @throws EvidenceDeltaError 如果无新增证据但 deltaScore > 0
 */
export function calculateEvidenceDelta(input: DeltaInput): EvidenceDelta {
  // 范围校验
  validateRange('acceptanceProgress', input.acceptanceProgress);
  validateRange('uncertaintyReduction', input.uncertaintyReduction);
  validateRange('newVerifiedEvidence', input.newVerifiedEvidence);
  validateRange('strategyElimination', input.strategyElimination);
  validateRange('riskReduction', input.riskReduction);
  validateRange('regression', input.regression);

  const deltaScore = computeDeltaScore(input);

  // 不变量：无新增证据不能生成正 Delta
  const newEvidenceCount = input.newEvidenceCount ?? 0;
  if (newEvidenceCount === 0 && deltaScore > 0) {
    throw new EvidenceDeltaError(
      `cannot generate positive delta (${deltaScore}) without new evidence (设计文档测试 2)`,
      'POSITIVE_DELTA_WITHOUT_EVIDENCE',
    );
  }

  const gainType = inferGainType(input, deltaScore);

  const delta: EvidenceDelta = {
    schema: 'awkn-evidence-delta/v1',
    cycleId: input.cycleId,
    components: {
      acceptanceProgress: input.acceptanceProgress,
      uncertaintyReduction: input.uncertaintyReduction,
      newVerifiedEvidence: input.newVerifiedEvidence,
      strategyElimination: input.strategyElimination,
      riskReduction: input.riskReduction,
      regression: input.regression,
    },
    deltaScore,
    gainType,
    calculatorVersion: DELTA_CALCULATOR_VERSION,
  };

  // 校验通过 schema
  const result = EvidenceDeltaSchema.safeParse(delta);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new EvidenceDeltaError(
      `EvidenceDelta validation failed: ${issues}`,
      'SCHEMA_VALIDATION_FAILED',
    );
  }

  return result.data;
}

function validateRange(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new EvidenceDeltaError(
      `${name} must be in [0, 1], got ${value}`,
      'INVALID_RANGE',
    );
  }
}
