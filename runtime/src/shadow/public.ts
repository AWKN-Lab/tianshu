/**
 * Shadow Diff Public API (R2 Shadow Integration Phase 4d)
 *
 * 导出：
 * - ShadowDiffReceipt 合约（schema + 9 种分类 + 3 种 verdict）
 * - ShadowDiffEvaluator（classifyDiff + evaluateShadowDiff）
 * - computeOverallVerdict（fail-closed 规则）
 *
 * 使用方式：
 * ```typescript
 * import { classifyDiff, evaluateShadowDiff, buildComparison } from './public.js';
 *
 * // 简单字段比较
 * const result = classifyDiff('intent.primaryIntent', legacyIntent, r2Intent);
 *
 * // 手动构造 comparison（精确分类）
 * const comparison = buildComparison(
 *   'memory.candidates',
 *   0,  // legacy: 空 candidates
 *   5,  // r2: 5 个 candidates
 *   'EXPECTED_IMPROVEMENT',
 *   'R2 provides richer context candidates than Engine v2',
 * );
 *
 * // 评估完整 diff
 * const receipt = evaluateShadowDiff({
 *   executionId,
 *   traceId,
 *   comparisons: [comparison],
 *   clock: () => new Date().toISOString(),
 * });
 * ```
 */

export * from './shadow-diff-receipt.js';
export * from './shadow-diff-evaluator.js';
