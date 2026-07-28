/**
 * Cycle Plan Builder (Phase 6 / C06 / WP-AOS-11)
 *
 * 设计文档：`docs/agent-os-3.0/07-Evidence-Gain-Loop.md` 第三节
 *
 * 职责：
 * - 根据 GoalSpec + ContextManifest + Policy/Skill Bundle 构建 EvidenceCyclePlan
 * - 强制声明假设（hypothesis）和预期证据（expectedEvidence）
 * - 绑定 policyBundleHash / skillBundleHash / contextManifestHash
 * - 从 GoalBudget 切出 CycleBudget
 *
 * fail-closed：
 * - 缺少必需 bundle hash → 抛错
 * - expectedEvidence 为空或不包含 required 项 → 抛错
 * - 未声明 hypothesis → 抛错
 */

import type { GoalSpec } from '../contracts/goal.js';
import type {
  CycleBudget,
  EvidenceCyclePlan,
  EvidenceSourceType,
  ExpectedEvidence,
  PlannedAction,
} from '../contracts/evidence-loop.js';
import { createCycleId } from '../contracts/evidence-loop.js';
import { createAwknId } from '../contracts/ids.js';

/** Cycle Plan Builder 错误 */
export class CyclePlannerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CyclePlannerError';
  }
}

/** Cycle Plan 构建输入 */
export interface CyclePlanInput {
  runId: string;
  cycleNumber: number;
  objective: string;
  hypothesis: string;
  selectedStrategy: string;
  expectedEvidence: ExpectedEvidence[];
  plannedActions: PlannedAction[];
  policyBundleHash: string;
  skillBundleHash: string;
  contextManifestHash: string;
  budgetSlice: CycleBudget;
}

/**
 * 从 GoalBudget 推导 Cycle 预算切片
 *
 * 简单策略：均分剩余预算到剩余 cycles，预留 reservedTokens 用于 review/overhead。
 */
export function sliceCycleBudget(
  goalBudget: GoalSpec['budget'],
  remainingCycles: number,
  reservedTokensPerCycle = 0,
): CycleBudget {
  if (remainingCycles <= 0) {
    throw new CyclePlannerError(
      'cannot slice budget: no remaining cycles',
      'NO_REMAINING_CYCLES',
    );
  }
  const usableTokens = Math.max(0, goalBudget.maxTokens - reservedTokensPerCycle * remainingCycles);
  const perCycleTokens = Math.max(1, Math.floor(usableTokens / remainingCycles));
  const perCycleDurationMs = Math.max(1, Math.floor(goalBudget.maxDurationMs / remainingCycles));
  return {
    schema: 'awkn-cycle-budget/v1',
    maxCycles: goalBudget.maxCycles,
    maxTokens: perCycleTokens,
    maxDurationMs: perCycleDurationMs,
    reservedTokens: reservedTokensPerCycle,
  };
}

/**
 * 构建 EvidenceCyclePlan
 *
 * fail-closed 检查：
 * - hypothesis 非空
 * - expectedEvidence 非空且至少一项 required
 * - plannedActions 引用的 expectedEvidenceId 必须存在
 * - plannedActions 不能有重复 actionFingerprint
 * - 三个 bundle hash 必须是 64 位 hex（由 schema 校验）
 */
export function buildCyclePlan(input: CyclePlanInput): EvidenceCyclePlan {
  if (!input.hypothesis.trim()) {
    throw new CyclePlannerError(
      'hypothesis must be declared before cycle execution',
      'MISSING_HYPOTHESIS',
    );
  }
  if (input.expectedEvidence.length === 0) {
    throw new CyclePlannerError(
      'expectedEvidence must be declared before cycle execution',
      'MISSING_EXPECTED_EVIDENCE',
    );
  }
  if (!input.expectedEvidence.some((entry) => entry.required)) {
    throw new CyclePlannerError(
      'at least one required expected evidence is required',
      'NO_REQUIRED_EVIDENCE',
    );
  }
  const expectedIds = new Set(input.expectedEvidence.map((entry) => entry.expectedEvidenceId));
  for (const action of input.plannedActions) {
    if (action.expectedEvidenceId !== undefined && !expectedIds.has(action.expectedEvidenceId)) {
      throw new CyclePlannerError(
        `plannedAction references unknown expectedEvidenceId: ${action.expectedEvidenceId}`,
        'UNKNOWN_EXPECTED_EVIDENCE_REF',
      );
    }
  }
  const fingerprints = input.plannedActions.map((action) => action.actionFingerprint);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const fingerprint of fingerprints) {
    if (seen.has(fingerprint)) duplicates.add(fingerprint);
    seen.add(fingerprint);
  }
  if (duplicates.size > 0) {
    throw new CyclePlannerError(
      `duplicate actionFingerprint in cycle plan: ${[...duplicates].sort().join(', ')}`,
      'DUPLICATE_ACTION_FINGERPRINT',
    );
  }

  const plan: EvidenceCyclePlan = {
    schema: 'awkn-evidence-cycle-plan/v1',
    cycleId: createCycleId(),
    runId: input.runId,
    cycleNumber: input.cycleNumber,
    objective: input.objective,
    hypothesis: input.hypothesis,
    expectedEvidence: input.expectedEvidence,
    plannedActions: input.plannedActions,
    selectedStrategy: input.selectedStrategy,
    policyBundleHash: input.policyBundleHash,
    skillBundleHash: input.skillBundleHash,
    contextManifestHash: input.contextManifestHash,
    budgetSlice: input.budgetSlice,
  };
  return plan;
}

/**
 * 从 GoalSpec 中提取 ExpectedEvidence 模板（辅助函数）
 *
 * 将 GoalSpec.evidenceSources 转换为 ExpectedEvidence 列表，调用方可在此基础上补充
 * description / successPredicate。
 *
 * 注意：GoalSpec.sourceType 与 EvidenceSourceType 枚举不完全重合，
 * 此处做映射：
 * - 'test' → 'command'
 * - 'model_statement' → 'tool'
 * - 其余一一对应
 */
export function deriveExpectedEvidenceFromGoal(goal: GoalSpec): ExpectedEvidence[] {
  return goal.evidenceSources.map((source) => {
    const mappedSourceType: EvidenceSourceType = source.sourceType === 'test'
      ? 'command'
      : source.sourceType === 'model_statement'
        ? 'tool'
        : source.sourceType;
    return {
      expectedEvidenceId: `ee_${source.sourceId}`,
      description: `evidence from ${source.sourceType} source ${source.sourceId}`,
      sourceType: mappedSourceType,
      evaluatorId: source.sourceId,
      successPredicate: { minimumLevel: source.minimumLevel },
      freshnessRequired: source.freshnessClass,
      required: source.required,
    };
  });
}

/** 生成新的 runId（用于 EvidenceLoop 启动新 Run 时） */
export function newRunId(): string {
  return createAwknId('run');
}
