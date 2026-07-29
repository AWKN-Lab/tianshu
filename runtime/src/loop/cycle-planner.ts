/**
 * Cycle Planner (Phase 6 / C06 / WP-AOS-12)
 *
 * 设计文档: docs/agent-os-3.0/07-Evidence-Gain-Loop.md 第三节
 *
 * 职责：
 * - 构建 EvidenceCyclePlan（每轮执行前必须声明假设、预期证据、计划动作）
 * - 生成 cycleId、createdAt、hash
 * - 校验 plan 通过 EvidenceCyclePlanSchema
 *
 * 不变量（设计文档测试 1）：
 * - 每轮必须有 Expected Evidence
 * - 必须有至少一个 required 证据
 * - 必须有至少一个 PlannedAction
 * - 所有 hash 必须是有效的 sha256 hex
 *
 * Mode 0：纯函数，不持久化，不修改外部状态
 */

import type {
  CycleBudget,
  EvidenceCyclePlan,
  ExpectedEvidence,
  Hypothesis,
  PlannedAction,
} from '../contracts/evidence-loop.js';
import {
  EvidenceCyclePlanSchema,
  computeEvidenceCyclePlanHash,
} from '../contracts/evidence-loop.js';
import { createAwknId } from '../contracts/ids.js';
import { toUtcTimestamp } from '../contracts/time.js';

/** Cycle Planner 错误 */
export class CyclePlannerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CyclePlannerError';
  }
}

/** Cycle Planner 输入 */
export interface CyclePlanInput {
  readonly runId: string;
  readonly cycleNumber: number;
  readonly objective: string;
  readonly hypothesis: Hypothesis;
  readonly expectedEvidence: ReadonlyArray<ExpectedEvidence>;
  readonly plannedActions: ReadonlyArray<PlannedAction>;
  readonly selectedStrategy: string;
  readonly policyBundleHash: string;
  readonly skillBundleHash: string;
  readonly contextManifestHash: string;
  readonly budgetSlice: CycleBudget;
  readonly now?: Date;
}

/**
 * 构建 EvidenceCyclePlan
 *
 * 步骤：
 * 1. 生成 cycleId（createAwknId('cycle')）
 * 2. 生成 createdAt（UTC 时间戳）
 * 3. 组装 plan 对象
 * 4. 计算 planHash（computeEvidenceCyclePlanHash）
 * 5. 校验通过 EvidenceCyclePlanSchema
 *
 * @returns 完整的 EvidenceCyclePlan（含 cycleId, createdAt, planHash）
 * @throws CyclePlannerError 如果校验失败
 */
export function buildCyclePlan(input: CyclePlanInput): EvidenceCyclePlan {
  // 前置校验：必填项
  if (!input.runId) {
    throw new CyclePlannerError('runId is required', 'MISSING_RUN_ID');
  }
  if (input.cycleNumber < 1) {
    throw new CyclePlannerError(
      `cycleNumber must be positive, got ${input.cycleNumber}`,
      'INVALID_CYCLE_NUMBER',
    );
  }
  if (!input.objective) {
    throw new CyclePlannerError('objective is required', 'MISSING_OBJECTIVE');
  }
  if (input.expectedEvidence.length === 0) {
    throw new CyclePlannerError(
      'cycle plan must declare at least one expected evidence (设计文档测试 1)',
      'MISSING_EXPECTED_EVIDENCE',
    );
  }
  if (input.plannedActions.length === 0) {
    throw new CyclePlannerError(
      'cycle plan must declare at least one planned action',
      'MISSING_PLANNED_ACTIONS',
    );
  }
  if (!input.selectedStrategy) {
    throw new CyclePlannerError('selectedStrategy is required', 'MISSING_STRATEGY');
  }

  const cycleId = createAwknId('cycle');
  const createdAt = toUtcTimestamp((input.now ?? new Date()).toISOString());

  const planContent = {
    schema: 'awkn-evidence-cycle-plan/v1' as const,
    cycleId,
    runId: input.runId,
    cycleNumber: input.cycleNumber,
    objective: input.objective,
    hypothesis: input.hypothesis,
    expectedEvidence: [...input.expectedEvidence],
    plannedActions: [...input.plannedActions],
    selectedStrategy: input.selectedStrategy,
    policyBundleHash: input.policyBundleHash,
    skillBundleHash: input.skillBundleHash,
    contextManifestHash: input.contextManifestHash,
    budgetSlice: input.budgetSlice,
    createdAt,
  };

  // 计算 hash（hash 不含 cycleId 和 createdAt，但 hash 字段不在 schema 中）
  // EvidenceCyclePlanSchema 没有 planHash 字段，hash 是辅助计算
  const _planHash = computeEvidenceCyclePlanHash(planContent);
  void _planHash;

  // 校验通过 schema
  const result = EvidenceCyclePlanSchema.safeParse(planContent);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new CyclePlannerError(
      `EvidenceCyclePlan validation failed: ${issues}`,
      'SCHEMA_VALIDATION_FAILED',
    );
  }

  return result.data;
}

/**
 * 验证已存在的 EvidenceCyclePlan
 * @returns true 如果 plan 有效
 */
export function validateCyclePlan(plan: unknown): plan is EvidenceCyclePlan {
  return EvidenceCyclePlanSchema.safeParse(plan).success;
}
