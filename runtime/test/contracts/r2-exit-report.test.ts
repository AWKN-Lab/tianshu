/**
 * R2 Exit Report Tests (R2 Shadow Integration Phase 4f)
 *
 * 测试覆盖：
 * 1. 统计汇总（verdict 分布、classification 分布、占比计算）
 * 2. 跨平台 Hash 一致性验证
 * 3. Exit Decision（GO / NO_GO / CONDITIONAL_GO）
 * 4. Issue #43 决策证据
 * 5. Markdown 渲染
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateR2ExitReport,
  renderR2ExitReportMarkdown,
  DEFAULT_THRESHOLDS,
  type ShadowExecutionRecord,
} from '../../src/shadow/r2-exit-report.js';
import { evaluateShadowDiff, buildComparison } from '../../src/shadow/shadow-diff-evaluator.js';
import type { ShadowDiffReceipt } from '../../src/shadow/shadow-diff-receipt.js';

const now = '2026-07-28T06:00:00.000Z';
const executionId = 'exec_' + 'a'.repeat(32);
const traceId = 'tr_' + 'b'.repeat(32);

function buildReceipt(opts: {
  classifications?: Parameters<typeof buildComparison>[3] | Parameters<typeof buildComparison>[3][];
  clock?: () => string;
  executionId?: string;
  traceId?: string;
} = {}): ShadowDiffReceipt {
  const clock = opts.clock ?? (() => now);
  const execId = opts.executionId ?? executionId;
  const trId = opts.traceId ?? traceId;

  let classifications: Parameters<typeof buildComparison>[3][];
  if (opts.classifications === undefined) {
    classifications = ['EXACT'];
  } else if (Array.isArray(opts.classifications)) {
    classifications = opts.classifications;
  } else {
    classifications = [opts.classifications];
  }

  const comparisons = classifications.map((cls, i) =>
    buildComparison(`field_${i}`, 'legacy-value', 'r2-value', cls, `test ${cls}`),
  );

  return evaluateShadowDiff({
    executionId: execId,
    traceId: trId,
    comparisons,
    clock,
  });
}

function buildRecord(opts: {
  classifications?: Parameters<typeof buildComparison>[3] | Parameters<typeof buildComparison>[3][];
  platform?: string;
  executionId?: string;
  traceId?: string;
  executedAt?: string;
} = {}): ShadowExecutionRecord {
  return {
    receipt: buildReceipt({
      classifications: opts.classifications,
      executionId: opts.executionId,
      traceId: opts.traceId,
    }),
    platform: opts.platform ?? 'win-x64',
    executedAt: opts.executedAt ?? now,
  };
}

function buildMultiPlatformRecords(
  classifications: Parameters<typeof buildComparison>[3][],
  platforms: string[],
): ShadowExecutionRecord[] {
  const records: ShadowExecutionRecord[] = [];
  for (const platform of platforms) {
    records.push({
      receipt: buildReceipt({ classifications }),
      platform,
      executedAt: now,
    });
  }
  return records;
}

function uniqueExecutionId(i: number): string {
  return 'exec_' + i.toString().padStart(32, '0');
}

// ─── Statistics ──────────────────────────────────────────────────────

describe('R2 Exit Report — Statistics', () => {
  it('computes verdict distribution correctly', () => {
    const records = [
      buildRecord({ classifications: ['EXACT'] }), // MATCH
      buildRecord({ classifications: ['EXACT', 'EXPECTED_IMPROVEMENT'] }), // ACCEPTABLE
      buildRecord({ classifications: ['SAFETY_REGRESSION'] }), // BLOCKING
    ];
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.statistics.verdictDistribution.MATCH, 1);
    assert.equal(report.statistics.verdictDistribution.ACCEPTABLE, 1);
    assert.equal(report.statistics.verdictDistribution.BLOCKING, 1);
  });

  it('computes classification distribution correctly', () => {
    const records = [
      buildRecord({ classifications: ['EXACT', 'EXACT'] }),
      buildRecord({ classifications: ['EXPECTED_IMPROVEMENT', 'MISSING_IN_LEGACY'] }),
    ];
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.statistics.classificationDistribution.EXACT, 2);
    assert.equal(report.statistics.classificationDistribution.EXPECTED_IMPROVEMENT, 1);
    assert.equal(report.statistics.classificationDistribution.MISSING_IN_LEGACY, 1);
  });

  it('computes blocking ratio correctly', () => {
    const records = [
      buildRecord({ classifications: ['EXACT'] }), // MATCH
      buildRecord({ classifications: ['EXACT'] }), // MATCH
      buildRecord({ classifications: ['EXACT'] }), // MATCH
      buildRecord({ classifications: ['SAFETY_REGRESSION'] }), // BLOCKING
    ];
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.statistics.blockingRatio, 0.25);
  });

  it('collects platforms from records', () => {
    const records = [
      buildRecord({ platform: 'win-x64' }),
      buildRecord({ platform: 'linux-x64' }),
      buildRecord({ platform: 'darwin-arm64' }),
    ];
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.deepEqual(report.statistics.platforms, ['darwin-arm64', 'linux-x64', 'win-x64']);
  });

  it('handles empty records', () => {
    const report = generateR2ExitReport([], { clock: () => now });
    assert.equal(report.statistics.totalExecutions, 0);
    assert.equal(report.statistics.totalComparisons, 0);
    assert.equal(report.statistics.blockingRatio, 0);
    assert.equal(report.statistics.safetyRegressionCount, 0);
  });
});

// ─── Hash Verification ───────────────────────────────────────────────

describe('R2 Exit Report — Hash Verification', () => {
  it('returns consistent when single platform (no cross-platform check)', () => {
    const records = [buildRecord({ platform: 'win-x64' })];
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.hashVerification.consistent, true);
    assert.equal(report.hashVerification.checkedReceipts, 0); // 单平台不检查
    assert.equal(report.hashVerification.inconsistentReceipts, 0);
  });

  it('returns consistent when multiple platforms produce identical receipts', () => {
    const records = buildMultiPlatformRecords(['EXACT', 'EXACT'], ['win-x64', 'linux-x64']);
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.hashVerification.consistent, true);
    assert.equal(report.hashVerification.checkedReceipts, 2);
    assert.equal(report.hashVerification.inconsistentReceipts, 0);
  });

  it('detects inconsistency when platforms produce different receipts', () => {
    // Same executionId/traceId but different classifications on different platforms
    const winReceipt = buildReceipt({ classifications: ['EXACT'] });
    const linuxReceipt = buildReceipt({ classifications: ['SAFETY_REGRESSION'] });

    const records: ShadowExecutionRecord[] = [
      { receipt: winReceipt, platform: 'win-x64', executedAt: now },
      { receipt: linuxReceipt, platform: 'linux-x64', executedAt: now },
    ];
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.hashVerification.consistent, false);
    assert.equal(report.hashVerification.inconsistentReceipts, 1);
    assert.equal(report.hashVerification.inconsistencies[0]!.platforms.length, 2);
  });

  it('groups by executionId+traceId correctly', () => {
    const exec1 = 'exec_' + '1'.repeat(32);
    const exec2 = 'exec_' + '2'.repeat(32);
    const records = [
      buildRecord({ executionId: exec1, platform: 'win-x64' }),
      buildRecord({ executionId: exec1, platform: 'linux-x64' }),
      buildRecord({ executionId: exec2, platform: 'win-x64' }),
      // exec2 only on win-x64 → single platform, not checked
    ];
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.hashVerification.checkedReceipts, 2); // only exec1 group (2 platforms)
  });
});

// ─── Exit Decision ───────────────────────────────────────────────────

describe('R2 Exit Report — Exit Decision', () => {
  it('returns CONDITIONAL_GO when sample size < threshold', () => {
    const records: ShadowExecutionRecord[] = [];
    for (let i = 0; i < DEFAULT_THRESHOLDS.minSampleSize - 1; i++) {
      records.push(buildRecord({ classifications: ['EXACT'] }));
    }
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.decision, 'CONDITIONAL_GO');
    assert.ok(report.decisionReasons.some((r) => r.includes('INSUFFICIENT_SAMPLES')));
  });

  it('returns GO when all checks pass with sufficient samples', () => {
    const records: ShadowExecutionRecord[] = [];
    for (let i = 0; i < DEFAULT_THRESHOLDS.minSampleSize; i++) {
      records.push(buildRecord({ classifications: ['EXACT', 'SEMANTIC_EQUIVALENT'] }));
    }
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.decision, 'GO');
    assert.ok(report.decisionReasons.some((r) => r.includes('ALL_CHECKS_PASSED')));
  });

  it('returns NO_GO when SAFETY_REGRESSION detected', () => {
    const records: ShadowExecutionRecord[] = [];
    for (let i = 0; i < DEFAULT_THRESHOLDS.minSampleSize; i++) {
      records.push(buildRecord({ classifications: ['EXACT'], executionId: uniqueExecutionId(i) }));
    }
    records.push(buildRecord({ classifications: ['SAFETY_REGRESSION'], executionId: uniqueExecutionId(999) }));
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.decision, 'NO_GO');
    assert.ok(report.decisionReasons.some((r) => r.includes('SAFETY_REGRESSION_DETECTED')));
  });

  it('returns NO_GO when CORRECTNESS_REGRESSION detected', () => {
    const records: ShadowExecutionRecord[] = [];
    for (let i = 0; i < DEFAULT_THRESHOLDS.minSampleSize; i++) {
      records.push(buildRecord({ classifications: ['EXACT'], executionId: uniqueExecutionId(i) }));
    }
    records.push(buildRecord({ classifications: ['CORRECTNESS_REGRESSION'], executionId: uniqueExecutionId(998) }));
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.decision, 'NO_GO');
    assert.ok(report.decisionReasons.some((r) => r.includes('CORRECTNESS_REGRESSION_DETECTED')));
  });

  it('returns NO_GO when BLOCKING ratio exceeds threshold', () => {
    const records: ShadowExecutionRecord[] = [];
    // 8 MATCH + 3 BLOCKING = 27% BLOCKING > 20% threshold
    for (let i = 0; i < 8; i++) {
      records.push(buildRecord({ classifications: ['EXACT'], executionId: uniqueExecutionId(i) }));
    }
    for (let i = 100; i < 103; i++) {
      records.push(buildRecord({ classifications: ['UNKNOWN', 'MISSING_IN_R2'], executionId: uniqueExecutionId(i) }));
    }
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.decision, 'NO_GO');
    assert.ok(report.decisionReasons.some((r) => r.includes('BLOCKING_RATIO_EXCEEDED')));
  });

  it('returns NO_GO when cross-platform hash inconsistent', () => {
    const records: ShadowExecutionRecord[] = [];
    for (let i = 0; i < DEFAULT_THRESHOLDS.minSampleSize; i++) {
      const execId = 'exec_' + i.toString().padStart(32, '0');
      records.push({
        receipt: buildReceipt({ classifications: ['EXACT'], executionId: execId }),
        platform: 'win-x64',
        executedAt: now,
      });
      // Same executionId but different classification on linux
      records.push({
        receipt: buildReceipt({ classifications: ['EXPECTED_IMPROVEMENT'], executionId: execId }),
        platform: 'linux-x64',
        executedAt: now,
      });
    }
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.decision, 'NO_GO');
    assert.ok(report.decisionReasons.some((r) => r.includes('CROSS_PLATFORM_HASH_INCONSISTENT')));
  });

  it('SAFETY_REGRESSION takes precedence over insufficient samples', () => {
    // Even with insufficient samples, SAFETY_REGRESSION → NO_GO (not CONDITIONAL_GO)
    const records = [
      buildRecord({ classifications: ['SAFETY_REGRESSION'] }),
    ];
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.decision, 'NO_GO');
  });
});

// ─── Issue #43 Evidence ──────────────────────────────────────────────

describe('R2 Exit Report — Issue #43 Evidence', () => {
  it('marks all checks as ready when GO', () => {
    const records: ShadowExecutionRecord[] = [];
    for (let i = 0; i < DEFAULT_THRESHOLDS.minSampleSize; i++) {
      records.push(buildRecord({ classifications: ['EXACT'] }));
    }
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.issue43Evidence.r2ComponentsReady, true);
    assert.equal(report.issue43Evidence.shadowIntegrationPassed, true);
    assert.equal(report.issue43Evidence.crossPlatformConsistent, true);
    assert.equal(report.issue43Evidence.blockers.length, 0);
    assert.ok(report.issue43Evidence.recommendedNextSteps.length > 0);
  });

  it('lists blockers when NO_GO', () => {
    const records = [buildRecord({ classifications: ['SAFETY_REGRESSION'] })];
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.ok(report.issue43Evidence.blockers.length > 0);
    assert.ok(report.issue43Evidence.blockers.some((b) => b.includes('SAFETY_REGRESSION')));
  });

  it('provides enforce promotion steps when GO', () => {
    const records: ShadowExecutionRecord[] = [];
    for (let i = 0; i < DEFAULT_THRESHOLDS.minSampleSize; i++) {
      records.push(buildRecord({ classifications: ['EXACT'] }));
    }
    const report = generateR2ExitReport(records, { clock: () => now });
    const steps = report.issue43Evidence.recommendedNextSteps;
    assert.ok(steps.some((s) => s.includes('enforce')));
    assert.ok(steps.some((s) => s.includes('Phase 6')));
  });

  it('provides sample collection steps when CONDITIONAL_GO', () => {
    const records = [buildRecord({ classifications: ['EXACT'] })];
    const report = generateR2ExitReport(records, { clock: () => now });
    const steps = report.issue43Evidence.recommendedNextSteps;
    assert.ok(steps.some((s) => s.includes('samples')));
  });

  it('provides investigation steps when NO_GO', () => {
    const records = [buildRecord({ classifications: ['SAFETY_REGRESSION'] })];
    const report = generateR2ExitReport(records, { clock: () => now });
    const steps = report.issue43Evidence.recommendedNextSteps;
    assert.ok(steps.some((s) => s.includes('Do NOT promote')));
    assert.ok(steps.some((s) => s.includes('Investigate')));
  });
});

// ─── Markdown Rendering ──────────────────────────────────────────────

describe('R2 Exit Report — Markdown Rendering', () => {
  it('renders a valid Markdown document', () => {
    const records = [
      buildRecord({ classifications: ['EXACT'] }),
      buildRecord({ classifications: ['EXPECTED_IMPROVEMENT'] }),
    ];
    const report = generateR2ExitReport(records, { clock: () => now });
    const markdown = renderR2ExitReportMarkdown(report);

    assert.ok(markdown.includes('# R2 Exit Report'));
    assert.ok(markdown.includes('## Decision Reasons'));
    assert.ok(markdown.includes('## Shadow Diff Statistics'));
    assert.ok(markdown.includes('## Cross-Platform Hash Verification'));
    assert.ok(markdown.includes('## Issue #43 Decision Evidence'));
    assert.ok(markdown.includes('### Verdict Distribution'));
    assert.ok(markdown.includes('### Classification Distribution'));
    assert.ok(markdown.includes('### Recommended Next Steps'));
  });

  it('includes decision in header', () => {
    const records: ShadowExecutionRecord[] = [];
    for (let i = 0; i < DEFAULT_THRESHOLDS.minSampleSize; i++) {
      records.push(buildRecord({ classifications: ['EXACT'] }));
    }
    const report = generateR2ExitReport(records, { clock: () => now });
    const markdown = renderR2ExitReportMarkdown(report);
    assert.ok(markdown.includes('**Decision:** GO'));
  });

  it('includes inconsistencies when present', () => {
    const execId = 'exec_' + '9'.repeat(32);
    const records: ShadowExecutionRecord[] = [
      {
        receipt: buildReceipt({ classifications: ['EXACT'], executionId: execId }),
        platform: 'win-x64',
        executedAt: now,
      },
      {
        receipt: buildReceipt({ classifications: ['SAFETY_REGRESSION'], executionId: execId }),
        platform: 'linux-x64',
        executedAt: now,
      },
    ];
    const report = generateR2ExitReport(records, { clock: () => now });
    const markdown = renderR2ExitReportMarkdown(report);
    assert.ok(markdown.includes('### Inconsistencies'));
    assert.ok(markdown.includes('Hash mismatch'));
  });

  it('includes blockers when present', () => {
    const records = [buildRecord({ classifications: ['SAFETY_REGRESSION'] })];
    const report = generateR2ExitReport(records, { clock: () => now });
    const markdown = renderR2ExitReportMarkdown(report);
    assert.ok(markdown.includes('### Blockers'));
    assert.ok(markdown.includes('SAFETY_REGRESSION'));
  });
});

// ─── End-to-End ─────────────────────────────────────────────────────

describe('R2 Exit Report — End-to-End', () => {
  it('generates a complete report with schema version', () => {
    const records = [buildRecord({ classifications: ['EXACT'] })];
    const report = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report.schema, 'awkn-r2-exit-report/v1');
    assert.ok(report.reportId.startsWith('sdiff_'));
    assert.equal(report.generatedAt, now);
    assert.equal(report.recordCount, records.length);
  });

  it('respects custom thresholds', () => {
    const records: ShadowExecutionRecord[] = [];
    for (let i = 0; i < 5; i++) {
      records.push(buildRecord({ classifications: ['EXACT'] }));
    }
    // Custom threshold: minSampleSize=3 → 5 samples is enough for GO
    const report = generateR2ExitReport(records, {
      clock: () => now,
      thresholds: { minSampleSize: 3 },
    });
    assert.equal(report.decision, 'GO');
  });

  it('determinism: same records produce same decision', () => {
    const records = [
      buildRecord({ classifications: ['EXACT'] }),
      buildRecord({ classifications: ['EXPECTED_IMPROVEMENT'] }),
    ];
    const report1 = generateR2ExitReport(records, { clock: () => now });
    const report2 = generateR2ExitReport(records, { clock: () => now });
    assert.equal(report1.decision, report2.decision);
    assert.deepEqual(report1.statistics.verdictDistribution, report2.statistics.verdictDistribution);
  });
});
