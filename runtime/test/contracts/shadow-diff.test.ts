/**
 * Shadow Diff Tests (R2 Shadow Integration Phase 4d)
 *
 * 测试覆盖：
 * 1. classifyDiff: 4 种基础分类（EXACT/MISSING_IN_LEGACY/MISSING_IN_R2/UNKNOWN）
 * 2. buildComparison: 手动构造 Comparison
 * 3. computeSummary: 各分类计数
 * 4. computeOverallVerdict: 9 种分类 × 3 种 verdict 的组合规则
 * 5. evaluateShadowDiff: 完整 Receipt 构造 + schema 验证
 * 6. fail-closed: 空 comparisons 抛错、不一致 summary 抛错
 * 7. 跨平台一致性: deepEqual 不依赖 localeCompare
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyDiff,
  buildComparison,
  computeSummary,
  computeOverallVerdict,
  evaluateShadowDiff,
  ShadowDiffReceiptSchema,
  type ShadowDiffClassification,
  type ShadowDiffComparison,
  type ShadowDiffVerdict,
} from '../../src/shadow/public.js';

const now = '2026-07-28T05:00:00.000Z';
const executionId = 'exec_' + '1'.repeat(32);
const traceId = 'tr_' + '2'.repeat(32);

function buildComparisonAt(
  field: string,
  legacyValue: unknown,
  r2Value: unknown,
  classification: ShadowDiffClassification,
  reason = 'test reason',
): ShadowDiffComparison {
  return buildComparison(
    field,
    legacyValue as never,
    r2Value as never,
    classification,
    reason,
  );
}

function buildReceipt(comparisons: readonly ShadowDiffComparison[]): ReturnType<typeof evaluateShadowDiff> {
  return evaluateShadowDiff({
    executionId,
    traceId,
    comparisons,
    clock: () => now,
  });
}

// ─── classifyDiff ─────────────────────────────────────────────────────

describe('classifyDiff', () => {
  it('classifies as EXACT when values are deeply equal', () => {
    const result = classifyDiff('field1', { a: 1, b: [2, 3] }, { b: [2, 3], a: 1 });
    assert.equal(result.classification, 'EXACT');
    assert.ok(result.reason.includes('deeply equal'));
  });

  it('classifies as EXACT for primitive equal values', () => {
    assert.equal(classifyDiff('f', 'hello', 'hello').classification, 'EXACT');
    assert.equal(classifyDiff('f', 42, 42).classification, 'EXACT');
    assert.equal(classifyDiff('f', true, true).classification, 'EXACT');
    assert.equal(classifyDiff('f', null, null).classification, 'EXACT');
  });

  it('classifies as MISSING_IN_LEGACY when legacy is null/undefined', () => {
    const r = classifyDiff('field', null, 'r2 value');
    assert.equal(r.classification, 'MISSING_IN_LEGACY');
    assert.ok(r.reason.includes('legacy value is null/undefined'));
  });

  it('classifies as MISSING_IN_R2 when r2 is null/undefined', () => {
    const r = classifyDiff('field', 'legacy value', null);
    assert.equal(r.classification, 'MISSING_IN_R2');
    assert.ok(r.reason.includes('r2 value is null/undefined'));
  });

  it('classifies as UNKNOWN when values differ and neither is null/undefined', () => {
    const r = classifyDiff('field', 'legacy', 'r2');
    assert.equal(r.classification, 'UNKNOWN');
    assert.ok(r.reason.includes('needs semantic classification'));
  });

  it('classifies as UNKNOWN for different objects with same keys', () => {
    const r = classifyDiff('field', { a: 1 }, { a: 2 });
    assert.equal(r.classification, 'UNKNOWN');
  });

  it('classifies as UNKNOWN for arrays with different length', () => {
    const r = classifyDiff('field', [1, 2, 3], [1, 2]);
    assert.equal(r.classification, 'UNKNOWN');
  });
});

// ─── buildComparison ───────────────────────────────────────────────────

describe('buildComparison', () => {
  it('builds a comparison with explicit classification', () => {
    const c = buildComparisonAt('intent.primaryIntent', 'legacy intent', 'r2 intent', 'SEMANTIC_EQUIVALENT');
    assert.equal(c.field, 'intent.primaryIntent');
    assert.equal(c.classification, 'SEMANTIC_EQUIVALENT');
    assert.equal(c.schema, 'awkn-shadow-diff-comparison/v1');
  });

  it('allows building EXPECTED_IMPROVEMENT for R2 improvements', () => {
    const c = buildComparisonAt('memory.candidates', 0, 5, 'EXPECTED_IMPROVEMENT', 'R2 provides richer context');
    assert.equal(c.classification, 'EXPECTED_IMPROVEMENT');
    assert.equal(c.reason, 'R2 provides richer context');
  });

  it('allows building SAFETY_REGRESSION for safety issues', () => {
    const c = buildComparisonAt('goal.verdict', 'ACHIEVED', 'UNKNOWN', 'SAFETY_REGRESSION');
    assert.equal(c.classification, 'SAFETY_REGRESSION');
  });
});

// ─── computeSummary ───────────────────────────────────────────────────

describe('computeSummary', () => {
  it('counts each classification correctly', () => {
    const comparisons: ShadowDiffComparison[] = [
      buildComparisonAt('f1', 'a', 'a', 'EXACT'),
      buildComparisonAt('f2', 'a', 'b', 'UNKNOWN'),
      buildComparisonAt('f3', null, 'b', 'MISSING_IN_LEGACY'),
      buildComparisonAt('f4', 'a', null, 'MISSING_IN_R2'),
      buildComparisonAt('f5', 'a', 'b', 'SAFETY_REGRESSION'),
      buildComparisonAt('f6', 'a', 'b', 'CORRECTNESS_REGRESSION'),
      buildComparisonAt('f7', 'a', 'b', 'EXPECTED_IMPROVEMENT'),
      buildComparisonAt('f8', 'a', 'b', 'ACCEPTABLE_DIVERGENCE'),
      buildComparisonAt('f9', 'a', 'a', 'SEMANTIC_EQUIVALENT'),
    ];
    const summary = computeSummary(comparisons);
    assert.equal(summary.total, 9);
    assert.equal(summary.exact, 1);
    assert.equal(summary.semanticEquivalent, 1);
    assert.equal(summary.expectedImprovement, 1);
    assert.equal(summary.acceptableDivergence, 1);
    assert.equal(summary.missingInLegacy, 1);
    assert.equal(summary.missingInR2, 1);
    assert.equal(summary.safetyRegression, 1);
    assert.equal(summary.correctnessRegression, 1);
    assert.equal(summary.unknown, 1);
  });

  it('handles empty comparisons', () => {
    const summary = computeSummary([]);
    assert.equal(summary.total, 0);
    assert.equal(summary.exact, 0);
  });
});

// ─── computeOverallVerdict ────────────────────────────────────────────

describe('computeOverallVerdict', () => {
  it('returns BLOCKING for empty classifications (fail-closed)', () => {
    assert.equal(computeOverallVerdict([]), 'BLOCKING');
  });

  it('returns MATCH when all EXACT', () => {
    assert.equal(computeOverallVerdict(['EXACT', 'EXACT', 'EXACT']), 'MATCH');
  });

  it('returns MATCH when all SEMANTIC_EQUIVALENT', () => {
    assert.equal(computeOverallVerdict(['SEMANTIC_EQUIVALENT']), 'MATCH');
  });

  it('returns MATCH for mix of EXACT and SEMANTIC_EQUIVALENT', () => {
    assert.equal(computeOverallVerdict(['EXACT', 'SEMANTIC_EQUIVALENT']), 'MATCH');
  });

  it('returns ACCEPTABLE when EXPECTED_IMPROVEMENT present', () => {
    assert.equal(computeOverallVerdict(['EXACT', 'EXPECTED_IMPROVEMENT']), 'ACCEPTABLE');
  });

  it('returns ACCEPTABLE when ACCEPTABLE_DIVERGENCE present', () => {
    assert.equal(computeOverallVerdict(['EXACT', 'ACCEPTABLE_DIVERGENCE']), 'ACCEPTABLE');
  });

  it('returns ACCEPTABLE when MISSING_IN_LEGACY present', () => {
    assert.equal(computeOverallVerdict(['EXACT', 'MISSING_IN_LEGACY']), 'ACCEPTABLE');
  });

  it('returns BLOCKING when SAFETY_REGRESSION present', () => {
    assert.equal(computeOverallVerdict(['EXACT', 'SAFETY_REGRESSION']), 'BLOCKING');
  });

  it('returns BLOCKING when CORRECTNESS_REGRESSION present', () => {
    assert.equal(computeOverallVerdict(['EXACT', 'CORRECTNESS_REGRESSION']), 'BLOCKING');
  });

  it('returns BLOCKING when MISSING_IN_R2 present', () => {
    assert.equal(computeOverallVerdict(['EXACT', 'MISSING_IN_R2']), 'BLOCKING');
  });

  it('returns BLOCKING when UNKNOWN present (fail-closed)', () => {
    assert.equal(computeOverallVerdict(['EXACT', 'UNKNOWN']), 'BLOCKING');
  });

  it('SAFETY_REGRESSION takes precedence over ACCEPTABLE classifications', () => {
    assert.equal(
      computeOverallVerdict(['EXPECTED_IMPROVEMENT', 'SAFETY_REGRESSION', 'ACCEPTABLE_DIVERGENCE']),
      'BLOCKING',
    );
  });

  it('UNKNOWN takes precedence over ACCEPTABLE classifications', () => {
    assert.equal(
      computeOverallVerdict(['EXPECTED_IMPROVEMENT', 'UNKNOWN']),
      'BLOCKING',
    );
  });
});

// ─── evaluateShadowDiff ──────────────────────────────────────────────

describe('evaluateShadowDiff', () => {
  it('constructs a valid ShadowDiffReceipt for MATCH case', () => {
    const comparisons: ShadowDiffComparison[] = [
      buildComparisonAt('input.rawInput', '{"hello":"world"}', '{"hello":"world"}', 'EXACT'),
      buildComparisonAt('intent.primaryIntent', 'analyze', 'analyze', 'EXACT'),
    ];
    const receipt = buildReceipt(comparisons);

    assert.equal(receipt.schema, 'awkn-shadow-diff-receipt/v1');
    assert.equal(receipt.executionId, executionId);
    assert.equal(receipt.traceId, traceId);
    assert.equal(receipt.comparisons.length, 2);
    assert.equal(receipt.summary.total, 2);
    assert.equal(receipt.summary.exact, 2);
    assert.equal(receipt.overallVerdict, 'MATCH');
    assert.equal(receipt.createdAt, now);
    assert.ok(receipt.diffId.startsWith('sdiff_'));
  });

  it('constructs a valid ShadowDiffReceipt for ACCEPTABLE case', () => {
    const comparisons: ShadowDiffComparison[] = [
      buildComparisonAt('input.rawInput', 'a', 'a', 'EXACT'),
      buildComparisonAt('memory.candidates', 0, 5, 'EXPECTED_IMPROVEMENT', 'R2 provides richer context'),
    ];
    const receipt = buildReceipt(comparisons);
    assert.equal(receipt.overallVerdict, 'ACCEPTABLE');
    assert.equal(receipt.summary.expectedImprovement, 1);
  });

  it('constructs a valid ShadowDiffReceipt for BLOCKING case', () => {
    const comparisons: ShadowDiffComparison[] = [
      buildComparisonAt('goal.verdict', 'ACHIEVED', 'UNKNOWN', 'SAFETY_REGRESSION'),
    ];
    const receipt = buildReceipt(comparisons);
    assert.equal(receipt.overallVerdict, 'BLOCKING');
    assert.equal(receipt.summary.safetyRegression, 1);
  });

  it('passes schema validation through ShadowDiffReceiptSchema.parse', () => {
    const comparisons: ShadowDiffComparison[] = [
      buildComparisonAt('f', 'a', 'a', 'EXACT'),
    ];
    const receipt = buildReceipt(comparisons);
    // 再次 parse 应该不抛错
    const reparsed = ShadowDiffReceiptSchema.parse(receipt);
    assert.equal(reparsed.diffId, receipt.diffId);
  });

  it('throws when comparisons is empty', () => {
    assert.throws(
      () => buildReceipt([]),
      (err: Error) => err.message.includes('comparisons must not be empty'),
    );
  });

  it('throws when summary total does not match comparisons length (schema validation)', () => {
    // 通过直接构造非法 receipt 测试 schema 验证
    const invalidReceipt = {
      schema: 'awkn-shadow-diff-receipt/v1',
      diffId: 'sdiff_' + 'a'.repeat(32),
      executionId,
      traceId,
      comparisons: [buildComparisonAt('f', 'a', 'a', 'EXACT')],
      summary: {
        total: 99, // 故意错误
        exact: 1,
        semanticEquivalent: 0,
        expectedImprovement: 0,
        acceptableDivergence: 0,
        missingInLegacy: 0,
        missingInR2: 0,
        safetyRegression: 0,
        correctnessRegression: 0,
        unknown: 0,
      },
      overallVerdict: 'MATCH' as ShadowDiffVerdict,
      createdAt: now,
    };
    assert.throws(
      () => ShadowDiffReceiptSchema.parse(invalidReceipt),
      (err: { issues: Array<{ message: string }> }) =>
        err.issues.some((i: { message: string }) => i.message.includes('must equal comparisons.length')),
    );
  });

  it('throws when overallVerdict does not match classifications (schema validation)', () => {
    const invalidReceipt = {
      schema: 'awkn-shadow-diff-receipt/v1',
      diffId: 'sdiff_' + 'b'.repeat(32),
      executionId,
      traceId,
      comparisons: [buildComparisonAt('f', 'a', 'b', 'SAFETY_REGRESSION')],
      summary: {
        total: 1,
        exact: 0,
        semanticEquivalent: 0,
        expectedImprovement: 0,
        acceptableDivergence: 0,
        missingInLegacy: 0,
        missingInR2: 0,
        safetyRegression: 1,
        correctnessRegression: 0,
        unknown: 0,
      },
      overallVerdict: 'MATCH' as ShadowDiffVerdict, // 故意错误（应该是 BLOCKING）
      createdAt: now,
    };
    assert.throws(
      () => ShadowDiffReceiptSchema.parse(invalidReceipt),
      (err: { issues: Array<{ message: string }> }) =>
        err.issues.some((i: { message: string }) => i.message.includes('must be BLOCKING')),
    );
  });
});

// ─── 跨平台一致性 + 确定性 ─────────────────────────────────────────────

describe('Cross-platform consistency and determinism', () => {
  it('deepEqual treats objects with same keys in different order as equal', () => {
    // classifyDiff 内部使用 deepEqual
    const r1 = classifyDiff('f', { a: 1, b: 2 }, { b: 2, a: 1 });
    assert.equal(r1.classification, 'EXACT');
  });

  it('produces identical receipt for identical input (determinism)', () => {
    const comparisons: ShadowDiffComparison[] = [
      buildComparisonAt('f1', 'a', 'a', 'EXACT'),
      buildComparisonAt('f2', 'b', 'c', 'UNKNOWN'),
    ];
    const receipt1 = buildReceipt(comparisons);
    const receipt2 = buildReceipt(comparisons);
    // diffId 是随机生成的，所以只比较其他字段
    assert.equal(receipt1.executionId, receipt2.executionId);
    assert.equal(receipt1.traceId, receipt2.traceId);
    assert.deepEqual(receipt1.comparisons, receipt2.comparisons);
    assert.deepEqual(receipt1.summary, receipt2.summary);
    assert.equal(receipt1.overallVerdict, receipt2.overallVerdict);
  });

  it('produces stable summary for the same classification set', () => {
    const comparisons1: ShadowDiffComparison[] = [
      buildComparisonAt('f1', 'a', 'a', 'EXACT'),
      buildComparisonAt('f2', 'b', 'c', 'UNKNOWN'),
    ];
    const comparisons2: ShadowDiffComparison[] = [
      buildComparisonAt('x1', 'a', 'a', 'EXACT'),
      buildComparisonAt('x2', 'b', 'c', 'UNKNOWN'),
    ];
    // 不同 field 名称但相同 classification 集合 → 相同 summary
    assert.deepEqual(computeSummary(comparisons1), computeSummary(comparisons2));
  });
});
