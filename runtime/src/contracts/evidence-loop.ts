/**
 * Evidence-Gain Loop Contracts (Phase 6 / C06 / WP-AOS-12)
 *
 * 设计文档: docs/agent-os-3.0/07-Evidence-Gain-Loop.md
 *
 * 本文件冻结 Evidence-Gain Loop 的所有公开 Contract：
 * - DeviationTypeSchema: 9 种偏差类型
 * - StrategyDecisionSchema: 策略决策
 * - HypothesisSchema: 假设
 * - ExpectedEvidenceSchema (awkn-expected-evidence/v1): 预期证据
 * - PlannedActionSchema: 计划动作
 * - CycleBudgetSchema: 周期预算
 * - EvidenceCyclePlanSchema (awkn-evidence-cycle-plan/v1): 证据周期计划
 * - StrategyAttemptSchema: 策略尝试记录
 * - CycleReceiptSchema (awkn-cycle-receipt/v1): 周期回执
 * - NoGainStopConditionSchema: 无增量停止条件
 *
 * 注意：EvidenceDelta 已定义在 evidence.ts，此处不重复定义。
 *
 * 不变量：
 * - 所有 schema 使用 zod strict + superRefine
 * - 所有 hash 使用 stableHash（canonical-json.ts）
 * - 所有 ID 使用 createAwknId / awknIdSchema
 * - 所有时间戳使用 UtcTimestampSchema
 * - 每轮执行必须有 Expected Evidence（设计文档测试 1）
 * - 无新增证据不能生成正 Delta（设计文档测试 2）
 * - 同一动作/错误重复触发 Strategy Switch（设计文档测试 4、5）
 * - 连续 3 轮 deltaScore <= 0 触发 No-Gain Stop（设计文档 8.4）
 */

import { z } from 'zod';
import { stableHash } from './canonical-json.js';
import { awknIdSchema, createAwknId } from './ids.js';
import type { JsonValue } from './json-value.js';
import { JsonValueSchema } from './json-value.js';
import { SafeNonNegativeIntegerSchema, SafePositiveIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ===== Section 1: Enums =====

/**
 * 偏差分类（设计文档第六节）
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

/**
 * 策略决策（设计文档第七节）
 */
export const StrategyDecisionSchema = z.enum([
  'CONTINUE',
  'SWITCH',
  'PAUSE',
  'STOP',
  'WAITING_USER',
  'WAITING_AUTHORIZATION',
]);
export type StrategyDecision = z.infer<typeof StrategyDecisionSchema>;

export const ExpectedEvidenceSourceTypeSchema = z.enum([
  'command',
  'tool',
  'artifact',
  'external_state',
  'human_confirmation',
]);
export type ExpectedEvidenceSourceType = z.infer<typeof ExpectedEvidenceSourceTypeSchema>;

// ===== Section 2: Hypothesis =====

export const HypothesisSchema = z.object({
  schema: z.literal('awkn-hypothesis/v1'),
  hypothesisId: z.string().min(1),
  statement: z.string().min(1),
  rationale: z.string().min(1),
  assumptions: z.array(z.string().min(1)),
  falsifiable: z.boolean(),
  confidence: z.number().min(0).max(1),
}).strict();
export type Hypothesis = z.infer<typeof HypothesisSchema>;

// ===== Section 3: Expected Evidence (awkn-expected-evidence/v1) =====

export const ExpectedEvidenceSchema = z.object({
  schema: z.literal('awkn-expected-evidence/v1'),
  expectedEvidenceId: z.string().min(1),
  description: z.string().min(1),
  sourceType: ExpectedEvidenceSourceTypeSchema,
  evaluatorId: z.string().min(1),
  successPredicate: z.record(JsonValueSchema),
  freshnessRequired: z.string().min(1).optional(),
  required: z.boolean(),
}).strict().superRefine((value, context) => {
  // required 证据必须有 successPredicate
  if (value.required && Object.keys(value.successPredicate).length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['successPredicate'],
      message: 'required expected evidence must have non-empty successPredicate',
    });
  }
});
export type ExpectedEvidence = z.infer<typeof ExpectedEvidenceSchema>;

export const EXPECTED_EVIDENCE_SCHEMA_ID = 'awkn-expected-evidence/v1';

// ===== Section 4: Planned Action =====

export const PlannedActionSchema = z.object({
  actionId: z.string().min(1),
  toolId: z.string().min(1).optional(),
  description: z.string().min(1),
  producesEvidenceIds: z.array(z.string().min(1)),
  fingerprint: z.string().min(1),
  estimatedCostUsd: z.number().nonnegative().optional(),
  estimatedTokens: SafeNonNegativeIntegerSchema.optional(),
}).strict();
export type PlannedAction = z.infer<typeof PlannedActionSchema>;

// ===== Section 5: Cycle Budget =====

export const CycleBudgetSchema = z.object({
  maxTokens: SafePositiveIntegerSchema,
  maxDurationMs: SafePositiveIntegerSchema,
  maxCostUsd: z.number().positive(),
  consumedTokens: SafeNonNegativeIntegerSchema,
  consumedDurationMs: SafeNonNegativeIntegerSchema,
  consumedCostUsd: z.number().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.consumedTokens > value.maxTokens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['consumedTokens'],
      message: 'consumedTokens cannot exceed maxTokens',
    });
  }
  if (value.consumedDurationMs > value.maxDurationMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['consumedDurationMs'],
      message: 'consumedDurationMs cannot exceed maxDurationMs',
    });
  }
  if (value.consumedCostUsd > value.maxCostUsd) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['consumedCostUsd'],
      message: 'consumedCostUsd cannot exceed maxCostUsd',
    });
  }
});
export type CycleBudget = z.infer<typeof CycleBudgetSchema>;

// ===== Section 6: Evidence Cycle Plan (awkn-evidence-cycle-plan/v1) =====

export const EvidenceCyclePlanSchema = z.object({
  schema: z.literal('awkn-evidence-cycle-plan/v1'),
  cycleId: z.string().min(1),
  runId: awknIdSchema('run'),
  cycleNumber: SafePositiveIntegerSchema,
  objective: z.string().min(1),
  hypothesis: HypothesisSchema,
  expectedEvidence: z.array(ExpectedEvidenceSchema).min(1),
  plannedActions: z.array(PlannedActionSchema).min(1),
  selectedStrategy: z.string().min(1),
  policyBundleHash: z.string().regex(SHA256_HEX_PATTERN),
  skillBundleHash: z.string().regex(SHA256_HEX_PATTERN),
  contextManifestHash: z.string().regex(SHA256_HEX_PATTERN),
  budgetSlice: CycleBudgetSchema,
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  // 每轮必须有 Expected Evidence（测试 1）
  if (value.expectedEvidence.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectedEvidence'],
      message: 'cycle plan must declare at least one expected evidence',
    });
  }
  // 必须有至少一个 required 证据
  const hasRequired = value.expectedEvidence.some((e) => e.required);
  if (!hasRequired) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectedEvidence'],
      message: 'cycle plan must declare at least one required expected evidence',
    });
  }
  // 每个 plannedAction producesEvidenceIds 必须在 expectedEvidence 中存在
  const expectedIds = new Set(value.expectedEvidence.map((e) => e.expectedEvidenceId));
  for (const [index, action] of value.plannedActions.entries()) {
    for (const eid of action.producesEvidenceIds) {
      if (!expectedIds.has(eid)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['plannedActions', index, 'producesEvidenceIds'],
          message: `action produces unknown evidence id: ${eid}`,
        });
      }
    }
  }
});
export type EvidenceCyclePlan = z.infer<typeof EvidenceCyclePlanSchema>;

export const EVIDENCE_CYCLE_PLAN_SCHEMA_ID = 'awkn-evidence-cycle-plan/v1';

// ===== Section 7: Strategy Attempt (设计文档第七节) =====

export const StrategyAttemptSchema = z.object({
  schema: z.literal('awkn-strategy-attempt/v1'),
  strategyId: z.string().min(1),
  hypothesis: z.string().min(1),
  actionFingerprint: z.string().min(1),
  resultFingerprint: z.string().min(1),
  evidenceDeltaScore: z.number().min(-1).max(1),
  failureType: DeviationTypeSchema.optional(),
  usedAt: UtcTimestampSchema,
}).strict();
export type StrategyAttempt = z.infer<typeof StrategyAttemptSchema>;

// ===== Section 8: Cycle Receipt (awkn-cycle-receipt/v1) =====

export const CycleReceiptSchema = z.object({
  schema: z.literal('awkn-cycle-receipt/v1'),
  receiptId: awknIdSchema('rcpt'),
  runId: awknIdSchema('run'),
  cycle: SafePositiveIntegerSchema,
  hypothesis: z.string().min(1),
  expectedEvidenceIds: z.array(z.string().min(1)),
  actualEvidenceIds: z.array(awknIdSchema('ev')),
  deltaScore: z.number().min(-1).max(1),
  gainType: z.enum([
    'progress',
    'root_cause',
    'constraint_discovery',
    'strategy_elimination',
    'none',
    'regression',
  ]),
  deviationType: DeviationTypeSchema.optional(),
  strategyDecision: StrategyDecisionSchema,
  nextStrategy: z.string().min(1).optional(),
  tokens: SafeNonNegativeIntegerSchema,
  durationMs: SafeNonNegativeIntegerSchema,
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  // 无新增证据不能生成正 Delta（测试 2）
  if (value.actualEvidenceIds.length === 0 && value.deltaScore > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deltaScore'],
      message: 'positive deltaScore requires at least one actual evidence',
    });
  }
  // regression gainType 必须有负 deltaScore
  if (value.gainType === 'regression' && value.deltaScore >= 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deltaScore'],
      message: 'regression gainType requires non-positive deltaScore',
    });
  }
  // SWITCH 决策必须提供 nextStrategy
  if (value.strategyDecision === 'SWITCH' && value.nextStrategy === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextStrategy'],
      message: 'SWITCH decision requires nextStrategy',
    });
  }
  // none gainType 必须有 deviationType
  if (value.gainType === 'none' && value.deviationType === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deviationType'],
      message: 'none gainType requires deviationType',
    });
  }
});
export type CycleReceipt = z.infer<typeof CycleReceiptSchema>;

export const CYCLE_RECEIPT_SCHEMA_ID = 'awkn-cycle-receipt/v1';

// ===== Section 9: No-Gain Stop Condition (设计文档 8.4) =====

export const NoGainStopConditionSchema = z.object({
  schema: z.literal('awkn-no-gain-stop-condition/v1'),
  conditionId: z.string().min(1),
  consecutiveLowDeltaCycles: SafeNonNegativeIntegerSchema,
  consecutiveSameActionCycles: SafeNonNegativeIntegerSchema,
  consecutiveSameErrorCycles: SafeNonNegativeIntegerSchema,
  triggered: z.boolean(),
  reason: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  // 触发时必须有 reason
  if (value.triggered && value.reason === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reason'],
      message: 'triggered no-gain stop requires reason',
    });
  }
  // 触发条件：连续 3 轮 deltaScore <= 0 或 actionFingerprint 相同 或 errorFingerprint 相同
  const triggers = (
    value.consecutiveLowDeltaCycles >= 3
    || value.consecutiveSameActionCycles >= 3
    || value.consecutiveSameErrorCycles >= 3
  );
  if (value.triggered !== triggers) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['triggered'],
      message: `triggered=${value.triggered} does not match threshold condition=${triggers}`,
    });
  }
});
export type NoGainStopCondition = z.infer<typeof NoGainStopConditionSchema>;

export const NO_GAIN_STOP_CONDITION_SCHEMA_ID = 'awkn-no-gain-stop-condition/v1';

// ===== Section 10: Hash Computation =====

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

export function computeEvidenceCyclePlanHash(
  plan: Omit<EvidenceCyclePlan, 'cycleId' | 'createdAt'>,
): string {
  const { cycleId: _cycleId, createdAt: _createdAt, ...contentFields } = plan as EvidenceCyclePlan;
  void _cycleId;
  void _createdAt;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(EVIDENCE_CYCLE_PLAN_SCHEMA_ID, stripped);
}

export function computeCycleReceiptHash(
  receipt: Omit<CycleReceipt, 'receiptId' | 'createdAt'>,
): string {
  const { receiptId: _receiptId, createdAt: _createdAt, ...contentFields } = receipt as CycleReceipt;
  void _receiptId;
  void _createdAt;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(CYCLE_RECEIPT_SCHEMA_ID, stripped);
}

// ===== Section 11: ID 生成辅助 =====

export function createCycleReceiptId(): string {
  return createAwknId('receipt');
}

// ===== Section 12: 策略切换评估辅助 =====

/**
 * 评估是否应触发策略切换（设计文档第七节）
 */
export interface StrategySwitchAssessment {
  shouldSwitch: boolean;
  reasons: string[];
}

export function assessStrategySwitch(
  attempts: ReadonlyArray<StrategyAttempt>,
  currentDeltaScore: number,
): StrategySwitchAssessment {
  const reasons: string[] = [];

  if (attempts.length === 0) {
    return { shouldSwitch: false, reasons };
  }

  const recent = attempts.slice(-3);

  // 同一 Action Fingerprint 重复
  const recentFingerprints = recent.map((a) => a.actionFingerprint);
  if (recentFingerprints.length >= 2) {
    const last = recentFingerprints[recentFingerprints.length - 1];
    const prev = recentFingerprints[recentFingerprints.length - 2];
    if (last === prev) {
      // PR1 P2-1: 保留 [ACTION] 来源标记，测试可断言因 ACTION 重复触发 SWITCH，
      // 禁止用其他低增益条件（如 consecutive low delta）顺带通过
      reasons.push('repeated action fingerprint [ACTION]');
    }
  }

  // 同一错误指纹达到阈值（连续 2 次）
  const failureTypes = recent
    .map((a) => a.failureType)
    .filter((t): t is DeviationType => t !== undefined);
  if (failureTypes.length >= 2) {
    const last = failureTypes[failureTypes.length - 1];
    const prev = failureTypes[failureTypes.length - 2];
    if (last === prev) {
      // PR1 P2-1: 保留 [ERROR] 来源标记，测试可断言因 ERROR 重复触发 SWITCH
      reasons.push(`repeated failure type: ${last} [ERROR]`);
    }
  }

  // 连续两轮 Delta 过低
  const lowDeltaCount = recent.filter((a) => a.evidenceDeltaScore <= 0).length;
  if (lowDeltaCount >= 2) {
    reasons.push('consecutive low delta cycles');
  }

  // 当前假设被推翻（deltaScore 为负且为 REGRESSION 或 HYPOTHESIS_REJECTED）
  const lastAttempt = recent[recent.length - 1];
  if (lastAttempt !== undefined
    && lastAttempt.evidenceDeltaScore < 0
    && (lastAttempt.failureType === 'HYPOTHESIS_REJECTED'
      || lastAttempt.failureType === 'REGRESSION')) {
    reasons.push('current hypothesis rejected');
  }

  // 当前 deltaScore 过低
  if (currentDeltaScore <= 0) {
    reasons.push('current delta score non-positive');
  }

  return {
    shouldSwitch: reasons.length > 0,
    reasons,
  };
}

/**
 * 计算 No-Gain Stop 触发条件（设计文档 8.4）
 */
export function evaluateNoGainStop(
  cycleReceipts: ReadonlyArray<CycleReceipt>,
  strategyAttempts: ReadonlyArray<StrategyAttempt>,
): NoGainStopCondition {
  let consecutiveLowDelta = 0;
  let consecutiveSameAction = 0;
  let consecutiveSameError = 0;

  // 连续 deltaScore <= 0
  for (let i = cycleReceipts.length - 1; i >= 0; i -= 1) {
    if (cycleReceipts[i].deltaScore <= 0) {
      consecutiveLowDelta += 1;
    } else {
      break;
    }
  }

  // 连续相同 actionFingerprint
  for (let i = strategyAttempts.length - 1; i > 0; i -= 1) {
    if (strategyAttempts[i].actionFingerprint === strategyAttempts[i - 1].actionFingerprint) {
      consecutiveSameAction += 1;
    } else {
      break;
    }
  }
  if (consecutiveSameAction > 0) consecutiveSameAction += 1;

  // 连续相同 errorFingerprint
  const failures = strategyAttempts.filter((a) => a.failureType !== undefined);
  for (let i = failures.length - 1; i > 0; i -= 1) {
    if (failures[i].failureType === failures[i - 1].failureType) {
      consecutiveSameError += 1;
    } else {
      break;
    }
  }
  if (consecutiveSameError > 0) consecutiveSameError += 1;

  const triggered = (
    consecutiveLowDelta >= 3
    || consecutiveSameAction >= 3
    || consecutiveSameError >= 3
  );

  return NoGainStopConditionSchema.parse({
    schema: 'awkn-no-gain-stop-condition/v1',
    conditionId: `ngsc_${Date.now().toString(36)}`,
    consecutiveLowDeltaCycles: consecutiveLowDelta,
    consecutiveSameActionCycles: consecutiveSameAction,
    consecutiveSameErrorCycles: consecutiveSameError,
    triggered,
    reason: triggered ? 'no-gain threshold reached' : undefined,
  });
}
