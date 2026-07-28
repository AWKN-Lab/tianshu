/**
 * Outcome Record Contracts (Phase 6 / C08 / WP-AOS-13)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第三、四节
 *
 * 本文件冻结 Outcome 模型的所有公开 Contract：
 * - OutcomeStateSchema: 6 种状态（SUCCEEDED/FAILED/PARTIAL/CANCELLED/PENDING/UNKNOWN）
 * - WeightedRefSchema: 带权重的引用
 * - OutcomeAttributionSchema: 归因
 * - OutcomeRecordSchema (awkn-outcome-record/v1): 结果记录
 *
 * 不变量：
 * - 所有 schema 使用 zod strict + superRefine
 * - 所有 ID 使用 createAwknId / awknIdSchema
 * - 所有时间戳使用 UtcTimestampSchema
 * - 执行完成 ≠ 交付完成 ≠ 用户采用 ≠ 业务结果 ≠ 学习结果（设计文档 3.1）
 * - 状态不能合并：测试通过 ≠ 用户采用；文件创建 ≠ 用户下载；
 *   邮件工具成功 ≠ 收件人收到；模型建议 ≠ 业务目标达成；
 *   用户采用 ≠ 建议有效；执行失败仍可能产生学习（设计文档 3.1）
 * - attribution confidence 必须在 [0, 1]
 * - P0 采用规则型归因（rule_based）
 */

import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { stableHash } from './canonical-json.js';
import { awknIdSchema, createAwknId } from './ids.js';
import type { JsonValue } from './json-value.js';
import { UtcTimestampSchema } from './time.js';

// ===== Section 1: Enums =====

export const OutcomeStateSchema = z.enum([
  'SUCCEEDED',
  'FAILED',
  'PARTIAL',
  'CANCELLED',
  'PENDING',
  'UNKNOWN',
]);
export type OutcomeState = z.infer<typeof OutcomeStateSchema>;

export const OutcomeAttributionMethodSchema = z.enum([
  'rule_based',
  'counterfactual',
  'human_review',
  'mixed',
]);
export type OutcomeAttributionMethod = z.infer<typeof OutcomeAttributionMethodSchema>;

// ===== Section 2: Weighted Reference =====

export const WeightedRefSchema = z.object({
  ref: z.string().min(1),
  weight: z.number().min(0).max(1),
  role: z.string().min(1).optional(),
}).strict();
export type WeightedRef = z.infer<typeof WeightedRefSchema>;

// ===== Section 3: Outcome Attribution =====

export const OutcomeAttributionSchema = z.object({
  contributingClaims: z.array(WeightedRefSchema),
  contributingPolicies: z.array(WeightedRefSchema),
  contributingSkills: z.array(WeightedRefSchema),
  contributingModels: z.array(WeightedRefSchema),
  contributingTools: z.array(WeightedRefSchema),
  confidence: z.number().min(0).max(1),
  method: OutcomeAttributionMethodSchema,
}).strict().superRefine((value, context) => {
  // 至少有一个贡献项
  const totalContributions =
    value.contributingClaims.length
    + value.contributingPolicies.length
    + value.contributingSkills.length
    + value.contributingModels.length
    + value.contributingTools.length;
  if (totalContributions === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'attribution requires at least one contributing factor',
    });
  }
  // 权重总和归一化检查（容差 0.01）
  const allRefs = [
    ...value.contributingClaims,
    ...value.contributingPolicies,
    ...value.contributingSkills,
    ...value.contributingModels,
    ...value.contributingTools,
  ];
  if (allRefs.length > 0) {
    const sum = allRefs.reduce((acc, ref) => acc + ref.weight, 0);
    if (Math.abs(sum - 1) > 0.01) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `attribution weights must sum to 1.0 (got ${sum.toFixed(4)})`,
      });
    }
  }
});
export type OutcomeAttribution = z.infer<typeof OutcomeAttributionSchema>;

// ===== Section 4: Outcome Record (awkn-outcome-record/v1) =====

export const OutcomeRecordSchema = z.object({
  schema: z.literal('awkn-outcome-record/v1'),
  outcomeId: awknIdSchema('out'),
  executionId: awknIdSchema('exec'),
  runId: awknIdSchema('run').optional(),
  executionOutcome: OutcomeStateSchema,
  deliveryOutcome: OutcomeStateSchema,
  adoptionOutcome: z.union([OutcomeStateSchema, z.literal('UNKNOWN')]),
  businessOutcome: z.union([OutcomeStateSchema, z.literal('UNKNOWN')]),
  learningOutcome: z.union([OutcomeStateSchema, z.literal('UNKNOWN')]),
  evidenceIds: z.array(awknIdSchema('ev')),
  observedAt: UtcTimestampSchema,
  observer: ActorRefSchema,
  confidence: z.number().min(0).max(1),
  attribution: OutcomeAttributionSchema.optional(),
}).strict().superRefine((value, context) => {
  // 执行失败仍可能产生学习（设计文档 3.1：执行失败仍可能产生有价值学习）
  // 所以不强制 executionOutcome=SUCCEEDED 才能 learningOutcome=SUCCEEDED
  // 但执行成功时 learningOutcome 不能是 FAILED
  if (value.executionOutcome === 'SUCCEEDED' && value.learningOutcome === 'FAILED') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['learningOutcome'],
      message: 'successful execution cannot have FAILED learning outcome',
    });
  }
  // 交付成功但执行失败是矛盾的
  if (value.executionOutcome === 'FAILED' && value.deliveryOutcome === 'SUCCEEDED') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryOutcome'],
      message: 'delivery cannot succeed when execution failed',
    });
  }
  // 用户采用必须先有交付完成
  if (value.adoptionOutcome === 'SUCCEEDED' && value.deliveryOutcome !== 'SUCCEEDED') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['adoptionOutcome'],
      message: 'adoption cannot succeed when delivery is not SUCCEEDED',
    });
  }
  // 业务结果必须先有用户采用
  if (value.businessOutcome === 'SUCCEEDED' && value.adoptionOutcome !== 'SUCCEEDED') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['businessOutcome'],
      message: 'business outcome cannot succeed without adoption',
    });
  }
  // 取消状态下不能有业务结果
  if (value.executionOutcome === 'CANCELLED' && value.businessOutcome !== 'UNKNOWN'
    && value.businessOutcome !== 'CANCELLED') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['businessOutcome'],
      message: 'cancelled execution cannot have non-UNKNOWN/CANCELLED business outcome',
    });
  }
});
export type OutcomeRecord = z.infer<typeof OutcomeRecordSchema>;

export const OUTCOME_RECORD_SCHEMA_ID = 'awkn-outcome-record/v1';

// ===== Section 5: Hash Computation =====

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

export function computeOutcomeRecordHash(
  record: Omit<OutcomeRecord, 'outcomeId'>,
): string {
  const stripped = stripUndefined(record as unknown as JsonValue);
  return stableHash(OUTCOME_RECORD_SCHEMA_ID, stripped);
}

// ===== Section 6: ID 生成辅助 =====

export function createOutcomeId(): string {
  return createAwknId('outcome');
}

// ===== Section 7: 五层结果查询辅助 =====

/**
 * 提取五层结果状态以供查询（设计文档验收：五层状态可查询）
 */
export interface OutcomeStateSnapshot {
  execution: OutcomeState | 'UNKNOWN';
  delivery: OutcomeState | 'UNKNOWN';
  adoption: OutcomeState | 'UNKNOWN';
  business: OutcomeState | 'UNKNOWN';
  learning: OutcomeState | 'UNKNOWN';
}

export function snapshotOutcomeStates(record: OutcomeRecord): OutcomeStateSnapshot {
  return {
    execution: record.executionOutcome,
    delivery: record.deliveryOutcome,
    adoption: record.adoptionOutcome,
    business: record.businessOutcome,
    learning: record.learningOutcome,
  };
}

/**
 * 判断学习结果是否独立有效（设计文档测试 10：Delivery 失败可以形成 Learning Outcome）
 */
export function hasIndependentLearning(record: OutcomeRecord): boolean {
  return record.learningOutcome === 'SUCCEEDED';
}

/**
 * 判断是否需要继续观察（任意层仍为 PENDING 或 UNKNOWN）
 */
export function needsFurtherObservation(record: OutcomeRecord): boolean {
  return (
    record.executionOutcome === 'PENDING'
    || record.deliveryOutcome === 'PENDING'
    || record.adoptionOutcome === 'PENDING'
    || record.adoptionOutcome === 'UNKNOWN'
    || record.businessOutcome === 'PENDING'
    || record.businessOutcome === 'UNKNOWN'
    || record.learningOutcome === 'PENDING'
    || record.learningOutcome === 'UNKNOWN'
  );
}

/**
 * 阻断原因计数（用于统计阻断层数）
 */
export function countBlockingReasons(record: OutcomeRecord): number {
  let count = 0;
  if (record.executionOutcome === 'FAILED') count += 1;
  if (record.deliveryOutcome === 'FAILED') count += 1;
  if (record.adoptionOutcome === 'FAILED') count += 1;
  if (record.businessOutcome === 'FAILED') count += 1;
  return count;
}
