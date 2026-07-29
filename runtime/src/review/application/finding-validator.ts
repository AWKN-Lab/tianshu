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

  return { findings: [...findings.values()], errors };
}
