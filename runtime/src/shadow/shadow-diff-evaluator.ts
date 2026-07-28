/**
 * Shadow Diff Evaluator (R2 Shadow Integration Phase 4d)
 *
 * 提供：
 * 1. classifyDiff: 简单字段比较 → 9 种分类
 * 2. evaluateShadowDiff: 接受 comparisons 数组 → 构造 ShadowDiffReceipt
 *
 * 设计原则：
 * - 纯函数（不触发副作用、不持久化）
 * - fail-closed（无法分类时归为 UNKNOWN，触发 BLOCKING）
 * - 确定性（相同输入相同输出）
 * - 跨平台一致（不使用 localeCompare）
 *
 * 注意：复杂语义分类（如 SEMANTIC_EQUIVALENT、EXPECTED_IMPROVEMENT）需要更智能的比较器，
 * 当前 classifyDiff 只做基础分类（EXACT/MISSING_IN_LEGACY/MISSING_IN_R2/UNKNOWN）。
 * 调用方可手动指定 classification（用于精确控制，如标记 EXPECTED_IMPROVEMENT）。
 */

import { createAwknId } from '../contracts/ids.js';
import type { JsonValue } from '../contracts/json-value.js';
import {
  SHADOW_DIFF_COMPARISON_SCHEMA,
  SHADOW_DIFF_RECEIPT_SCHEMA,
  computeOverallVerdict,
  ShadowDiffReceiptSchema,
  type ShadowDiffClassification,
  type ShadowDiffComparison,
  type ShadowDiffReceipt,
  type ShadowDiffSummary,
  type ShadowDiffVerdict,
} from './shadow-diff-receipt.js';

/**
 * 深度相等比较（跨平台一致，不使用 localeCompare）。
 *
 * 对象 key 排序使用 compareByCodePoint（与 PR #64 一致，确保跨平台 Hash 一致）。
 */
function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, (b as JsonValue[])[index]));
  }
  // 两者都是对象
  const aObj = a as Record<string, JsonValue>;
  const bObj = b as Record<string, JsonValue>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  // 使用 compareByCodePoint 排序确保跨平台一致
  const sortedA = [...aKeys].sort(compareByCodePoint);
  const sortedB = [...bKeys].sort(compareByCodePoint);
  if (!sortedA.every((k, i) => k === sortedB[i])) return false;
  return sortedA.every((k) => deepEqual(aObj[k], bObj[k]));
}

/**
 * Unicode Code Point 比较器（跨平台一致，替代 localeCompare）。
 *
 * 与 PR #64 的 compareByCodePoint 一致，确保跨平台 Hash 一致。
 */
function compareByCodePoint(a: string, b: string): number {
  const aCodes = [...a].map((c) => c.codePointAt(0)!);
  const bCodes = [...b].map((c) => c.codePointAt(0)!);
  const len = Math.min(aCodes.length, bCodes.length);
  for (let i = 0; i < len; i++) {
    if (aCodes[i] !== bCodes[i]) return aCodes[i] - bCodes[i];
  }
  return aCodes.length - bCodes.length;
}

/**
 * 简单字段比较 → 分类。
 *
 * 分类规则：
 * - 深度相等 → EXACT
 * - legacy 为 null/undefined → MISSING_IN_LEGACY
 * - r2 为 null/undefined → MISSING_IN_R2
 * - 其他 → UNKNOWN（需要调用方手动指定更精确的分类）
 *
 * @param field 字段名（如 'input.rawInput'）
 * @param legacyValue Engine v2 的值
 * @param r2Value R2 的值
 */
export function classifyDiff(
  field: string,
  legacyValue: JsonValue,
  r2Value: JsonValue,
): { classification: ShadowDiffClassification; reason: string } {
  if (deepEqual(legacyValue, r2Value)) {
    return {
      classification: 'EXACT',
      reason: `field '${field}': values are deeply equal`,
    };
  }
  if (legacyValue === null || legacyValue === undefined) {
    return {
      classification: 'MISSING_IN_LEGACY',
      reason: `field '${field}': legacy value is null/undefined (R2 provides new capability)`,
    };
  }
  if (r2Value === null || r2Value === undefined) {
    return {
      classification: 'MISSING_IN_R2',
      reason: `field '${field}': r2 value is null/undefined (R2 regression)`,
    };
  }
  return {
    classification: 'UNKNOWN',
    reason: `field '${field}': values differ; needs semantic classification`,
  };
}

/**
 * 手动构造 Comparison（用于调用方精确指定 classification）。
 *
 * 用于语义等价、预期改进等需要人工判断的场景。
 */
export function buildComparison(
  field: string,
  legacyValue: JsonValue,
  r2Value: JsonValue,
  classification: ShadowDiffClassification,
  reason: string,
): ShadowDiffComparison {
  return {
    schema: SHADOW_DIFF_COMPARISON_SCHEMA,
    field,
    legacyValue,
    r2Value,
    classification,
    reason,
  };
}

/**
 * 计算 Summary（各分类计数）。
 */
export function computeSummary(comparisons: readonly ShadowDiffComparison[]): ShadowDiffSummary {
  const summary: ShadowDiffSummary = {
    total: comparisons.length,
    exact: 0,
    semanticEquivalent: 0,
    expectedImprovement: 0,
    acceptableDivergence: 0,
    missingInLegacy: 0,
    missingInR2: 0,
    safetyRegression: 0,
    correctnessRegression: 0,
    unknown: 0,
  };
  for (const comparison of comparisons) {
    switch (comparison.classification) {
      case 'EXACT': summary.exact++; break;
      case 'SEMANTIC_EQUIVALENT': summary.semanticEquivalent++; break;
      case 'EXPECTED_IMPROVEMENT': summary.expectedImprovement++; break;
      case 'ACCEPTABLE_DIVERGENCE': summary.acceptableDivergence++; break;
      case 'MISSING_IN_LEGACY': summary.missingInLegacy++; break;
      case 'MISSING_IN_R2': summary.missingInR2++; break;
      case 'SAFETY_REGRESSION': summary.safetyRegression++; break;
      case 'CORRECTNESS_REGRESSION': summary.correctnessRegression++; break;
      case 'UNKNOWN': summary.unknown++; break;
    }
  }
  return summary;
}

/**
 * Shadow Diff Evaluator 输入。
 */
export interface ShadowDiffEvaluatorInput {
  readonly executionId: string;
  readonly traceId: string;
  readonly comparisons: readonly ShadowDiffComparison[];
  readonly clock: () => string;
}

/**
 * 评估 Shadow Diff，构造 ShadowDiffReceipt。
 *
 * 步骤：
 * 1. 计算 Summary（各分类计数）
 * 2. 计算 Overall Verdict（fail-closed 规则）
 * 3. 构造 ShadowDiffReceipt 并通过 schema 验证
 *
 * @throws {z.ZodError} 如果 comparisons 为空或 summary/verdict 不一致
 */
export function evaluateShadowDiff(input: ShadowDiffEvaluatorInput): ShadowDiffReceipt {
  if (input.comparisons.length === 0) {
    throw new Error('evaluateShadowDiff: comparisons must not be empty');
  }

  const summary = computeSummary(input.comparisons);
  const overallVerdict: ShadowDiffVerdict = computeOverallVerdict(
    input.comparisons.map((c) => c.classification),
  );

  const receipt: ShadowDiffReceipt = {
    schema: SHADOW_DIFF_RECEIPT_SCHEMA,
    diffId: createAwknId('shadowDiff'),
    executionId: input.executionId,
    traceId: input.traceId,
    comparisons: [...input.comparisons],
    summary,
    overallVerdict,
    createdAt: input.clock(),
  };

  // 通过 schema 验证（包括 summary 一致性、verdict 一致性）
  return ShadowDiffReceiptSchema.parse(receipt);
}

// 重新导出合约类型，便于调用方使用
export * from './shadow-diff-receipt.js';
