/**
 * Shadow Diff Receipt 合约 (R2 Shadow Integration Phase 4d)
 *
 * 定义 Shadow Diff 的差异分类、Comparison 结构和 Receipt 合约。
 *
 * 9 种差异分类（按严重程度递增）：
 * 1. EXACT                  — 完全一致（legacy 与 R2 值相同）
 * 2. SEMANTIC_EQUIVALENT    — 语义等价（格式不同但内容相同，如排序不同）
 * 3. EXPECTED_IMPROVEMENT   — R2 比 Engine v2 更精确（预期改进）
 * 4. ACCEPTABLE_DIVERGENCE  — 可接受差异（如默认值不同，不影响正确性）
 * 5. MISSING_IN_LEGACY      — Engine v2 缺失该字段（R2 新增能力）
 * 6. MISSING_IN_R2          — R2 缺失该字段（能力回退，需调查）
 * 7. SAFETY_REGRESSION      — 安全回退（R2 比 Engine v2 更不安全）
 * 8. CORRECTNESS_REGRESSION — 正确性回退（R2 输出错误）
 * 9. UNKNOWN                — 无法分类（fail-closed，视为 BLOCKING）
 *
 * 3 种 Overall Verdict：
 * - MATCH     — 全 EXACT/SEMANTIC_EQUIVALENT
 * - ACCEPTABLE — 有 EXPECTED_IMPROVEMENT/ACCEPTABLE_DIVERGENCE/MISSING_IN_LEGACY
 * - BLOCKING  — 有 SAFETY_REGRESSION/CORRECTNESS_REGRESSION/MISSING_IN_R2/UNKNOWN
 *
 * 判定规则（fail-closed，保守）：
 * - 任何 SAFETY_REGRESSION/CORRECTNESS_REGRESSION → BLOCKING（安全/正确性回退不可接受）
 * - 任何 MISSING_IN_R2/UNKNOWN → BLOCKING（无法确认安全性，保守拒绝）
 * - 否则有 EXPECTED_IMPROVEMENT/ACCEPTABLE_DIVERGENCE/MISSING_IN_LEGACY → ACCEPTABLE
 * - 否则全 EXACT/SEMANTIC_EQUIVALENT → MATCH
 */

import { z } from 'zod';
import { awknIdSchema } from '../contracts/ids.js';
import { JsonValueSchema } from '../contracts/json-value.js';
import { SafeNonNegativeIntegerSchema } from '../contracts/numbers.js';
import { UtcTimestampSchema } from '../contracts/time.js';

export const SHADOW_DIFF_RECEIPT_SCHEMA = 'awkn-shadow-diff-receipt/v1';
export const SHADOW_DIFF_COMPARISON_SCHEMA = 'awkn-shadow-diff-comparison/v1';

/** 9 种差异分类 */
export const ShadowDiffClassificationSchema = z.enum([
  'EXACT',
  'SEMANTIC_EQUIVALENT',
  'EXPECTED_IMPROVEMENT',
  'ACCEPTABLE_DIVERGENCE',
  'MISSING_IN_LEGACY',
  'MISSING_IN_R2',
  'SAFETY_REGRESSION',
  'CORRECTNESS_REGRESSION',
  'UNKNOWN',
]);
export type ShadowDiffClassification = z.infer<typeof ShadowDiffClassificationSchema>;

/** 3 种 Overall Verdict */
export const ShadowDiffVerdictSchema = z.enum(['MATCH', 'ACCEPTABLE', 'BLOCKING']);
export type ShadowDiffVerdict = z.infer<typeof ShadowDiffVerdictSchema>;

/** 单个字段比较 */
export const ShadowDiffComparisonSchema = z.object({
  schema: z.literal(SHADOW_DIFF_COMPARISON_SCHEMA),
  field: z.string().min(1),
  legacyValue: JsonValueSchema,
  r2Value: JsonValueSchema,
  classification: ShadowDiffClassificationSchema,
  reason: z.string().min(1),
}).strict();
export type ShadowDiffComparison = z.infer<typeof ShadowDiffComparisonSchema>;

/** Diff Summary（各分类计数） */
export const ShadowDiffSummarySchema = z.object({
  total: SafeNonNegativeIntegerSchema,
  exact: SafeNonNegativeIntegerSchema,
  semanticEquivalent: SafeNonNegativeIntegerSchema,
  expectedImprovement: SafeNonNegativeIntegerSchema,
  acceptableDivergence: SafeNonNegativeIntegerSchema,
  missingInLegacy: SafeNonNegativeIntegerSchema,
  missingInR2: SafeNonNegativeIntegerSchema,
  safetyRegression: SafeNonNegativeIntegerSchema,
  correctnessRegression: SafeNonNegativeIntegerSchema,
  unknown: SafeNonNegativeIntegerSchema,
}).strict().superRefine((value, context) => {
  const sum = value.exact + value.semanticEquivalent + value.expectedImprovement
    + value.acceptableDivergence + value.missingInLegacy + value.missingInR2
    + value.safetyRegression + value.correctnessRegression + value.unknown;
  if (sum !== value.total) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['total'],
      message: `summary counts must sum to total (got ${sum}, expected ${value.total})`,
    });
  }
});
export type ShadowDiffSummary = z.infer<typeof ShadowDiffSummarySchema>;

/** Shadow Diff Receipt（完整差异报告） */
export const ShadowDiffReceiptSchema = z.object({
  schema: z.literal(SHADOW_DIFF_RECEIPT_SCHEMA),
  diffId: awknIdSchema('sdiff'),
  executionId: awknIdSchema('exec'),
  traceId: awknIdSchema('tr'),
  comparisons: z.array(ShadowDiffComparisonSchema).min(1),
  summary: ShadowDiffSummarySchema,
  overallVerdict: ShadowDiffVerdictSchema,
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  // 验证 summary.total 与 comparisons.length 一致
  if (value.summary.total !== value.comparisons.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['summary', 'total'],
      message: `summary.total (${value.summary.total}) must equal comparisons.length (${value.comparisons.length})`,
    });
  }

  // 验证 summary 各分类计数与 comparisons 实际分类一致
  const counts: Record<ShadowDiffClassification, number> = {
    EXACT: 0,
    SEMANTIC_EQUIVALENT: 0,
    EXPECTED_IMPROVEMENT: 0,
    ACCEPTABLE_DIVERGENCE: 0,
    MISSING_IN_LEGACY: 0,
    MISSING_IN_R2: 0,
    SAFETY_REGRESSION: 0,
    CORRECTNESS_REGRESSION: 0,
    UNKNOWN: 0,
  };
  for (const comparison of value.comparisons) {
    counts[comparison.classification]++;
  }
  const summaryFields: Array<[keyof ShadowDiffSummary, ShadowDiffClassification]> = [
    ['exact', 'EXACT'],
    ['semanticEquivalent', 'SEMANTIC_EQUIVALENT'],
    ['expectedImprovement', 'EXPECTED_IMPROVEMENT'],
    ['acceptableDivergence', 'ACCEPTABLE_DIVERGENCE'],
    ['missingInLegacy', 'MISSING_IN_LEGACY'],
    ['missingInR2', 'MISSING_IN_R2'],
    ['safetyRegression', 'SAFETY_REGRESSION'],
    ['correctnessRegression', 'CORRECTNESS_REGRESSION'],
    ['unknown', 'UNKNOWN'],
  ];
  for (const [field, classification] of summaryFields) {
    if (value.summary[field] !== counts[classification]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary', field],
        message: `summary.${field} (${value.summary[field]}) must equal actual count of ${classification} (${counts[classification]})`,
      });
    }
  }

  // 验证 overallVerdict 与 comparisons 一致（fail-closed 规则）
  const expectedVerdict = computeOverallVerdict(value.comparisons.map((c) => c.classification));
  if (value.overallVerdict !== expectedVerdict) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['overallVerdict'],
      message: `overallVerdict (${value.overallVerdict}) must be ${expectedVerdict} based on classifications (fail-closed rule)`,
    });
  }
});
export type ShadowDiffReceipt = z.infer<typeof ShadowDiffReceiptSchema>;

/**
 * 计算 Overall Verdict（fail-closed 保守规则）
 *
 * 这是合约验证使用的纯函数，也是 Evaluator 的核心逻辑。
 */
export function computeOverallVerdict(classifications: readonly ShadowDiffClassification[]): ShadowDiffVerdict {
  if (classifications.length === 0) {
    // 无比较项无法判定，保守视为 BLOCKING
    return 'BLOCKING';
  }

  const has = (c: ShadowDiffClassification): boolean => classifications.includes(c);

  // 规则 1：安全/正确性回退 → BLOCKING
  if (has('SAFETY_REGRESSION') || has('CORRECTNESS_REGRESSION')) {
    return 'BLOCKING';
  }

  // 规则 2：R2 缺失或无法分类 → BLOCKING（无法确认安全性）
  if (has('MISSING_IN_R2') || has('UNKNOWN')) {
    return 'BLOCKING';
  }

  // 规则 3：有可接受差异 → ACCEPTABLE
  if (
    has('EXPECTED_IMPROVEMENT')
    || has('ACCEPTABLE_DIVERGENCE')
    || has('MISSING_IN_LEGACY')
  ) {
    return 'ACCEPTABLE';
  }

  // 规则 4：全 EXACT/SEMANTIC_EQUIVALENT → MATCH
  return 'MATCH';
}
