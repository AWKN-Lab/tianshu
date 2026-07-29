import {
  REVIEW_COVERAGE_SCHEMA,
  ReviewCoverageSchema,
  type ReviewCoverage,
  type ReviewPlan,
  type ReviewRun,
  type ReviewRisk,
} from '../../contracts/public.js';

const RISK_WEIGHT: Readonly<Record<ReviewRisk, number>> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function calculateReviewCoverage(plan: ReviewPlan, run: ReviewRun): ReviewCoverage {
  const results = new Map(run.unitResults.map((result) => [result.unitId, result]));
  const reviewable = plan.files.filter((file) => file.willReview).map((file) => file.path);
  const excluded = plan.files.filter((file) => !file.willReview).map((file) => file.path);
  const completedFileUnits = new Set(
    plan.units
      .filter((unit) => unit.type === 'FILE' && results.get(unit.unitId)?.status === 'COMPLETED')
      .flatMap((unit) => unit.paths),
  );
  const failedUnits = plan.units.filter((unit) => {
    const status = results.get(unit.unitId)?.status;
    return status === 'FAILED' || status === 'SKIPPED';
  });
  const failedFileUnits = failedUnits.filter((unit) => unit.type === 'FILE');
  const failedFiles = sorted(failedFileUnits.flatMap((unit) => unit.paths));
  const failedFileSet = new Set(failedFiles);
  const reviewedFiles = sorted(reviewable.filter((path) => completedFileUnits.has(path) && !failedFileSet.has(path)));
  const missing = [
    ...reviewable
      .filter((path) => !completedFileUnits.has(path))
      .map((path) => ({ path, reason: 'required FILE review unit did not complete' })),
    ...plan.units
      .filter((unit) => !results.has(unit.unitId))
      .map((unit) => ({ unitId: unit.unitId, reason: 'planned review unit has no result' })),
    ...failedUnits.map((unit) => ({ unitId: unit.unitId, reason: 'review unit failed or was skipped' })),
  ];

  const totalRisk = plan.units.reduce((sum, unit) => sum + RISK_WEIGHT[unit.risk], 0);
  const coveredRisk = plan.units.reduce((sum, unit) =>
    sum + (results.get(unit.unitId)?.status === 'COMPLETED' ? RISK_WEIGHT[unit.risk] : 0), 0);
  const coverage = {
    schema: REVIEW_COVERAGE_SCHEMA,
    plannedFiles: sorted(reviewable),
    reviewedFiles,
    excludedFiles: sorted(excluded),
    failedFiles,
    plannedUnits: plan.units.length,
    completedUnits: plan.units.filter((unit) => results.get(unit.unitId)?.status === 'COMPLETED').length,
    failedUnits: failedUnits.length,
    fileCoverage: reviewable.length === 0 ? 0 : reviewedFiles.length / reviewable.length,
    riskCoverage: totalRisk === 0 ? 0 : coveredRisk / totalRisk,
    missing,
  };
  return ReviewCoverageSchema.parse(coverage);
}
