/**
 * R2 Exit Report Generator (R2 Shadow Integration Phase 4f)
 *
 * 聚合 ShadowDiffReceipts，生成 R2 Exit Report，为 Issue #43 (R2 Exit Decision) 提供证据。
 *
 * 报告包含：
 * 1. Shadow Diff 统计（总执行数、verdict 分布、classification 分布）
 * 2. 跨平台 Hash 一致性验证（确定性检查）
 * 3. Exit Decision（GO / NO_GO / CONDITIONAL_GO）
 * 4. Issue #43 决策证据
 *
 * 决策规则（fail-closed，保守）：
 * - 任何 SAFETY_REGRESSION 或 CORRECTNESS_REGRESSION → NO_GO
 * - BLOCKING verdict 占比 > 20% → NO_GO
 * - 总执行数 < 10 → CONDITIONAL_GO（样本不足）
 * - 跨平台 Hash 不一致 → NO_GO
 * - 否则 → GO
 */

import { createAwknId } from '../contracts/ids.js';
import { stableHash } from '../contracts/canonical-json.js';
import type { JsonValue } from '../contracts/json-value.js';
import type {
  ShadowDiffReceipt,
  ShadowDiffClassification,
  ShadowDiffVerdict,
  ShadowDiffSummary,
} from './shadow-diff-receipt.js';

/** Exit Decision 枚举 */
export type R2ExitDecision = 'GO' | 'NO_GO' | 'CONDITIONAL_GO';

/** 单次 Shadow Execution 记录 */
export interface ShadowExecutionRecord {
  readonly receipt: ShadowDiffReceipt;
  /** 执行平台（如 'linux-x64', 'win-x64', 'darwin-arm64'） */
  readonly platform: string;
  /** 执行时间戳（ISO 8601 UTC） */
  readonly executedAt: string;
}

/** R2 Exit Report */
export interface R2ExitReport {
  /** 报告 schema */
  readonly schema: 'awkn-r2-exit-report/v1';
  /** 报告 ID */
  readonly reportId: string;
  /** 生成时间 */
  readonly generatedAt: string;
  /** 统计汇总 */
  readonly statistics: R2ExitStatistics;
  /** 跨平台 Hash 验证结果 */
  readonly hashVerification: HashVerificationResult;
  /** Exit Decision */
  readonly decision: R2ExitDecision;
  /** Decision 原因码 */
  readonly decisionReasons: readonly string[];
  /** Issue #43 决策证据 */
  readonly issue43Evidence: Issue43Evidence;
  /** 原始记录引用 */
  readonly recordCount: number;
}

/** 统计汇总 */
export interface R2ExitStatistics {
  /** 总执行数 */
  readonly totalExecutions: number;
  /** Verdict 分布 */
  readonly verdictDistribution: Readonly<Record<ShadowDiffVerdict, number>>;
  /** Classification 分布 */
  readonly classificationDistribution: Readonly<Record<ShadowDiffClassification, number>>;
  /** 总 comparison 数 */
  readonly totalComparisons: number;
  /** BLOCKING 占比 */
  readonly blockingRatio: number;
  /** SAFETY_REGRESSION 数 */
  readonly safetyRegressionCount: number;
  /** CORRECTNESS_REGRESSION 数 */
  readonly correctnessRegressionCount: number;
  /** 涉及的平台列表 */
  readonly platforms: readonly string[];
}

/** Hash 验证结果 */
export interface HashVerificationResult {
  /** 是否一致 */
  readonly consistent: boolean;
  /** 检查的 receipt 数 */
  readonly checkedReceipts: number;
  /** 不一致的 receipt 数 */
  readonly inconsistentReceipts: number;
  /** 不一致详情 */
  readonly inconsistencies: readonly HashInconsistency[];
}

/** Hash 不一致详情 */
export interface HashInconsistency {
  readonly executionId: string;
  readonly traceId: string;
  readonly platforms: readonly string[];
  readonly reason: string;
}

/** Issue #43 决策证据 */
export interface Issue43Evidence {
  /** R2 组件是否就绪 */
  readonly r2ComponentsReady: boolean;
  /** Shadow Integration 是否通过 */
  readonly shadowIntegrationPassed: boolean;
  /** 跨平台一致性是否通过 */
  readonly crossPlatformConsistent: boolean;
  /** 阻塞原因（如果有） */
  readonly blockers: readonly string[];
  /** 建议的下一步 */
  readonly recommendedNextSteps: readonly string[];
}

/** 默认决策阈值 */
export const DEFAULT_THRESHOLDS = {
  /** 最小样本数（低于此值返回 CONDITIONAL_GO） */
  minSampleSize: 10,
  /** BLOCKING 占比阈值（超过返回 NO_GO） */
  maxBlockingRatio: 0.2,
} as const;

/** 计算单次 receipt 的稳定 hash（用于跨平台一致性检查） */
function receiptContentHash(receipt: ShadowDiffReceipt): string {
  // 排除 diffId 和 createdAt（这些是每次执行唯一的，不应参与一致性比较）
  // 只比较 comparisons、summary、overallVerdict
  const comparable: JsonValue = {
    schema: receipt.schema,
    executionId: receipt.executionId,
    traceId: receipt.traceId,
    comparisons: receipt.comparisons,
    summary: receipt.summary,
    overallVerdict: receipt.overallVerdict,
  };
  return stableHash('awkn-shadow-diff-receipt-content/v1', comparable);
}

/** 按 (executionId, traceId) 分组检查跨平台一致性 */
function verifyCrossPlatformHash(
  records: readonly ShadowExecutionRecord[],
): HashVerificationResult {
  const groups = new Map<string, ShadowExecutionRecord[]>();
  for (const record of records) {
    const key = `${record.receipt.executionId}:${record.receipt.traceId}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const inconsistencies: HashInconsistency[] = [];
  let checkedReceipts = 0;

  for (const [, group] of groups) {
    // 只有当同一 (executionId, traceId) 在 >= 2 个不同平台上有记录时，才做跨平台比较
    const uniquePlatforms = new Set(group.map((r) => r.platform));
    if (uniquePlatforms.size < 2) continue;
    checkedReceipts += group.length;

    const platforms = group.map((r) => r.platform);
    const hashes = group.map((r) => receiptContentHash(r.receipt));
    const uniqueHashes = new Set(hashes);

    if (uniqueHashes.size > 1) {
      inconsistencies.push({
        executionId: group[0]!.receipt.executionId,
        traceId: group[0]!.receipt.traceId,
        platforms,
        reason: `Hash mismatch across platforms: ${[...uniqueHashes].join(', ')}`,
      });
    }
  }

  return {
    consistent: inconsistencies.length === 0,
    checkedReceipts,
    inconsistentReceipts: inconsistencies.length,
    inconsistencies,
  };
}

/** 计算统计汇总 */
function computeStatistics(records: readonly ShadowExecutionRecord[]): R2ExitStatistics {
  const verdictDist: Record<ShadowDiffVerdict, number> = {
    MATCH: 0,
    ACCEPTABLE: 0,
    BLOCKING: 0,
  };
  const classificationDist: Record<ShadowDiffClassification, number> = {
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

  let totalComparisons = 0;
  const platformSet = new Set<string>();

  for (const record of records) {
    verdictDist[record.receipt.overallVerdict]++;
    platformSet.add(record.platform);

    const summary = record.receipt.summary;
    totalComparisons += summary.total;
    for (const key of Object.keys(classificationDist) as ShadowDiffClassification[]) {
      classificationDist[key] += summaryKeyToCount(summary, key);
    }
  }

  const total = records.length;
  const blockingRatio = total > 0 ? verdictDist.BLOCKING / total : 0;

  return {
    totalExecutions: total,
    verdictDistribution: verdictDist,
    classificationDistribution: classificationDist,
    totalComparisons,
    blockingRatio,
    safetyRegressionCount: classificationDist.SAFETY_REGRESSION,
    correctnessRegressionCount: classificationDist.CORRECTNESS_REGRESSION,
    platforms: [...platformSet].sort(),
  };
}

function summaryKeyToCount(summary: ShadowDiffSummary, key: ShadowDiffClassification): number {
  switch (key) {
    case 'EXACT': return summary.exact;
    case 'SEMANTIC_EQUIVALENT': return summary.semanticEquivalent;
    case 'EXPECTED_IMPROVEMENT': return summary.expectedImprovement;
    case 'ACCEPTABLE_DIVERGENCE': return summary.acceptableDivergence;
    case 'MISSING_IN_LEGACY': return summary.missingInLegacy;
    case 'MISSING_IN_R2': return summary.missingInR2;
    case 'SAFETY_REGRESSION': return summary.safetyRegression;
    case 'CORRECTNESS_REGRESSION': return summary.correctnessRegression;
    case 'UNKNOWN': return summary.unknown;
  }
}

/** 计算 Exit Decision */
function computeDecision(
  statistics: R2ExitStatistics,
  hashVerification: HashVerificationResult,
  thresholds: typeof DEFAULT_THRESHOLDS,
): { decision: R2ExitDecision; reasons: string[] } {
  const reasons: string[] = [];

  // Rule 1: 跨平台 Hash 不一致 → NO_GO
  if (!hashVerification.consistent) {
    reasons.push(
      `CROSS_PLATFORM_HASH_INCONSISTENT: ${hashVerification.inconsistentReceipts} receipts have hash mismatches across platforms`,
    );
    return { decision: 'NO_GO', reasons };
  }

  // Rule 2: 任何 SAFETY_REGRESSION → NO_GO
  if (statistics.safetyRegressionCount > 0) {
    reasons.push(
      `SAFETY_REGRESSION_DETECTED: ${statistics.safetyRegressionCount} safety regressions found`,
    );
    return { decision: 'NO_GO', reasons };
  }

  // Rule 3: 任何 CORRECTNESS_REGRESSION → NO_GO
  if (statistics.correctnessRegressionCount > 0) {
    reasons.push(
      `CORRECTNESS_REGRESSION_DETECTED: ${statistics.correctnessRegressionCount} correctness regressions found`,
    );
    return { decision: 'NO_GO', reasons };
  }

  // Rule 4: BLOCKING 占比 > 阈值 → NO_GO
  if (statistics.blockingRatio > thresholds.maxBlockingRatio) {
    reasons.push(
      `BLOCKING_RATIO_EXCEEDED: ${(statistics.blockingRatio * 100).toFixed(1)}% > ${(thresholds.maxBlockingRatio * 100)}% threshold`,
    );
    return { decision: 'NO_GO', reasons };
  }

  // Rule 5: 样本不足 → CONDITIONAL_GO
  if (statistics.totalExecutions < thresholds.minSampleSize) {
    reasons.push(
      `INSUFFICIENT_SAMPLES: ${statistics.totalExecutions} < ${thresholds.minSampleSize} minimum samples`,
    );
    return { decision: 'CONDITIONAL_GO', reasons };
  }

  // Rule 6: 全部通过 → GO
  reasons.push(
    `ALL_CHECKS_PASSED: ${statistics.totalExecutions} executions, ${statistics.verdictDistribution.MATCH} MATCH, ${statistics.verdictDistribution.ACCEPTABLE} ACCEPTABLE, ${statistics.verdictDistribution.BLOCKING} BLOCKING`,
  );
  return { decision: 'GO', reasons };
}

/** 生成 Issue #43 决策证据 */
function buildIssue43Evidence(
  statistics: R2ExitStatistics,
  hashVerification: HashVerificationResult,
  decision: R2ExitDecision,
): Issue43Evidence {
  const blockers: string[] = [];
  const nextSteps: string[] = [];

  const r2ComponentsReady = statistics.totalExecutions > 0;
  const shadowIntegrationPassed = decision !== 'NO_GO';
  const crossPlatformConsistent = hashVerification.consistent;

  if (!r2ComponentsReady) {
    blockers.push('R2 components have not been executed (zero shadow runs)');
  }
  if (!shadowIntegrationPassed) {
    blockers.push(`Shadow Integration failed with decision: ${decision}`);
  }
  if (!crossPlatformConsistent) {
    blockers.push('Cross-platform hash verification failed');
  }
  if (statistics.safetyRegressionCount > 0) {
    blockers.push(`${statistics.safetyRegressionCount} SAFETY_REGRESSION(s) detected`);
  }
  if (statistics.correctnessRegressionCount > 0) {
    blockers.push(`${statistics.correctnessRegressionCount} CORRECTNESS_REGRESSION(s) detected`);
  }

  if (decision === 'GO') {
    nextSteps.push('Promote feature flags from shadow to enforce for WP02 (InputGateway)');
    nextSteps.push('Begin Policy/Skill Compiler, Broker, and Evidence-Gain Loop (Phase 6)');
    nextSteps.push('Monitor enforce mode for 72h before expanding to WP03-05');
  } else if (decision === 'CONDITIONAL_GO') {
    nextSteps.push(`Collect more shadow samples (current: ${statistics.totalExecutions}, need: ${DEFAULT_THRESHOLDS.minSampleSize})`);
    nextSteps.push('Run shadow integration on additional platforms (Linux, macOS)');
    nextSteps.push('Re-generate exit report after collecting sufficient samples');
  } else {
    nextSteps.push('Do NOT promote to enforce mode');
    nextSteps.push('Investigate BLOCKING receipts and fix root causes');
    nextSteps.push('Re-run shadow integration after fixes');
  }

  return {
    r2ComponentsReady,
    shadowIntegrationPassed,
    crossPlatformConsistent,
    blockers,
    recommendedNextSteps: nextSteps,
  };
}

/** 生成 R2 Exit Report */
export function generateR2ExitReport(
  records: readonly ShadowExecutionRecord[],
  options: {
    readonly clock?: () => string;
    readonly thresholds?: Partial<typeof DEFAULT_THRESHOLDS>;
  } = {},
): R2ExitReport {
  const clock = options.clock ?? (() => new Date().toISOString());
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };

  const statistics = computeStatistics(records);
  const hashVerification = verifyCrossPlatformHash(records);
  const { decision, reasons } = computeDecision(statistics, hashVerification, thresholds);
  const issue43Evidence = buildIssue43Evidence(statistics, hashVerification, decision);

  return {
    schema: 'awkn-r2-exit-report/v1',
    reportId: createAwknId('shadowDiff'), // 复用 sdiff 前缀（report 本身是 shadow 产物）
    generatedAt: clock(),
    statistics,
    hashVerification,
    decision,
    decisionReasons: reasons,
    issue43Evidence,
    recordCount: records.length,
  };
}

/** 将 R2 Exit Report 转换为 Markdown 文档 */
export function renderR2ExitReportMarkdown(report: R2ExitReport): string {
  const lines: string[] = [];
  const stats = report.statistics;

  lines.push('# R2 Exit Report');
  lines.push('');
  lines.push(`**Report ID:** ${report.reportId}`);
  lines.push(`**Generated At:** ${report.generatedAt}`);
  lines.push(`**Decision:** ${report.decision}`);
  lines.push('');

  // Decision Reasons
  lines.push('## Decision Reasons');
  lines.push('');
  for (const reason of report.decisionReasons) {
    lines.push(`- ${reason}`);
  }
  lines.push('');

  // Statistics
  lines.push('## Shadow Diff Statistics');
  lines.push('');
  lines.push(`- **Total Executions:** ${stats.totalExecutions}`);
  lines.push(`- **Total Comparisons:** ${stats.totalComparisons}`);
  lines.push(`- **Platforms:** ${stats.platforms.join(', ') || 'N/A'}`);
  lines.push(`- **BLOCKING Ratio:** ${(stats.blockingRatio * 100).toFixed(1)}%`);
  lines.push('');

  lines.push('### Verdict Distribution');
  lines.push('');
  lines.push('| Verdict | Count |');
  lines.push('|---------|-------|');
  for (const verdict of ['MATCH', 'ACCEPTABLE', 'BLOCKING'] as const) {
    lines.push(`| ${verdict} | ${stats.verdictDistribution[verdict]} |`);
  }
  lines.push('');

  lines.push('### Classification Distribution');
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('|----------------|-------|');
  for (const cls of [
    'EXACT', 'SEMANTIC_EQUIVALENT', 'EXPECTED_IMPROVEMENT', 'ACCEPTABLE_DIVERGENCE',
    'MISSING_IN_LEGACY', 'MISSING_IN_R2', 'SAFETY_REGRESSION', 'CORRECTNESS_REGRESSION', 'UNKNOWN',
  ] as const) {
    lines.push(`| ${cls} | ${stats.classificationDistribution[cls]} |`);
  }
  lines.push('');

  // Hash Verification
  lines.push('## Cross-Platform Hash Verification');
  lines.push('');
  lines.push(`- **Consistent:** ${report.hashVerification.consistent ? 'YES' : 'NO'}`);
  lines.push(`- **Checked Receipts:** ${report.hashVerification.checkedReceipts}`);
  lines.push(`- **Inconsistent Receipts:** ${report.hashVerification.inconsistentReceipts}`);
  lines.push('');
  if (report.hashVerification.inconsistencies.length > 0) {
    lines.push('### Inconsistencies');
    lines.push('');
    for (const inc of report.hashVerification.inconsistencies) {
      lines.push(`- **Execution:** ${inc.executionId}`);
      lines.push(`  - **Platforms:** ${inc.platforms.join(', ')}`);
      lines.push(`  - **Reason:** ${inc.reason}`);
    }
    lines.push('');
  }

  // Issue #43 Evidence
  lines.push('## Issue #43 Decision Evidence');
  lines.push('');
  const ev = report.issue43Evidence;
  lines.push(`- **R2 Components Ready:** ${ev.r2ComponentsReady ? 'YES' : 'NO'}`);
  lines.push(`- **Shadow Integration Passed:** ${ev.shadowIntegrationPassed ? 'YES' : 'NO'}`);
  lines.push(`- **Cross-Platform Consistent:** ${ev.crossPlatformConsistent ? 'YES' : 'NO'}`);
  lines.push('');

  if (ev.blockers.length > 0) {
    lines.push('### Blockers');
    lines.push('');
    for (const blocker of ev.blockers) {
      lines.push(`- ${blocker}`);
    }
    lines.push('');
  }

  lines.push('### Recommended Next Steps');
  lines.push('');
  for (const step of ev.recommendedNextSteps) {
    lines.push(`- ${step}`);
  }
  lines.push('');

  return lines.join('\n');
}
