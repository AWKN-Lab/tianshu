/**
 * Outcome Record Contracts (Phase 6 / C08 / WP-AOS-13)
 *
 * 设计文档: `docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md` 第三、四节
 *
 * 本文件冻结 Outcome 模型的所有公开 Contract：
 * - OutcomeStateSchema: 五层 Outcome 共用的状态枚举
 * - OutcomeAttributionMethodSchema: 归因方法
 * - WeightedRefSchema: 加权引用
 * - OutcomeAttributionSchema: 归因结果
 * - OutcomeRecordSchema (awkn-outcome-record/v1): Run 终态 Outcome 记录
 *
 * 不变量：
 * - 所有 schema 使用 zod strict + superRefine
 * - 所有 hash 使用 stableHash（canonical-json.ts）
 * - 所有 ID 使用 createAwknId / awknIdSchema
 * - 所有时间戳使用 UtcTimestampSchema
 * - canonical JSON 不允许 undefined 字段，哈希前需 stripUndefined
 * - fail-closed：未知状态归为 UNKNOWN
 * - 五层状态不可合并：
 *   执行完成 ≠ 交付完成 ≠ 用户采用 ≠ 业务结果 ≠ 学习结果
 *   测试通过 ≠ 用户采用；文件创建 ≠ 用户下载；邮件工具返回成功 ≠ 收件人收到
 *   用户采用 ≠ 建议有效；执行失败仍可能产生有价值学习
 */

import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { stableHash } from './canonical-json.js';
import { awknIdSchema, createAwknId } from './ids.js';
import type { JsonValue } from './json-value.js';
import { UtcTimestampSchema } from './time.js';

// ===== Section 1: Enums =====

/**
 * Outcome 状态枚举（设计文档 3.1）
 *
 * 五层 Outcome 共用此状态：
 *   SUCCEEDED - 成功
 *   FAILED    - 失败
 *   PARTIAL   - 部分成功
 *   CANCELLED - 被取消
 *   PENDING   - 待定（执行中或等待外部信号）
 *   UNKNOWN   - 未知（fail-closed，未观察或证据不足）
 *
 * 关键规则：
 * - 未观察到用户采用信号 → adoptionOutcome = UNKNOWN（不可推断为 SUCCEEDED）
 * - 未观察到业务结果 → businessOutcome = UNKNOWN
 * - 执行失败仍可能 learningOutcome = SUCCEEDED（从失败中学习）
 */
export const OutcomeStateSchema = z.enum([
  'SUCCEEDED',
  'FAILED',
  'PARTIAL',
  'CANCELLED',
  'PENDING',
  'UNKNOWN',
]);
export type OutcomeState = z.infer<typeof OutcomeStateSchema>;

/**
 * 归因方法（设计文档第四节）
 *
 * - rule_based: P0 规则型归因（基于权重和贡献关系）
 * - counterfactual: 反事实评测（P1+，对比 baseline）
 * - human_review: 人工审查
 * - mixed: 混合方法
 *
 * P0 默认采用 rule_based。
 */
export const OutcomeAttributionMethodSchema = z.enum([
  'rule_based',
  'counterfactual',
  'human_review',
  'mixed',
]);
export type OutcomeAttributionMethod = z.infer<typeof OutcomeAttributionMethodSchema>;

// ===== Section 2: WeightedRef =====

/**
 * 加权引用 Schema
 *
 * 用于 OutcomeAttribution 中引用贡献者（Claim、Policy、Skill、Model、Tool），
 * 并附上贡献权重 [0, 1]。
 */
export const WeightedRefSchema = z.object({
  /** 引用 ID（如 claim ID、policy ID、skill ID、model ID、tool ID） */
  ref: z.string().min(1),
  /** 引用类型（claim / policy / skill / model / tool） */
  refType: z.enum(['claim', 'policy', 'skill', 'model', 'tool']),
  /** 贡献权重 [0, 1] */
  weight: z.number().min(0).max(1),
  /** 贡献说明（人类可读） */
  reason: z.string().min(1),
}).strict();
export type WeightedRef = z.infer<typeof WeightedRefSchema>;

// ===== Section 3: Outcome Attribution =====

/**
 * Outcome Attribution Schema（设计文档第四节）
 *
 * 描述各贡献者（Claim / Policy / Skill / Model / Tool）对当前 Outcome 的贡献。
 *
 * 不变量：
 * - 所有 weight 在 [0, 1]
 * - confidence 在 [0, 1]
 * - method=rule_based 时权重由规则确定
 * - 各 contributing* 数组中 ref 不能重复
 */
export const OutcomeAttributionSchema = z.object({
  schema: z.literal('awkn-outcome-attribution/v1'),
  contributingClaims: z.array(WeightedRefSchema),
  contributingPolicies: z.array(WeightedRefSchema),
  contributingSkills: z.array(WeightedRefSchema),
  contributingModels: z.array(WeightedRefSchema),
  contributingTools: z.array(WeightedRefSchema),
  /** 归因总置信度 [0, 1] */
  confidence: z.number().min(0).max(1),
  /** 归因方法 */
  method: OutcomeAttributionMethodSchema,
  /** 归因说明（人类可读） */
  explanation: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  // 各 contributing* 数组中 ref 不能重复
  const checkUniqueRefs = (
    refs: readonly WeightedRef[],
    path: (string | number)[],
    label: string,
  ): void => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const item of refs) {
      if (seen.has(item.ref)) duplicates.add(item.ref);
      seen.add(item.ref);
    }
    if (duplicates.size > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `duplicate ${label} ref: ${[...duplicates].sort().join(', ')}`,
      });
    }
  };
  checkUniqueRefs(value.contributingClaims, ['contributingClaims'], 'claim');
  checkUniqueRefs(value.contributingPolicies, ['contributingPolicies'], 'policy');
  checkUniqueRefs(value.contributingSkills, ['contributingSkills'], 'skill');
  checkUniqueRefs(value.contributingModels, ['contributingModels'], 'model');
  checkUniqueRefs(value.contributingTools, ['contributingTools'], 'tool');
  // refType 必须与字段匹配
  for (const [index, ref] of value.contributingClaims.entries()) {
    if (ref.refType !== 'claim') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributingClaims', index, 'refType'],
        message: `contributingClaims must have refType='claim', got '${ref.refType}'`,
      });
    }
  }
  for (const [index, ref] of value.contributingPolicies.entries()) {
    if (ref.refType !== 'policy') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributingPolicies', index, 'refType'],
        message: `contributingPolicies must have refType='policy', got '${ref.refType}'`,
      });
    }
  }
  for (const [index, ref] of value.contributingSkills.entries()) {
    if (ref.refType !== 'skill') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributingSkills', index, 'refType'],
        message: `contributingSkills must have refType='skill', got '${ref.refType}'`,
      });
    }
  }
  for (const [index, ref] of value.contributingModels.entries()) {
    if (ref.refType !== 'model') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributingModels', index, 'refType'],
        message: `contributingModels must have refType='model', got '${ref.refType}'`,
      });
    }
  }
  for (const [index, ref] of value.contributingTools.entries()) {
    if (ref.refType !== 'tool') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributingTools', index, 'refType'],
        message: `contributingTools must have refType='tool', got '${ref.refType}'`,
      });
    }
  }
});
export type OutcomeAttribution = z.infer<typeof OutcomeAttributionSchema>;

export const OUTCOME_ATTRIBUTION_SCHEMA_ID = 'awkn-outcome-attribution/v1';

// ===== Section 4: Outcome Record (awkn-outcome-record/v1) =====

/**
 * Outcome Record Schema (awkn-outcome-record/v1)
 *
 * 设计文档第三节。Run 终态时生成的五层 Outcome 记录。
 *
 * 五层状态（不可合并）：
 * - executionOutcome: 执行层（动作是否完成）
 * - deliveryOutcome: 交付层（产物是否送达正确载体）
 * - adoptionOutcome: 采用层（用户是否实际采用/下载/确认）
 * - businessOutcome: 业务层（业务目标是否达成）
 * - learningOutcome: 学习层（是否产生有价值学习）
 *
 * 不变量：
 * - adoptionOutcome / businessOutcome / learningOutcome 默认 UNKNOWN
 *   未观察到信号时不可推断为 SUCCEEDED
 * - 执行失败仍可 learningOutcome = SUCCEEDED（从失败中学习）
 * - evidenceIds 至少包含一项（fail-closed：无证据不能生成 Outcome）
 * - observedAt 必须是 UTC 时间戳
 * - outcomeId 必须是 out_ 前缀
 */
export const OutcomeRecordSchema = z.object({
  schema: z.literal('awkn-outcome-record/v1'),
  outcomeId: awknIdSchema('out'),
  executionId: awknIdSchema('exec'),
  runId: awknIdSchema('run').optional(),
  /** 执行层 Outcome（动作完成情况） */
  executionOutcome: OutcomeStateSchema,
  /** 交付层 Outcome（产物送达载体情况） */
  deliveryOutcome: OutcomeStateSchema,
  /** 采用层 Outcome（用户实际采用情况，默认 UNKNOWN） */
  adoptionOutcome: OutcomeStateSchema,
  /** 业务层 Outcome（业务目标达成情况，默认 UNKNOWN） */
  businessOutcome: OutcomeStateSchema,
  /** 学习层 Outcome（产生有价值学习情况，默认 UNKNOWN） */
  learningOutcome: OutcomeStateSchema,
  /** 支撑此 Outcome 的证据 ID 列表 */
  evidenceIds: z.array(awknIdSchema('ev')).min(1),
  /** 观察时间（UTC ISO-8601 毫秒精度） */
  observedAt: UtcTimestampSchema,
  /** 观察者（执行观察的 Actor） */
  observer: ActorRefSchema,
  /** 总置信度 [0, 1]（基于证据和归因） */
  confidence: z.number().min(0).max(1),
  /** 归因结果（可选，P0 规则型归因） */
  attribution: OutcomeAttributionSchema.optional(),
  /** 备注（人类可读说明） */
  notes: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  // evidenceIds 不能为空（fail-closed：无证据不能生成 Outcome）
  if (value.evidenceIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidenceIds'],
      message: 'at least one evidence is required to produce an OutcomeRecord',
    });
  }
  // evidenceIds 不能重复
  const seenEvidence = new Set<string>();
  const duplicateEvidence = new Set<string>();
  for (const eid of value.evidenceIds) {
    if (seenEvidence.has(eid)) duplicateEvidence.add(eid);
    seenEvidence.add(eid);
  }
  if (duplicateEvidence.size > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidenceIds'],
      message: `duplicate evidenceId: ${[...duplicateEvidence].sort().join(', ')}`,
    });
  }
  // confidence 与 attribution.confidence 一致性（若 attribution 存在）
  if (value.attribution !== undefined) {
    // attribution.confidence 可小于整体 confidence（整体可能融合其他信号）
    // 但 attribution.confidence 不应高于整体 confidence（部分不应高于整体）
    if (value.attribution.confidence > value.confidence + 1e-9) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attribution', 'confidence'],
        message: 'attribution.confidence cannot exceed overall confidence',
      });
    }
  }
});
export type OutcomeRecord = z.infer<typeof OutcomeRecordSchema>;

export const OUTCOME_RECORD_SCHEMA_ID = 'awkn-outcome-record/v1';

// ===== Section 5: Hash Computation =====

/**
 * 深度剥离 undefined 字段（递归处理对象和数组）.
 *
 * canonical JSON 不允许 undefined 字段，而 OutcomeRecord 中有 optional 字段
 * （如 runId / attribution / notes）。在哈希前剥离它们以保证哈希稳定且不抛错。
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
 * 计算 OutcomeRecord 的稳定哈希（跨平台一致）.
 *
 * 排除运行时字段 outcomeId —— 同一 Outcome 内容（包含 executionId、runId、
 * 五层状态、evidenceIds、observer 等）应产生相同哈希。
 * outcomeId 由系统在创建时分配，不影响 Outcome 内容身份。
 */
export function computeOutcomeRecordHash(
  record: Omit<OutcomeRecord, 'outcomeId'>,
): string {
  const { outcomeId: _outcomeId, ...contentFields } = record as OutcomeRecord;
  void _outcomeId;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(OUTCOME_RECORD_SCHEMA_ID, stripped);
}

/**
 * 计算 OutcomeAttribution 的稳定哈希.
 */
export function computeOutcomeAttributionHash(
  attribution: OutcomeAttribution,
): string {
  const stripped = stripUndefined(attribution as unknown as JsonValue);
  return stableHash(OUTCOME_ATTRIBUTION_SCHEMA_ID, stripped);
}

// ===== Section 6: ID 生成辅助 =====

/** 生成 Outcome ID */
export function createOutcomeId(): string {
  return createAwknId('outcome');
}

// ===== Section 7: 常量 =====

/** 五层 Outcome 字段名（用于查询和报告） */
export const OUTCOME_LAYERS = [
  'executionOutcome',
  'deliveryOutcome',
  'adoptionOutcome',
  'businessOutcome',
  'learningOutcome',
] as const;
export type OutcomeLayer = (typeof OUTCOME_LAYERS)[number];

/** 默认未观察层的 Outcome 状态（fail-closed） */
export const DEFAULT_UNOBSERVED_OUTCOME: OutcomeState = 'UNKNOWN';
