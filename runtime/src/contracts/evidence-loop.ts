/**
 * Evidence-Gain Loop Contracts (Phase 6 / C06 / WP-AOS-11)
 *
 * 设计文档：`docs/agent-os-3.0/07-Evidence-Gain-Loop.md`
 *
 * 本文件冻结 Evidence-Gain Loop 的所有公开 Contract：
 * - EvidenceSourceTypeSchema：证据来源类型
 * - ExpectedEvidenceSchema：每轮开始前必须声明的预期证据
 * - PlannedActionSchema：计划动作
 * - CycleBudgetSchema：Cycle 预算切片
 * - EvidenceCyclePlanSchema (awkn-evidence-cycle-plan/v1)：Cycle 计划
 * - EvidenceDeltaSchema (awkn-evidence-delta/v1)：证据增量
 * - StrategyAttemptSchema：策略尝试历史
 * - DeviationTypeSchema：偏差分类（fail-closed：未知归为 EXECUTION_ERROR）
 * - StrategyDecisionSchema：策略决策
 * - CycleReceiptSchema (awkn-cycle-receipt/v1)：Cycle 收据
 *
 * 不变量：
 * - 所有 schema 使用 zod strict + superRefine
 * - 所有 hash 使用 stableHash（canonical-json.ts）
 * - 所有 ID 使用 createAwknId / awknIdSchema
 * - 所有时间戳使用 UtcTimestampSchema
 * - canonical JSON 不允许 undefined 字段，哈希前需 stripUndefined
 * - fail-closed：未知偏差归为 EXECUTION_ERROR
 * - 无新增证据不能生成正 Delta（除非根因确认或排除错误策略）
 */

import { z } from 'zod';
import { stableHash } from './canonical-json.js';
import { awknIdSchema, createAwknId } from './ids.js';
import { JsonValueSchema, type JsonValue } from './json-value.js';
import { SafeNonNegativeIntegerSchema, SafePositiveIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ===== Section 1: Evidence Source Type =====

/**
 * 证据来源类型（设计文档第四节）
 *
 * command        - 命令执行输出
 * tool           - 工具调用结果
 * artifact       - 制品（文件、构建产物等）
 * external_state - 外部系统状态
 * human_confirmation - 人工确认
 */
export const EvidenceSourceTypeSchema = z.enum([
  'command',
  'tool',
  'artifact',
  'external_state',
  'human_confirmation',
]);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

// ===== Section 2: Expected Evidence =====

/**
 * 预期证据 Schema（设计文档第四节）
 *
 * 每个重要动作需声明：
 * - 执行后预期看到什么（description）
 * - 哪个工具或评估器证明它（evaluatorId）
 * - 什么结果支持/推翻当前假设（successPredicate）
 * - 没有结果时如何处理（required = false 时可缺省）
 */
export const ExpectedEvidenceSchema = z.object({
  expectedEvidenceId: z.string().min(1),
  description: z.string().min(1),
  sourceType: EvidenceSourceTypeSchema,
  evaluatorId: z.string().min(1),
  successPredicate: JsonValueSchema,
  freshnessRequired: z.string().min(1).optional(),
  required: z.boolean(),
}).strict();
export type ExpectedEvidence = z.infer<typeof ExpectedEvidenceSchema>;

// ===== Section 3: Planned Action =====

/**
 * 计划动作 Schema
 *
 * 每个动作需绑定 actionFingerprint（用于检测重复），
 * 并可选地关联到一条预期证据。
 */
export const PlannedActionSchema = z.object({
  actionId: z.string().min(1),
  description: z.string().min(1),
  toolId: z.string().min(1).optional(),
  actionFingerprint: z.string().min(1),
  expectedEvidenceId: z.string().min(1).optional(),
}).strict();
export type PlannedAction = z.infer<typeof PlannedActionSchema>;

// ===== Section 4: Cycle Budget =====

/**
 * Cycle 预算切片 Schema
 *
 * 从 GoalBudget 中切出的本 Cycle 可用预算。
 */
export const CycleBudgetSchema = z.object({
  schema: z.literal('awkn-cycle-budget/v1'),
  maxCycles: SafePositiveIntegerSchema,
  maxTokens: SafePositiveIntegerSchema,
  maxDurationMs: SafePositiveIntegerSchema,
  reservedTokens: SafeNonNegativeIntegerSchema,
}).strict();
export type CycleBudget = z.infer<typeof CycleBudgetSchema>;

// ===== Section 5: Evidence Cycle Plan =====

/**
 * Evidence Cycle Plan Schema (awkn-evidence-cycle-plan/v1)
 *
 * 设计文档第三节。
 *
 * 不变量：
 * - expectedEvidence 至少包含一条 required 项（每轮必须有目标）
 * - plannedActions 中引用的 expectedEvidenceId 必须存在于 expectedEvidence
 * - plannedActions 中不能有重复的 actionFingerprint（同一 plan 内）
 * - 三个 bundle hash 必须是 SHA256 hex
 */
export const EvidenceCyclePlanSchema = z.object({
  schema: z.literal('awkn-evidence-cycle-plan/v1'),
  cycleId: awknIdSchema('cyc'),
  runId: awknIdSchema('run'),
  cycleNumber: SafePositiveIntegerSchema,
  objective: z.string().min(1),
  hypothesis: z.string().min(1),
  expectedEvidence: z.array(ExpectedEvidenceSchema).min(1),
  plannedActions: z.array(PlannedActionSchema),
  selectedStrategy: z.string().min(1),
  policyBundleHash: z.string().regex(SHA256_HEX_PATTERN),
  skillBundleHash: z.string().regex(SHA256_HEX_PATTERN),
  contextManifestHash: z.string().regex(SHA256_HEX_PATTERN),
  budgetSlice: CycleBudgetSchema,
}).strict().superRefine((value, context) => {
  if (!value.expectedEvidence.some((entry) => entry.required)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectedEvidence'],
      message: 'at least one required expected evidence is required',
    });
  }
  const expectedIds = new Set(value.expectedEvidence.map((entry) => entry.expectedEvidenceId));
  for (const [index, action] of value.plannedActions.entries()) {
    if (action.expectedEvidenceId !== undefined && !expectedIds.has(action.expectedEvidenceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plannedActions', index, 'expectedEvidenceId'],
        message: `plannedAction references unknown expectedEvidenceId: ${action.expectedEvidenceId}`,
      });
    }
  }
  const fingerprints = value.plannedActions.map((action) => action.actionFingerprint);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const fingerprint of fingerprints) {
    if (seen.has(fingerprint)) duplicates.add(fingerprint);
    seen.add(fingerprint);
  }
  if (duplicates.size > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['plannedActions'],
      message: `duplicate actionFingerprint in cycle plan: ${[...duplicates].sort().join(', ')}`,
    });
  }
});
export type EvidenceCyclePlan = z.infer<typeof EvidenceCyclePlanSchema>;

export const EVIDENCE_CYCLE_PLAN_SCHEMA_ID = 'awkn-evidence-cycle-plan/v1';

// ===== Section 6: Evidence Delta =====

/**
 * Evidence Delta Schema (awkn-evidence-delta/v1)
 *
 * 设计文档第五节。
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
 * 不变量：
 * - uncertainty/acceptanceProgress 均为 [0, 1]
 * - deltaScore 范围 [-1, 1]
 * - 无新增证据且无根因确认/策略排除时 deltaScore 必须 <= 0（fail-closed）
 */
export const EvidenceDeltaSchema = z.object({
  schema: z.literal('awkn-evidence-delta/v1'),
  cycleId: awknIdSchema('cyc'),
  addedEvidenceIds: z.array(awknIdSchema('ev')),
  removedOrInvalidatedEvidenceIds: z.array(awknIdSchema('ev')),
  confirmedClaimIds: z.array(awknIdSchema('clm')),
  disputedClaimIds: z.array(awknIdSchema('clm')),
  uncertaintyBefore: z.number().min(0).max(1),
  uncertaintyAfter: z.number().min(0).max(1),
  acceptanceProgressBefore: z.number().min(0).max(1),
  acceptanceProgressAfter: z.number().min(0).max(1),
  deltaScore: z.number().min(-1).max(1),
  gainType: z.enum([
    'progress',
    'root_cause',
    'constraint_discovery',
    'strategy_elimination',
    'none',
    'regression',
  ]),
}).strict().superRefine((value, context) => {
  // 无新增证据且无根因确认/策略排除时不能生成正 Delta
  const noNewEvidence = value.addedEvidenceIds.length === 0;
  const isRootCauseOrStrategyElimination = value.gainType === 'root_cause'
    || value.gainType === 'constraint_discovery'
    || value.gainType === 'strategy_elimination';
  if (noNewEvidence && !isRootCauseOrStrategyElimination && value.deltaScore > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deltaScore'],
      message: 'deltaScore must be <= 0 when no new evidence and gainType is none/progress/regression',
    });
  }
  // regression gainType 必须 deltaScore <= 0
  if (value.gainType === 'regression' && value.deltaScore > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deltaScore'],
      message: 'regression gainType must have deltaScore <= 0',
    });
  }
});
export type EvidenceDelta = z.infer<typeof EvidenceDeltaSchema>;

export const EVIDENCE_DELTA_SCHEMA_ID = 'awkn-evidence-delta/v1';

// ===== Section 7: Strategy Attempt =====

/**
 * 策略尝试 Schema（设计文档第七节）
 *
 * Strategy Switcher 维护的历史记录条目。
 */
export const StrategyAttemptSchema = z.object({
  strategyId: z.string().min(1),
  hypothesis: z.string().min(1),
  actionFingerprint: z.string().min(1),
  resultFingerprint: z.string().min(1),
  evidenceDeltaScore: z.number().min(-1).max(1),
  failureType: z.string().min(1).optional(),
  usedAt: UtcTimestampSchema,
}).strict();
export type StrategyAttempt = z.infer<typeof StrategyAttemptSchema>;

// ===== Section 8: Deviation Type =====

/**
 * 偏差分类 Schema（设计文档第六节）
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
 *
 * fail-closed：未知情况归为 EXECUTION_ERROR。
 */
export const DeviationTypeSchema = z.enum([
  'EXECUTION_ERROR',
  'HYPOTHESIS_REJECTED',
  'CONTEXT_GAP',
  'AUTHORIZATION_GAP',
  'CAPABILITY_GAP',
  'ACCEPTANCE_MISMATCH',
  'REPEATED_PATTERN',
  'NO_EVIDENCE',
  'REGRESSION',
]);
export type DeviationType = z.infer<typeof DeviationTypeSchema>;

// ===== Section 9: Strategy Decision =====

/**
 * 策略决策 Schema
 *
 * CONTINUE - 继续当前策略
 * SWITCH   - 切换策略
 * PAUSE    - 暂停（等待用户/外部）
 * STOP     - 终止 Run
 */
export const StrategyDecisionSchema = z.enum([
  'CONTINUE',
  'SWITCH',
  'PAUSE',
  'STOP',
]);
export type StrategyDecision = z.infer<typeof StrategyDecisionSchema>;

// ===== Section 10: Cycle Receipt =====

/**
 * Cycle Receipt Schema (awkn-cycle-receipt/v1)
 *
 * 设计文档第九节。每轮 L2 执行结束都必须生成 Receipt。
 */
export const CycleReceiptSchema = z.object({
  schema: z.literal('awkn-cycle-receipt/v1'),
  receiptId: awknIdSchema('rcpt'),
  runId: awknIdSchema('run'),
  cycleId: awknIdSchema('cyc'),
  cycle: SafePositiveIntegerSchema,
  hypothesis: z.string().min(1),
  expectedEvidenceIds: z.array(z.string().min(1)),
  actualEvidenceIds: z.array(awknIdSchema('ev')),
  deltaScore: z.number().min(-1).max(1),
  deviationType: DeviationTypeSchema,
  strategyDecision: StrategyDecisionSchema,
  nextStrategy: z.string().min(1).optional(),
  tokens: SafeNonNegativeIntegerSchema,
  durationMs: SafeNonNegativeIntegerSchema,
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  // STOP / SWITCH 时 nextStrategy 可选；PAUSE 时可选（等待用户输入）；CONTINUE 时不应出现
  if (value.strategyDecision === 'CONTINUE' && value.nextStrategy !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextStrategy'],
      message: 'CONTINUE decision must not carry nextStrategy',
    });
  }
  // STOP 时 deltaScore <= 0 表示失败收尾；deltaScore > 0 通常不该 STOP（除非预算耗尽）
  // 此处不强制，留给上层语义判断
});
export type CycleReceipt = z.infer<typeof CycleReceiptSchema>;

export const CYCLE_RECEIPT_SCHEMA_ID = 'awkn-cycle-receipt/v1';

// ===== Section 11: Hash Computation =====

/**
 * 深度剥离 undefined 字段（递归处理对象和数组）.
 *
 * canonical JSON 不允许 undefined 字段，而 EvidenceCyclePlan 中有 optional 字段
 * （如 freshnessRequired / toolId / expectedEvidenceId）。
 * 在哈希前剥离它们以保证哈希稳定且不抛错。
 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val !== undefined) {
      result[key] = stripUndefined(val);
    }
  }
  return result;
}

/**
 * 计算 EvidenceCyclePlan 的稳定哈希（跨平台一致）.
 *
 * 排除运行时字段 cycleId / runId —— 同一计划内容（包含 cycleNumber、
 * objective、hypothesis、expectedEvidence 等）应产生相同哈希。
 * cycleId / runId 由系统在创建时分配，不影响计划内容身份。
 *
 * 在哈希前剥离 undefined optional 字段以符合 canonical JSON 规范。
 *
 * 注意：类型签名是 Omit<EvidenceCyclePlan, 'cycleId' | 'runId'>，
 * 但调用方常传入完整 EvidenceCyclePlan（结构子类型兼容）。
 * 为确保运行时也排除这两个字段，此处显式解构剥离。
 */
export function computeCyclePlanHash(
  plan: Omit<EvidenceCyclePlan, 'cycleId' | 'runId'>,
): string {
  // 显式剥离 cycleId / runId（即使调用方传入了完整 plan）
  const { cycleId: _cycleId, runId: _runId, ...contentFields } = plan as EvidenceCyclePlan;
  void _cycleId;
  void _runId;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(EVIDENCE_CYCLE_PLAN_SCHEMA_ID, stripped);
}

// ===== Section 12: ID 生成辅助 =====

/** 生成 Cycle ID */
export function createCycleId(): string {
  return createAwknId('cycle');
}

/** 生成 EvidenceDelta ID（仅当需要独立标识 Delta 时使用） */
export function createEvidenceDeltaId(): string {
  return createAwknId('evidenceDelta');
}

/** 生成 StrategyAttempt ID */
export function createStrategyAttemptId(): string {
  return createAwknId('strategyAttempt');
}
