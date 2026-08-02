import { z } from 'zod';
import { ActorRefSchema, ObjectRefSchema } from './actors.js';
import { stableHash } from './canonical-json.js';
import { awknIdSchema } from './ids.js';
import { SafeNonNegativeIntegerSchema, SafePositiveIntegerSchema } from './numbers.js';
import { ReceiptEnvelopeSchema, receiptPayloadHash, type ReceiptEnvelope } from './receipts.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const REPOSITORY_RELATIVE_PATH_PATTERN = /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/;

export const OCR_DELEGATE_SPEC_SCHEMA = 'ocr-delegate-spec/v1';
export const REVIEW_TARGET_SCHEMA = 'awkn-review-target/v1';
export const REVIEW_SCOPE_SPEC_SCHEMA = 'awkn-review-scope-spec/v1';
export const REVIEW_PLAN_SCHEMA = 'awkn-review-plan/v1';
export const REVIEW_RUN_SCHEMA = 'awkn-review-run/v1';
export const REVIEW_FINDING_SCHEMA = 'awkn-review-finding/v1';
export const REVIEW_COVERAGE_SCHEMA = 'awkn-review-coverage/v1';
export const REVIEW_VERDICT_SCHEMA = 'awkn-review-verdict/v1';
export const REVIEW_RECEIPT_SCHEMA = 'awkn-review-receipt/v1';
export const REVIEW_SHADOW_DIFF_SCHEMA = 'awkn-review-shadow-diff/v1';

export const Sha256Schema = z.string().regex(SHA256_HEX_PATTERN, 'invalid sha256 hash');
export const PrefixedSha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'invalid prefixed sha256 hash');
export const GitOidSchema = z.string().regex(/^[0-9a-f]{40}$/, 'invalid git oid');
export const RepositoryRelativePathSchema = z.string().min(1).regex(
  REPOSITORY_RELATIVE_PATH_PATTERN,
  'path must be a repository-relative POSIX path without parent traversal',
);

export const ReviewFileStatusSchema = z.enum([
  'ADDED',
  'MODIFIED',
  'DELETED',
  'RENAMED',
  'COPIED',
  'BINARY',
]);
export type ReviewFileStatus = z.infer<typeof ReviewFileStatusSchema>;

export const ReviewExcludeReasonSchema = z.enum([
  'BINARY',
  'GENERATED',
  'USER_EXCLUDED',
  'RULE_EXCLUDED',
  'UNSUPPORTED',
  'EMPTY_DIFF',
]);
export type ReviewExcludeReason = z.infer<typeof ReviewExcludeReasonSchema>;

export const ReviewFileSchema = z.object({
  path: RepositoryRelativePathSchema,
  oldPath: RepositoryRelativePathSchema.optional(),
  status: ReviewFileStatusSchema,
  insertions: SafeNonNegativeIntegerSchema,
  deletions: SafeNonNegativeIntegerSchema,
  diffFingerprint: Sha256Schema,
  willReview: z.boolean(),
  excludeReason: ReviewExcludeReasonSchema.optional(),
  ruleGroupIds: z.array(z.string().min(1)),
}).strict().superRefine((value, context) => {
  if (value.willReview && value.excludeReason !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['excludeReason'],
      message: 'reviewable files cannot have an excludeReason',
    });
  }
  if (!value.willReview && value.excludeReason === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['excludeReason'],
      message: 'excluded files require an excludeReason',
    });
  }
  if (value.status === 'RENAMED' && value.oldPath === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['oldPath'],
      message: 'renamed files require oldPath',
    });
  }
});
export type ReviewFile = z.infer<typeof ReviewFileSchema>;

export const ReviewRuleGroupSchema = z.object({
  ruleGroupId: z.string().min(1),
  source: z.string().min(1),
  pattern: z.string().min(1),
  contentHash: Sha256Schema,
  text: z.string(),
  files: z.array(RepositoryRelativePathSchema),
}).strict();
export type ReviewRuleGroup = z.infer<typeof ReviewRuleGroupSchema>;

const OcrDelegateFileSchema = z.object({
  path: RepositoryRelativePathSchema,
  old_path: RepositoryRelativePathSchema.nullable(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'binary']),
  insertions: SafeNonNegativeIntegerSchema,
  deletions: SafeNonNegativeIntegerSchema,
  will_review: z.boolean(),
  exclude_reason: z.enum([
    'user_exclude',
    'unsupported_ext',
    'default_path',
    'provider_default_path',
    'gitignore',
    'deleted',
    'binary',
  ]).nullable(),
  rule_group_id: SafeNonNegativeIntegerSchema,
  diff_fingerprint: PrefixedSha256Schema,
}).strict();

const OcrDelegateRuleGroupSchema = z.object({
  id: SafeNonNegativeIntegerSchema,
  source: z.enum(['custom', 'project', 'system']),
  pattern: z.string().min(1),
  content_hash: PrefixedSha256Schema,
  rule: z.string(),
  files: z.array(RepositoryRelativePathSchema),
}).strict();

/** Exact snake_case stdout contract emitted by the AWKN OpenCodeReview thin fork. */
export const OcrDelegateSpecSchema = z.object({
  schema: z.literal(OCR_DELEGATE_SPEC_SCHEMA),
  ocr_version: z.string().min(1),
  repository: z.object({ root: z.string().min(1) }).strict(),
  target: z.object({
    mode: z.literal('range'),
    from_ref: z.string().min(1),
    from_oid: GitOidSchema,
    to_ref: z.string().min(1),
    to_oid: GitOidSchema,
    merge_base_oid: GitOidSchema,
  }).strict(),
  diff_fingerprint: PrefixedSha256Schema,
  rule_bundle_hash: PrefixedSha256Schema,
  summary: z.object({
    total_files: SafeNonNegativeIntegerSchema,
    reviewable_files: SafeNonNegativeIntegerSchema,
    excluded_files: SafeNonNegativeIntegerSchema,
    total_insertions: SafeNonNegativeIntegerSchema,
    total_deletions: SafeNonNegativeIntegerSchema,
  }).strict(),
  files: z.array(OcrDelegateFileSchema),
  rule_groups: z.array(OcrDelegateRuleGroupSchema),
}).strict();
export type OcrDelegateSpec = z.infer<typeof OcrDelegateSpecSchema>;

/** Provider-neutral scope specification consumed by the Review Planner. */
export const ReviewScopeSpecSchema = z.object({
  schema: z.literal(REVIEW_SCOPE_SPEC_SCHEMA),
  provider: z.enum(['open-code-review', 'native-git']),
  providerVersion: z.string().min(1),
  repositoryRoot: z.string().min(1),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  mergeBase: z.string().min(1),
  diffFingerprint: Sha256Schema,
  files: z.array(ReviewFileSchema),
  ruleGroups: z.array(ReviewRuleGroupSchema),
}).strict();
export type ReviewScopeSpec = z.infer<typeof ReviewScopeSpecSchema>;

export const ReviewTargetSchema = z.object({
  schema: z.literal(REVIEW_TARGET_SCHEMA),
  targetId: awknIdSchema('rtgt'),
  mode: z.enum(['COMMIT_RANGE', 'WORKTREE']),
  repositoryRoot: z.string().min(1),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  mergeBase: z.string().min(1),
  diffFingerprint: Sha256Schema,
  prdRefs: z.array(ObjectRefSchema),
  specRefs: z.array(ObjectRefSchema),
  acceptanceCriteriaRefs: z.array(ObjectRefSchema),
  includePatterns: z.array(z.string().min(1)),
  excludePatterns: z.array(z.string().min(1)),
  initiator: ActorRefSchema,
  implementer: ActorRefSchema,
  createdAt: UtcTimestampSchema,
}).strict();
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;

export const ReviewUnitTypeSchema = z.enum(['FILE', 'CROSS_FILE', 'SPEC', 'TEST_ABUSE']);
export type ReviewUnitType = z.infer<typeof ReviewUnitTypeSchema>;

export const ReviewRiskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type ReviewRisk = z.infer<typeof ReviewRiskSchema>;

export const ReviewUnitSchema = z.object({
  unitId: awknIdSchema('runit'),
  type: ReviewUnitTypeSchema,
  purpose: z.string().min(1),
  paths: z.array(RepositoryRelativePathSchema).min(1),
  risk: ReviewRiskSchema,
  ruleGroupIds: z.array(z.string().min(1)),
  specRefs: z.array(ObjectRefSchema),
  evidenceRefs: z.array(awknIdSchema('ev')),
}).strict();
export type ReviewUnit = z.infer<typeof ReviewUnitSchema>;

export const ReviewPlanSchema = z.object({
  schema: z.literal(REVIEW_PLAN_SCHEMA),
  planId: awknIdSchema('rplan'),
  target: ReviewTargetSchema,
  provider: z.enum(['open-code-review', 'native-git']),
  providerVersion: z.string().min(1),
  ruleBundleHash: Sha256Schema,
  files: z.array(ReviewFileSchema),
  ruleGroups: z.array(ReviewRuleGroupSchema),
  units: z.array(ReviewUnitSchema),
  /** 风险预算分配：unitId -> 分配的 token 预算（可选，不参与 planHash） */
  budgetAllocation: z.record(z.string(), z.number().int().nonnegative()).optional(),
  planHash: Sha256Schema,
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  const expected = computeReviewPlanHash(value);
  if (value.planHash !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['planHash'],
      message: `planHash does not match canonical plan content (expected ${expected})`,
    });
  }
});
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;

export const ReviewAxisSchema = z.enum(['CONTRACT', 'CODE', 'COVERAGE']);
export type ReviewAxis = z.infer<typeof ReviewAxisSchema>;

export const ReviewFindingCategorySchema = z.enum([
  'CORRECTNESS',
  'CONTRACT',
  'SECURITY',
  'TEST_QUALITY',
  'MAINTAINABILITY',
  'PERFORMANCE',
  'COVERAGE',
  'OTHER',
]);
export type ReviewFindingCategory = z.infer<typeof ReviewFindingCategorySchema>;

export const ReviewSeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

export const ReviewFindingSchema = z.object({
  schema: z.literal(REVIEW_FINDING_SCHEMA),
  findingId: awknIdSchema('rfnd'),
  unitId: awknIdSchema('runit'),
  fingerprint: Sha256Schema,
  axis: ReviewAxisSchema,
  category: ReviewFindingCategorySchema,
  severity: ReviewSeveritySchema,
  confidence: z.number().min(0).max(1),
  path: RepositoryRelativePathSchema,
  startLine: SafePositiveIntegerSchema,
  endLine: SafePositiveIntegerSchema,
  positionStatus: z.enum(['EXACT', 'RELOCATED', 'UNRESOLVED']),
  message: z.string().min(1),
  impact: z.string().min(1),
  suggestedFix: z.string().min(1),
  rationaleSummary: z.string().min(1),
  ruleRefs: z.array(ObjectRefSchema),
  specRefs: z.array(ObjectRefSchema),
  evidenceRefs: z.array(awknIdSchema('ev')).min(1),
  producer: ActorRefSchema,
  verifiedBy: z.array(ActorRefSchema),
  verificationKind: z.enum(['INDEPENDENT_REVIEWER', 'DETERMINISTIC_TOOL', 'NONE']),
  disposition: z.enum(['OPEN', 'ACCEPTED', 'SUPPRESSED', 'FIXED']),
  dispositionReason: z.string().min(1).optional(),
  dispositionActor: ActorRefSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.endLine < value.startLine) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endLine'], message: 'endLine must be >= startLine' });
  }
  const independent = value.verifiedBy.some((actor) => actor.actorId !== value.producer.actorId);
  if ((value.severity === 'CRITICAL' || value.severity === 'HIGH')
    && value.verificationKind === 'NONE') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verificationKind'],
      message: 'critical/high findings require independent reviewer or deterministic tool verification',
    });
  }
  if (value.verificationKind === 'INDEPENDENT_REVIEWER' && !independent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verifiedBy'],
      message: 'independent reviewer verification requires a verifier other than the producer',
    });
  }
  if ((value.disposition === 'SUPPRESSED' || value.disposition === 'ACCEPTED')
    && (value.dispositionReason === undefined || value.dispositionActor === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dispositionReason'],
      message: 'accepted/suppressed findings require a reason and actor',
    });
  }
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewUnitResultSchema = z.object({
  unitId: awknIdSchema('runit'),
  status: z.enum(['COMPLETED', 'FAILED', 'SKIPPED']),
  reviewer: ActorRefSchema,
  findingIds: z.array(awknIdSchema('rfnd')),
  evidenceRefs: z.array(awknIdSchema('ev')),
  error: z.string().min(1).optional(),
  totalTokens: SafeNonNegativeIntegerSchema,
  completedAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.status === 'FAILED' && value.error === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['error'], message: 'failed unit requires error' });
  }
  if (value.status === 'COMPLETED' && value.error !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['error'], message: 'completed unit cannot have error' });
  }
});
export type ReviewUnitResult = z.infer<typeof ReviewUnitResultSchema>;

export const ReviewRunSchema = z.object({
  schema: z.literal(REVIEW_RUN_SCHEMA),
  reviewRunId: awknIdSchema('rrun'),
  plan: ReviewPlanSchema,
  providerStatus: z.enum(['VALID', 'INVALID']),
  providerError: z.string().min(1).optional(),
  currentTargetFingerprint: Sha256Schema,
  unitResults: z.array(ReviewUnitResultSchema),
  findings: z.array(ReviewFindingSchema),
  validationErrors: z.array(z.string().min(1)),
  totalTokens: SafeNonNegativeIntegerSchema,
  startedAt: UtcTimestampSchema,
  completedAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.completedAt < value.startedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'completedAt must be >= startedAt' });
  }
  if (value.providerStatus === 'INVALID' && value.providerError === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['providerError'], message: 'invalid provider requires error' });
  }
  if (value.providerStatus === 'VALID' && value.providerError !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['providerError'], message: 'valid provider cannot have error' });
  }
  const planUnits = new Set(value.plan.units.map((unit) => unit.unitId));
  for (const result of value.unitResults) {
    if (!planUnits.has(result.unitId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['unitResults'], message: `unknown unitId ${result.unitId}` });
    }
  }
});
export type ReviewRun = z.infer<typeof ReviewRunSchema>;

export const ReviewCoverageMissingSchema = z.object({
  path: RepositoryRelativePathSchema.optional(),
  unitId: awknIdSchema('runit').optional(),
  reason: z.string().min(1),
}).strict().refine((value) => value.path !== undefined || value.unitId !== undefined, {
  message: 'coverage gap requires path or unitId',
});

export const ReviewCoverageSchema = z.object({
  schema: z.literal(REVIEW_COVERAGE_SCHEMA),
  plannedFiles: z.array(RepositoryRelativePathSchema),
  reviewedFiles: z.array(RepositoryRelativePathSchema),
  excludedFiles: z.array(RepositoryRelativePathSchema),
  failedFiles: z.array(RepositoryRelativePathSchema),
  plannedUnits: SafeNonNegativeIntegerSchema,
  completedUnits: SafeNonNegativeIntegerSchema,
  failedUnits: SafeNonNegativeIntegerSchema,
  fileCoverage: z.number().min(0).max(1),
  riskCoverage: z.number().min(0).max(1),
  missing: z.array(ReviewCoverageMissingSchema),
}).strict().superRefine((value, context) => {
  const namedSets: Array<[string, readonly string[]]> = [
    ['plannedFiles', value.plannedFiles],
    ['reviewedFiles', value.reviewedFiles],
    ['excludedFiles', value.excludedFiles],
    ['failedFiles', value.failedFiles],
  ];
  for (const [name, values] of namedSets) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} cannot contain duplicates` });
    }
  }
  const planned = new Set(value.plannedFiles);
  const reviewed = new Set(value.reviewedFiles);
  const excluded = new Set(value.excludedFiles);
  const failed = new Set(value.failedFiles);
  for (const path of reviewed) {
    if (!planned.has(path)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewedFiles'], message: `${path} is not planned` });
    if (failed.has(path)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewedFiles'], message: `${path} cannot be both reviewed and failed` });
  }
  for (const path of failed) {
    if (!planned.has(path)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['failedFiles'], message: `${path} is not planned` });
  }
  for (const path of excluded) {
    if (planned.has(path)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['excludedFiles'], message: `${path} cannot be planned and excluded` });
  }
  const expectedFileCoverage = value.plannedFiles.length === 0 ? 0 : value.reviewedFiles.length / value.plannedFiles.length;
  if (Math.abs(value.fileCoverage - expectedFileCoverage) > Number.EPSILON) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['fileCoverage'], message: `fileCoverage must be ${expectedFileCoverage}` });
  }
  if (value.completedUnits + value.failedUnits > value.plannedUnits) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['plannedUnits'], message: 'completedUnits + failedUnits cannot exceed plannedUnits' });
  }
  if (value.riskCoverage === 1 && value.completedUnits !== value.plannedUnits) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['riskCoverage'], message: 'riskCoverage 1 requires every unit completed' });
  }
});
export type ReviewCoverage = z.infer<typeof ReviewCoverageSchema>;

export const ReviewVerdictReasonSchema = z.enum([
  'OK',
  'TARGET_STALE',
  'FILE_COVERAGE_INCOMPLETE',
  'RISK_COVERAGE_INCOMPLETE',
  'UNIT_FAILED',
  'BLOCKING_FINDING',
  'CONTRACT_EVIDENCE_MISSING',
  'REVIEWER_NOT_INDEPENDENT',
  'FINDING_INVALID',
  'PROVIDER_INVALID',
]);
export type ReviewVerdictReason = z.infer<typeof ReviewVerdictReasonSchema>;

export const ReviewVerdictSchema = z.object({
  schema: z.literal(REVIEW_VERDICT_SCHEMA),
  status: z.enum(['PASS', 'FAIL', 'PARTIAL', 'STALE', 'INVALID']),
  reasonCodes: z.array(ReviewVerdictReasonSchema).min(1),
  blockerFindingIds: z.array(awknIdSchema('rfnd')),
  coverage: ReviewCoverageSchema,
  evaluatedAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  const onlyOk = value.reasonCodes.length === 1 && value.reasonCodes[0] === 'OK';
  if ((value.status === 'PASS') !== onlyOk) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reasonCodes'],
      message: 'PASS requires exactly OK; non-PASS cannot use only OK',
    });
  }
  if (value.status !== 'PASS' && value.reasonCodes.includes('OK')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCodes'], message: 'non-PASS verdict cannot include OK' });
  }
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewReceiptPayloadSchema = z.object({
  schema: z.literal(REVIEW_RECEIPT_SCHEMA),
  reviewRunId: awknIdSchema('rrun'),
  targetFingerprint: Sha256Schema,
  planHash: Sha256Schema,
  ruleBundleHash: Sha256Schema,
  reviewerActors: z.array(ActorRefSchema),
  findings: z.array(ReviewFindingSchema),
  coverage: ReviewCoverageSchema,
  verdict: ReviewVerdictSchema,
  evidenceRefs: z.array(awknIdSchema('ev')),
}).strict();
export type ReviewReceiptPayload = z.infer<typeof ReviewReceiptPayloadSchema>;

export const ReviewReceiptSchema = ReceiptEnvelopeSchema.superRefine((value, context) => {
  if (value.receiptType !== 'REVIEW') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['receiptType'], message: 'review receipt must use REVIEW type' });
  }
  if (value.payloadSchema !== REVIEW_RECEIPT_SCHEMA) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['payloadSchema'], message: `must be ${REVIEW_RECEIPT_SCHEMA}` });
  }
  const parsed = ReviewReceiptPayloadSchema.safeParse(value.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ['payload', ...issue.path] });
    }
  }
  if (parsed.success) {
    const expectedStatus = parsed.data.verdict.status === 'PASS'
      ? 'SUCCESS'
      : parsed.data.verdict.status === 'PARTIAL'
        ? 'PARTIAL'
        : 'FAILURE';
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: `receipt status must be ${expectedStatus} for ${parsed.data.verdict.status}`,
      });
    }
  }
  if (value.payloadHash !== receiptPayloadHash(value.payloadSchema, value.payload)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['payloadHash'], message: 'payloadHash mismatch' });
  }
});

export type ReviewReceipt = ReceiptEnvelope & {
  receiptType: 'REVIEW';
  payloadSchema: typeof REVIEW_RECEIPT_SCHEMA;
  payload: ReviewReceiptPayload;
};

export const ReviewShadowDiffPayloadSchema = z.object({
  schema: z.literal(REVIEW_SHADOW_DIFF_SCHEMA),
  reviewReceiptId: awknIdSchema('rcpt'),
  legacyPassed: z.boolean(),
  structuredStatus: z.enum(['PASS', 'FAIL', 'PARTIAL', 'STALE', 'INVALID']),
  classification: z.enum(['EXACT', 'EXPECTED_IMPROVEMENT', 'SAFETY_REGRESSION', 'UNKNOWN']),
  gateAuthority: z.literal('LEGACY'),
  createdAt: UtcTimestampSchema,
}).strict();
export type ReviewShadowDiffPayload = z.infer<typeof ReviewShadowDiffPayloadSchema>;

function reviewPlanHashProjection(plan: Pick<ReviewPlan,
  'target' | 'provider' | 'providerVersion' | 'ruleBundleHash' | 'files' | 'ruleGroups' | 'units'>): unknown {
  return {
    target: {
      repositoryRoot: plan.target.repositoryRoot,
      baseRef: plan.target.baseRef,
      headRef: plan.target.headRef,
      mergeBase: plan.target.mergeBase,
      diffFingerprint: plan.target.diffFingerprint,
      mode: plan.target.mode,
      prdRefs: plan.target.prdRefs,
      specRefs: plan.target.specRefs,
      acceptanceCriteriaRefs: plan.target.acceptanceCriteriaRefs,
      includePatterns: plan.target.includePatterns,
      excludePatterns: plan.target.excludePatterns,
    },
    provider: plan.provider,
    providerVersion: plan.providerVersion,
    ruleBundleHash: plan.ruleBundleHash,
    files: plan.files,
    ruleGroups: plan.ruleGroups,
    units: plan.units,
  };
}

export function computeReviewPlanHash(plan: Pick<ReviewPlan,
  'target' | 'provider' | 'providerVersion' | 'ruleBundleHash' | 'files' | 'ruleGroups' | 'units'>): string {
  return stableHash(REVIEW_PLAN_SCHEMA, reviewPlanHashProjection(plan));
}

export function computeReviewRuleBundleHash(ruleGroups: readonly ReviewRuleGroup[]): string {
  return stableHash('awkn-review-rule-bundle/v1', ruleGroups.map((group) => ({
    ruleGroupId: group.ruleGroupId,
    source: group.source,
    pattern: group.pattern,
    contentHash: group.contentHash,
    files: group.files,
  })));
}

export function deterministicReviewId(prefix: 'rtgt' | 'rplan' | 'runit' | 'rfnd', hash: string): string {
  return `${prefix}_${hash.slice(0, 32)}`;
}
