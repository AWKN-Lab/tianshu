import {
  REVIEW_FINDING_SCHEMA,
  ReviewFindingSchema,
  deterministicReviewId,
  stableHash,
  type ActorRef,
  type ReviewFinding,
  type ReviewPlan,
  type ReviewUnit,
} from '../../contracts/public.js';
import type { ReviewFindingDraft } from '../ports/outbound/reviewer-port.js';
import type { ReviewArtifactBundle } from '../ports/outbound/review-workspace-port.js';

export interface FindingValidationResult {
  readonly findings: readonly ReviewFinding[];
  readonly errors: readonly string[];
  /** 因低置信度被抑制的 Finding 数量 */
  readonly suppressed: number;
  /** 因邻近合并而折叠的 Finding 数量 */
  readonly merged: number;
}

/** Finding 规范化策略（P0-2：去噪）。 */
export interface FindingNormalizationOptions {
  /** 邻近合并的最大行距（含），默认 20 行 */
  readonly mergeDistance?: number;
  /** 低置信度抑制阈值；HIGH/CRITICAL 始终保留（已验证），默认 0.35 */
  readonly confidenceThreshold?: number;
}

const DEFAULT_MERGE_DISTANCE = 20;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.35;
const SEVERITY_RANK: Record<ReviewFinding['severity'], number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
};

function mergeFindings(primary: ReviewFinding, adjacent: readonly ReviewFinding[]): ReviewFinding {
  const merged = adjacent.reduce<{ startLine: number; endLine: number; severity: ReviewFinding['severity'] }>(
    (acc, finding) => ({
      startLine: Math.min(acc.startLine, finding.startLine),
      endLine: Math.max(acc.endLine, finding.endLine),
      severity: SEVERITY_RANK[finding.severity] > SEVERITY_RANK[acc.severity] ? finding.severity : acc.severity,
    }),
    { startLine: primary.startLine, endLine: primary.endLine, severity: primary.severity },
  );
  const evidenceRefs = [...new Set([...primary.evidenceRefs, ...adjacent.flatMap((finding) => finding.evidenceRefs)])].sort();
  const ruleRefs = sortedUniqueBy(primary.ruleRefs.concat(adjacent.flatMap((finding) => finding.ruleRefs)), (ref) => ref.objectId);
  const specRefs = sortedUniqueBy(primary.specRefs.concat(adjacent.flatMap((finding) => finding.specRefs)), (ref) => ref.objectId);
  const verifiedBy = sortedUniqueBy(primary.verifiedBy.concat(adjacent.flatMap((finding) => finding.verifiedBy)), (actor) => actor.actorId);
  const fingerprint = stableHash(REVIEW_FINDING_SCHEMA, {
    unitId: primary.unitId,
    axis: primary.axis,
    category: primary.category,
    severity: merged.severity,
    path: primary.path,
    startLine: merged.startLine,
    endLine: merged.endLine,
    message: primary.message,
    impact: primary.impact,
    ruleRefs,
    specRefs,
    evidenceRefs,
  });
  return {
    ...primary,
    findingId: deterministicReviewId('rfnd', fingerprint),
    fingerprint,
    startLine: merged.startLine,
    endLine: merged.endLine,
    severity: merged.severity,
    confidence: Math.max(primary.confidence, ...adjacent.map((finding) => finding.confidence)),
    ruleRefs,
    specRefs,
    evidenceRefs,
    verifiedBy,
    rationaleSummary: `${primary.rationaleSummary} (merged with ${adjacent.length} adjacent finding${adjacent.length > 1 ? 's' : ''})`,
  };
}

function sortedUniqueBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique.sort((left, right) => (keyOf(left) < keyOf(right) ? -1 : keyOf(left) > keyOf(right) ? 1 : 0));
}

/**
 * 对已验证的 Findings 做噪声抑制（P0-2）：
 * 1. 指纹完全相同的重复项（validator 已按 fingerprint 去重）；
 * 2. 同 unit、同文件、同轴、同类别、行距在 mergeDistance 内的邻近问题合并为一条；
 * 3. confidence 低于阈值且非 HIGH/CRITICAL 的发现被抑制。
 * 返回抑制/合并计数，便于审计去噪影响。
 */
export function normalizeFindings(
  findings: readonly ReviewFinding[],
  options: FindingNormalizationOptions = {},
): { readonly findings: readonly ReviewFinding[]; readonly suppressed: number; readonly merged: number } {
  const mergeDistance = options.mergeDistance ?? DEFAULT_MERGE_DISTANCE;
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const ordered = [...findings].sort((left, right) => {
    const leftKeys = [left.unitId, left.path, left.axis, left.category, String(left.startLine).padStart(10, '0')];
    const rightKeys = [right.unitId, right.path, right.axis, right.category, String(right.startLine).padStart(10, '0')];
    for (let index = 0; index < leftKeys.length; index++) {
      if (leftKeys[index]! < rightKeys[index]!) return -1;
      if (leftKeys[index]! > rightKeys[index]!) return 1;
    }
    return 0;
  });
  let suppressed = 0;
  let merged = 0;
  const output: ReviewFinding[] = [];

  for (const finding of ordered) {
    if (SEVERITY_RANK[finding.severity] < 3 && finding.confidence < confidenceThreshold) {
      suppressed++;
      continue;
    }
    const last = output.at(-1);
    if (last !== undefined
      && last.unitId === finding.unitId
      && last.path === finding.path
      && last.axis === finding.axis
      && last.category === finding.category
      && finding.startLine - last.endLine <= mergeDistance
      && finding.endLine - last.startLine <= 10_000) {
      const mergedFinding = mergeFindings(last, [finding]);
      output[output.length - 1] = mergedFinding;
      merged++;
      continue;
    }
    output.push(finding);
  }

  return { findings: output, suppressed, merged };
}

function computeFindingFingerprint(unit: ReviewUnit, draft: ReviewFindingDraft): string {
  return stableHash(REVIEW_FINDING_SCHEMA, {
    unitId: unit.unitId,
    axis: draft.axis,
    category: draft.category,
    severity: draft.severity,
    path: draft.path,
    startLine: draft.startLine,
    endLine: draft.endLine,
    message: draft.message,
    impact: draft.impact,
    ruleRefs: draft.ruleRefs,
    specRefs: draft.specRefs,
    evidenceRefs: draft.evidenceRefs,
  });
}

function visibleLineNumbers(patch: string, side: 'OLD' | 'NEW'): Set<number> {
  const visible = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let insideHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      insideHunk = true;
      continue;
    }
    if (!insideHunk || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (side === 'NEW') visible.add(newLine);
      newLine++;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      if (side === 'OLD') visible.add(oldLine);
      oldLine++;
      continue;
    }
    if (line.startsWith(' ')) {
      visible.add(side === 'OLD' ? oldLine : newLine);
      oldLine++;
      newLine++;
      continue;
    }
    insideHunk = false;
  }
  return visible;
}

export function validateFindingDrafts(
  plan: ReviewPlan,
  unit: ReviewUnit,
  reviewer: ActorRef,
  drafts: readonly ReviewFindingDraft[],
  artifacts: ReviewArtifactBundle,
  allowedEvidenceRefs: ReadonlySet<string>,
  options: FindingNormalizationOptions = {},
): FindingValidationResult {
  const reviewablePaths = new Set(plan.files.filter((file) => file.willReview).map((file) => file.path));
  const errors: string[] = [];
  const findings = new Map<string, ReviewFinding>();

  for (const [index, draft] of drafts.entries()) {
    if (!unit.paths.includes(draft.path)) {
      errors.push(`finding[${index}] path ${draft.path} is outside unit ${unit.unitId}`);
      continue;
    }
    if (!reviewablePaths.has(draft.path)) {
      errors.push(`finding[${index}] path ${draft.path} is not reviewable in frozen plan`);
      continue;
    }
    if (draft.positionStatus === 'UNRESOLVED') {
      errors.push(`finding[${index}] has unresolved position`);
      continue;
    }
    if (!Number.isSafeInteger(draft.startLine) || !Number.isSafeInteger(draft.endLine)
      || draft.startLine < 1 || draft.endLine < draft.startLine || draft.endLine - draft.startLine > 10_000) {
      errors.push(`finding[${index}] has an invalid or excessive line range`);
      continue;
    }
    const artifact = artifacts.files.find((candidate) => candidate.path === draft.path);
    if (artifact === undefined) {
      errors.push(`finding[${index}] has no frozen artifact for ${draft.path}`);
      continue;
    }
    const plannedFile = plan.files.find((file) => file.path === draft.path)!;
    const visibleLines = visibleLineNumbers(artifact.patch, plannedFile.status === 'DELETED' ? 'OLD' : 'NEW');
    let fullRangeVisible = visibleLines.size > 0;
    for (let line = draft.startLine; line <= draft.endLine && fullRangeVisible; line++) {
      fullRangeVisible = visibleLines.has(line);
    }
    if (!fullRangeVisible) {
      errors.push(`finding[${index}] position ${draft.path}:${draft.startLine}-${draft.endLine} is not visible in frozen diff`);
      continue;
    }
    if (draft.evidenceRefs.some((evidenceRef) => !allowedEvidenceRefs.has(evidenceRef))) {
      errors.push(`finding[${index}] references evidence outside the frozen execution`);
      continue;
    }

    const fingerprint = computeFindingFingerprint(unit, draft);
    const parsed = ReviewFindingSchema.safeParse({
      schema: REVIEW_FINDING_SCHEMA,
      findingId: deterministicReviewId('rfnd', fingerprint),
      unitId: unit.unitId,
      fingerprint,
      axis: draft.axis,
      category: draft.category,
      severity: draft.severity,
      confidence: draft.confidence,
      path: draft.path,
      startLine: draft.startLine,
      endLine: draft.endLine,
      positionStatus: draft.positionStatus,
      message: draft.message,
      impact: draft.impact,
      suggestedFix: draft.suggestedFix,
      rationaleSummary: draft.rationaleSummary,
      ruleRefs: draft.ruleRefs,
      specRefs: draft.specRefs,
      evidenceRefs: draft.evidenceRefs,
      producer: reviewer,
      verifiedBy: draft.verifiedBy ?? [],
      verificationKind: draft.verificationKind ?? 'NONE',
      disposition: 'OPEN',
    });
    if (!parsed.success) {
      errors.push(`finding[${index}] invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      continue;
    }
    findings.set(fingerprint, parsed.data);
  }

  const normalized = normalizeFindings([...findings.values()], options);
  return {
    findings: normalized.findings,
    errors,
    suppressed: normalized.suppressed,
    merged: normalized.merged,
  };
}
