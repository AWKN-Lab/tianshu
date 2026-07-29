import {
  REVIEW_RECEIPT_SCHEMA,
  ReviewReceiptPayloadSchema,
  ReviewReceiptSchema,
  createAwknId,
  parseJsonValue,
  receiptPayloadHash,
  type ObjectRef,
  type ReviewCoverage,
  type ReviewReceipt,
  type ReviewRun,
  type ReviewVerdict,
  type ActorRef,
} from '../../contracts/public.js';

export interface BuildReviewReceiptInput {
  readonly executionId: string;
  readonly traceId: string;
  readonly producer: ActorRef;
  readonly run: ReviewRun;
  readonly coverage: ReviewCoverage;
  readonly verdict: ReviewVerdict;
  readonly artifactRefs: readonly ObjectRef[];
  readonly createdAt: string;
}

export function buildReviewReceipt(input: BuildReviewReceiptInput): ReviewReceipt {
  const reviewerActors = [...new Map(
    input.run.unitResults.map((result) => [result.reviewer.actorId, result.reviewer]),
  ).values()];
  const evidenceRefs = [...new Set([
    ...input.run.unitResults.flatMap((result) => result.evidenceRefs),
    ...input.run.findings.flatMap((finding) => finding.evidenceRefs),
  ])].sort();
  const payload = ReviewReceiptPayloadSchema.parse({
    schema: REVIEW_RECEIPT_SCHEMA,
    reviewRunId: input.run.reviewRunId,
    targetFingerprint: input.run.plan.target.diffFingerprint,
    planHash: input.run.plan.planHash,
    ruleBundleHash: input.run.plan.ruleBundleHash,
    reviewerActors,
    findings: input.run.findings,
    coverage: input.coverage,
    verdict: input.verdict,
    evidenceRefs,
  });
  const jsonPayload = parseJsonValue(payload);
  const status = input.verdict.status === 'PASS'
    ? 'SUCCESS'
    : input.verdict.status === 'PARTIAL'
      ? 'PARTIAL'
      : 'FAILURE';
  const receipt = {
    schema: 'awkn-receipt-envelope/v1' as const,
    receiptId: createAwknId('receipt'),
    receiptType: 'REVIEW' as const,
    payloadSchema: REVIEW_RECEIPT_SCHEMA,
    executionId: input.executionId,
    traceId: input.traceId,
    aggregateType: 'review-target',
    aggregateId: input.run.plan.target.targetId,
    producer: input.producer,
    status,
    payload: jsonPayload,
    payloadHash: receiptPayloadHash(REVIEW_RECEIPT_SCHEMA, jsonPayload),
    artifactRefs: [...input.artifactRefs],
    createdAt: input.createdAt,
  };
  return ReviewReceiptSchema.parse(receipt) as ReviewReceipt;
}
