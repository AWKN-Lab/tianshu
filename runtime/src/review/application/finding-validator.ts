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

export function validateFindingDrafts(
  plan: ReviewPlan,
  unit: ReviewUnit,
  reviewer: ActorRef,
  drafts: readonly ReviewFindingDraft[],
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
