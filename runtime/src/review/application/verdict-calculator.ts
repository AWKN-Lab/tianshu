import {
  REVIEW_VERDICT_SCHEMA,
  ReviewVerdictSchema,
  type ReviewCoverage,
  type ReviewFinding,
  type ReviewRun,
  type ReviewVerdict,
  type ReviewVerdictReason,
} from '../../contracts/public.js';

export function calculateReviewVerdict(
  run: ReviewRun,
  coverage: ReviewCoverage,
  evaluatedAt: string,
): ReviewVerdict {
  const reasons: ReviewVerdictReason[] = [];
  const blocking = run.findings.filter((finding) =>
    (finding.severity === 'CRITICAL' || finding.severity === 'HIGH')
    && finding.disposition === 'OPEN');

  if (run.currentTargetFingerprint !== run.plan.target.diffFingerprint) reasons.push('TARGET_STALE');
  if (run.providerStatus === 'INVALID') reasons.push('PROVIDER_INVALID');
  if (run.validationErrors.length > 0
    || run.findings.some((finding) => finding.positionStatus === 'UNRESOLVED')) reasons.push('FINDING_INVALID');
  if (run.unitResults.some((result) => result.status !== 'COMPLETED')) reasons.push('UNIT_FAILED');
  if (coverage.fileCoverage < 1) reasons.push('FILE_COVERAGE_INCOMPLETE');
  if (coverage.riskCoverage < 1) reasons.push('RISK_COVERAGE_INCOMPLETE');
  if (blocking.length > 0) reasons.push('BLOCKING_FINDING');

  const implementer = run.plan.target.implementer?.actorId;
  if (implementer !== undefined && run.unitResults.some((result) => result.reviewer.actorId === implementer)) {
    reasons.push('REVIEWER_NOT_INDEPENDENT');
  }

  const hasContractInputs = run.plan.target.prdRefs.length
    + run.plan.target.specRefs.length
    + run.plan.target.acceptanceCriteriaRefs.length > 0;
  const specUnits = run.plan.units.filter((unit) => unit.type === 'SPEC');
  const specEvidenceComplete = specUnits.length > 0 && specUnits.every((unit) => {
    const result = run.unitResults.find((candidate) => candidate.unitId === unit.unitId);
    return result?.status === 'COMPLETED' && result.evidenceRefs.length > 0;
  });
  if (hasContractInputs && !specEvidenceComplete) reasons.push('CONTRACT_EVIDENCE_MISSING');

  const uniqueReasons = [...new Set(reasons)];
  let status: ReviewVerdict['status'];
  if (uniqueReasons.includes('TARGET_STALE')) status = 'STALE';
  else if (uniqueReasons.some((reason) => reason === 'FINDING_INVALID' || reason === 'REVIEWER_NOT_INDEPENDENT')) status = 'INVALID';
  else if (uniqueReasons.some((reason) =>
    reason === 'PROVIDER_INVALID'
    || reason === 'UNIT_FAILED'
    || reason === 'FILE_COVERAGE_INCOMPLETE'
    || reason === 'RISK_COVERAGE_INCOMPLETE')) status = 'PARTIAL';
  else if (uniqueReasons.length > 0) status = 'FAIL';
  else status = 'PASS';

  return ReviewVerdictSchema.parse({
    schema: REVIEW_VERDICT_SCHEMA,
    status,
    reasonCodes: status === 'PASS' ? ['OK'] : uniqueReasons,
    blockerFindingIds: blocking.map((finding: ReviewFinding) => finding.findingId),
    coverage,
    evaluatedAt,
  });
}
