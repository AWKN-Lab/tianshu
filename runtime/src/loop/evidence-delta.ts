/**
 * Evidence Delta Calculator (Phase 6 / C06 / WP-AOS-11)
 *
 * 设计文档：`docs/agent-os-3.0/07-Evidence-Gain-Loop.md` 第五节
 *
 * DeltaScore 公式（设计文档 5.1）：
 *   DeltaScore =
 *     0.35 × AcceptanceProgress
 *   + 0.25 × UncertaintyReduction
 *   + 0.20 × NewVerifiedEvidence
 *   + 0.10 × StrategyElimination
 *   + 0.10 × RiskReduction
 *   - 0.30 × Regression
 *
 * 关键规则：
 * - 无新增证据且非根因确认/策略排除时 deltaScore 必须 <= 0（fail-closed）
 * - 根因确认（rootCauseConfirmed）可在无新证据时生成正 Delta
 * - 策略排除（strategyEliminated）可在无新证据时生成正 Delta
 * - 约束发现（constraintDiscovered）可在无新证据时生成正 Delta
 * - Regression 必须使 deltaScore 趋向负值
 */

import type { EvidenceDelta } from '../contracts/evidence-loop.js';
import { EvidenceDeltaSchema } from '../contracts/evidence-loop.js';

/** Delta Calculator 错误 */
export class EvidenceDeltaError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'EvidenceDeltaError';
  }
}

/** Delta Score 计算权重（设计文档 5.1） */
export const DELTA_WEIGHTS = {
  acceptanceProgress: 0.35,
  uncertaintyReduction: 0.25,
  newVerifiedEvidence: 0.20,
  strategyElimination: 0.10,
  riskReduction: 0.10,
  regression: -0.30,
} as const;

/** Delta Calculator 版本 */
export const DELTA_CALCULATOR_VERSION = 'awkn-evidence-delta-calculator/v1';

/** Delta 计算输入 */
export interface EvidenceDeltaInput {
  cycleId: string;
  uncertaintyBefore: number;  // [0, 1]
  uncertaintyAfter: number;   // [0, 1]
  acceptanceProgressBefore: number;  // [0, 1]
  acceptanceProgressAfter: number;   // [0, 1]
  addedEvidenceIds: string[];
  removedOrInvalidatedEvidenceIds: string[];
  confirmedClaimIds: string[];
  disputedClaimIds: string[];
  /** 是否排除了一个错误策略（即使是负面证据也算收获） */
  strategyEliminated: boolean;
  /** 是否减少了风险（例如：补全了补偿方案） */
  riskReduced: boolean;
  /** 是否发生回归（破坏已有能力） */
  regression: boolean;
  /** 是否确认了根因（root cause） */
  rootCauseConfirmed: boolean;
  /** 是否发现了新的约束 */
  constraintDiscovered: boolean;
}

/**
 * 计算 Evidence Delta
 *
 * 步骤：
 * 1. 计算各分量（归一化到 [0, 1]）
 * 2. 按权重累加得到 rawDelta
 * 3. 应用 fail-closed 规则：无新证据且无根因/策略排除/约束发现时强制 <= 0
 * 4. 确定 gainType
 * 5. clamp deltaScore 到 [-1, 1]
 * 6. 通过 schema 校验
 */
export function calculateEvidenceDelta(input: EvidenceDeltaInput): EvidenceDelta {
  validateRange('uncertaintyBefore', input.uncertaintyBefore);
  validateRange('uncertaintyAfter', input.uncertaintyAfter);
  validateRange('acceptanceProgressBefore', input.acceptanceProgressBefore);
  validateRange('acceptanceProgressAfter', input.acceptanceProgressAfter);

  // 1. 分量计算
  const acceptanceProgressDelta = clamp01(input.acceptanceProgressAfter - input.acceptanceProgressBefore);
  const uncertaintyReduction = clamp01(input.uncertaintyBefore - input.uncertaintyAfter);
  const newVerifiedEvidence = input.addedEvidenceIds.length > 0 ? 1 : 0;
  const strategyElimination = input.strategyEliminated ? 1 : 0;
  const riskReduction = input.riskReduced ? 1 : 0;
  const regression = input.regression ? 1 : 0;

  // 2. 加权累加
  let rawDelta =
    DELTA_WEIGHTS.acceptanceProgress * acceptanceProgressDelta
    + DELTA_WEIGHTS.uncertaintyReduction * uncertaintyReduction
    + DELTA_WEIGHTS.newVerifiedEvidence * newVerifiedEvidence
    + DELTA_WEIGHTS.strategyElimination * strategyElimination
    + DELTA_WEIGHTS.riskReduction * riskReduction
    + DELTA_WEIGHTS.regression * regression;

  // 2.1 根因确认和约束发现的额外贡献（设计文档 5.1：
  //     "即使验收进度没有上升，确认根因或排除错误策略也可以形成有效增量"）
  //     这两项不在公开 DELTA_WEIGHTS 中（保持公式 5.1 的 6 项权重和为 1.0），
  //     但作为有效增量计入 rawDelta，确保 rootCauseConfirmed / constraintDiscovered
  //     为 true 时能生成正 Delta。
  if (input.rootCauseConfirmed) {
    rawDelta += DELTA_WEIGHTS.strategyElimination; // 0.10
  }
  if (input.constraintDiscovered) {
    rawDelta += DELTA_WEIGHTS.riskReduction; // 0.10
  }

  // 3. fail-closed 规则
  const hasNewEvidence = input.addedEvidenceIds.length > 0;
  const hasRootCauseOrEquivalent = input.rootCauseConfirmed
    || input.strategyEliminated
    || input.constraintDiscovered;
  if (!hasNewEvidence && !hasRootCauseOrEquivalent && rawDelta > 0) {
    rawDelta = Math.min(0, rawDelta);
  }

  // Regression 强制非正
  if (input.regression) {
    rawDelta = Math.min(0, rawDelta);
  }

  // 4. clamp 到 [-1, 1]
  const deltaScore = Math.max(-1, Math.min(1, rawDelta));

  // 5. 确定 gainType
  const gainType = determineGainType(input, deltaScore, hasNewEvidence);

  // 6. 构造并校验
  const delta: EvidenceDelta = {
    schema: 'awkn-evidence-delta/v1',
    cycleId: input.cycleId,
    addedEvidenceIds: input.addedEvidenceIds,
    removedOrInvalidatedEvidenceIds: input.removedOrInvalidatedEvidenceIds,
    confirmedClaimIds: input.confirmedClaimIds,
    disputedClaimIds: input.disputedClaimIds,
    uncertaintyBefore: input.uncertaintyBefore,
    uncertaintyAfter: input.uncertaintyAfter,
    acceptanceProgressBefore: input.acceptanceProgressBefore,
    acceptanceProgressAfter: input.acceptanceProgressAfter,
    deltaScore,
    gainType,
  };

  return EvidenceDeltaSchema.parse(delta);
}

/**
 * 判定 gainType
 *
 * 优先级（从高到低）：
 * 1. regression → 'regression'
 * 2. hasNewEvidence AND deltaScore > 0 → 'progress'（新证据是主要收获）
 * 3. rootCauseConfirmed → 'root_cause'
 * 4. constraintDiscovered → 'constraint_discovery'
 * 5. strategyEliminated → 'strategy_elimination'
 * 6. deltaScore > 0（无新证据但有其他正向贡献，如 uncertaintyReduction）→ 'progress'
 * 7. 否则 → 'none'（包括 fail-closed 钳到 0 的情况）
 *
 * 注意：fail-closed 钳到 0 时（无新证据且无根因/策略排除/约束发现），
 * deltaScore <= 0，gainType 必须为 'none'，不能为 'progress'。
 */
function determineGainType(
  input: EvidenceDeltaInput,
  deltaScore: number,
  hasNewEvidence: boolean,
): EvidenceDelta['gainType'] {
  if (input.regression) return 'regression';
  // 有新证据且 deltaScore > 0 → 'progress' 优先
  if (hasNewEvidence && deltaScore > 0) return 'progress';
  // 无新证据但根因确认 → 'root_cause'
  if (input.rootCauseConfirmed) return 'root_cause';
  // 无新证据但约束发现 → 'constraint_discovery'
  if (input.constraintDiscovered) return 'constraint_discovery';
  // 无新证据但策略排除 → 'strategy_elimination'
  if (input.strategyEliminated) return 'strategy_elimination';
  // deltaScore > 0 但无新证据也无根因/策略排除/约束发现（仅来自其他分量）→ 'progress'
  if (deltaScore > 0) return 'progress';
  // fail-closed 钳到 0 或负值 → 'none'
  return 'none';
}

function validateRange(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new EvidenceDeltaError(`${name} must be finite: ${String(value)}`, 'NON_FINITE');
  }
  if (value < 0 || value > 1) {
    throw new EvidenceDeltaError(`${name} must be in [0, 1]: ${value}`, 'OUT_OF_RANGE');
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
