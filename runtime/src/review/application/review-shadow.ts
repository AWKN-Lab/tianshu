import {
  REVIEW_SHADOW_DIFF_SCHEMA,
  ReviewShadowDiffPayloadSchema,
  createAwknId,
  parseJsonValue,
  receiptPayloadHash,
  type ActorRef,
  type ReceiptEnvelope,
  type ReviewReceipt,
  type ReviewShadowDiffPayload,
} from '../../contracts/public.js';

export type ReviewShadowDiffReceipt = ReceiptEnvelope & {
  readonly receiptType: 'SHADOW_DIFF';
  readonly payloadSchema: typeof REVIEW_SHADOW_DIFF_SCHEMA;
  readonly payload: ReviewShadowDiffPayload;
};

export function buildReviewShadowDiffReceipt(input: {
  readonly executionId: string;
  readonly traceId: string;
  readonly producer: ActorRef;
  readonly reviewReceipt: ReviewReceipt;
  readonly legacyPassed: boolean;
  readonly createdAt: string;
}): ReviewShadowDiffReceipt {
  const structuredPassed = input.reviewReceipt.payload.verdict.status === 'PASS';
  const classification = input.legacyPassed === structuredPassed
    ? 'EXACT'
    : !input.legacyPassed && structuredPassed
      ? 'SAFETY_REGRESSION'
      : 'EXPECTED_IMPROVEMENT';
  const payload = ReviewShadowDiffPayloadSchema.parse({
    schema: REVIEW_SHADOW_DIFF_SCHEMA,
    reviewReceiptId: input.reviewReceipt.receiptId,
    legacyPassed: input.legacyPassed,
    structuredStatus: input.reviewReceipt.payload.verdict.status,
    classification,
    gateAuthority: 'LEGACY',
    createdAt: input.createdAt,
  });
  const jsonPayload = parseJsonValue(payload);
  return {
    schema: 'awkn-receipt-envelope/v1',
    receiptId: createAwknId('receipt'),
    receiptType: 'SHADOW_DIFF',
    payloadSchema: REVIEW_SHADOW_DIFF_SCHEMA,
    executionId: input.executionId,
    traceId: input.traceId,
    aggregateType: input.reviewReceipt.aggregateType,
    aggregateId: input.reviewReceipt.aggregateId,
    producer: input.producer,
    status: classification === 'SAFETY_REGRESSION' ? 'FAILURE' : 'SUCCESS',
    payload,
    payloadHash: receiptPayloadHash(REVIEW_SHADOW_DIFF_SCHEMA, jsonPayload),
    artifactRefs: input.reviewReceipt.artifactRefs,
    createdAt: input.createdAt,
  };
}
