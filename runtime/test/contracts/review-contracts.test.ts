import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OCR_DELEGATE_SPEC_SCHEMA,
  OcrDelegateSpecSchema,
  REVIEW_COVERAGE_SCHEMA,
  REVIEW_FINDING_SCHEMA,
  REVIEW_RECEIPT_SCHEMA,
  REVIEW_VERDICT_SCHEMA,
  ReviewCoverageSchema,
  ReviewFindingSchema,
  ReviewReceiptSchema,
  ReviewVerdictSchema,
  createAwknId,
  parseJsonValue,
  receiptPayloadHash,
  type ActorRef,
} from '../../src/contracts/public.js';

const hash = 'a'.repeat(64);
const now = '2026-07-28T08:00:00.000Z';
const reviewer: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'reviewer-1', actorType: 'assistant' };

function coverage() {
  return {
    schema: REVIEW_COVERAGE_SCHEMA,
    plannedFiles: ['src/a.ts'],
    reviewedFiles: ['src/a.ts'],
    excludedFiles: [],
    failedFiles: [],
    plannedUnits: 1,
    completedUnits: 1,
    failedUnits: 0,
    fileCoverage: 1,
    riskCoverage: 1,
    missing: [],
  } as const;
}

describe('OpenCodeReview wire contract', () => {
  const valid = {
    schema: OCR_DELEGATE_SPEC_SCHEMA,
    ocr_version: '1.2.3-awkn.1',
    repository: { root: 'D:\\repo' },
    target: {
      mode: 'range',
      from_ref: 'main',
      from_oid: '1'.repeat(40),
      to_ref: 'feature',
      to_oid: '2'.repeat(40),
      merge_base_oid: '3'.repeat(40),
    },
    diff_fingerprint: `sha256:${hash}`,
    rule_bundle_hash: `sha256:${'b'.repeat(64)}`,
    summary: {
      total_files: 1,
      reviewable_files: 1,
      excluded_files: 0,
      total_insertions: 2,
      total_deletions: 1,
    },
    files: [{
      path: 'src/a.ts',
      old_path: null,
      status: 'modified',
      insertions: 2,
      deletions: 1,
      will_review: true,
      exclude_reason: null,
      rule_group_id: 1,
      diff_fingerprint: `sha256:${hash}`,
    }],
    rule_groups: [{
      id: 1,
      source: 'project',
      pattern: '**/*.ts',
      content_hash: `sha256:${'c'.repeat(64)}`,
      rule: 'Review TypeScript strictly.',
      files: ['src/a.ts'],
    }],
  };

  it('accepts the frozen snake_case v1 wire shape', () => {
    assert.equal(OcrDelegateSpecSchema.parse(valid).schema, OCR_DELEGATE_SPEC_SCHEMA);
  });

  it('rejects unknown fields and unprefixed wire hashes', () => {
    assert.equal(OcrDelegateSpecSchema.safeParse({ ...valid, extra: true }).success, false);
    assert.equal(OcrDelegateSpecSchema.safeParse({ ...valid, diff_fingerprint: hash }).success, false);
  });
});

describe('Review fail-closed contracts', () => {
  it('requires independent verification for high findings', () => {
    const finding = {
      schema: REVIEW_FINDING_SCHEMA,
      findingId: createAwknId('reviewFinding'),
      unitId: createAwknId('reviewUnit'),
      fingerprint: hash,
      axis: 'CODE',
      category: 'CORRECTNESS',
      severity: 'HIGH',
      confidence: 0.9,
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      positionStatus: 'EXACT',
      message: 'Broken invariant',
      impact: 'Incorrect output',
      suggestedFix: 'Restore the invariant',
      rationaleSummary: 'The changed branch bypasses validation.',
      ruleRefs: [],
      specRefs: [],
      evidenceRefs: [createAwknId('evidence')],
      producer: reviewer,
      verifiedBy: [],
      verificationKind: 'NONE',
      disposition: 'OPEN',
    };
    assert.equal(ReviewFindingSchema.safeParse(finding).success, false);
    assert.equal(ReviewFindingSchema.safeParse({
      ...finding,
      verificationKind: 'DETERMINISTIC_TOOL',
    }).success, true);
  });

  it('rejects inconsistent coverage and non-PASS OK reasons', () => {
    assert.equal(ReviewCoverageSchema.safeParse({ ...coverage(), fileCoverage: 0.5 }).success, false);
    assert.equal(ReviewVerdictSchema.safeParse({
      schema: REVIEW_VERDICT_SCHEMA,
      status: 'FAIL',
      reasonCodes: ['OK', 'BLOCKING_FINDING'],
      blockerFindingIds: [],
      coverage: coverage(),
      evaluatedAt: now,
    }).success, false);
  });

  it('binds envelope status and payload hash to the structured verdict', () => {
    const payload = parseJsonValue({
      schema: REVIEW_RECEIPT_SCHEMA,
      reviewRunId: createAwknId('reviewRun'),
      targetFingerprint: hash,
      planHash: hash,
      ruleBundleHash: hash,
      reviewerActors: [reviewer],
      findings: [],
      coverage: coverage(),
      verdict: {
        schema: REVIEW_VERDICT_SCHEMA,
        status: 'PASS',
        reasonCodes: ['OK'],
        blockerFindingIds: [],
        coverage: coverage(),
        evaluatedAt: now,
      },
      evidenceRefs: [],
    });
    const receipt = {
      schema: 'awkn-receipt-envelope/v1',
      receiptId: createAwknId('receipt'),
      receiptType: 'REVIEW',
      payloadSchema: REVIEW_RECEIPT_SCHEMA,
      executionId: createAwknId('execution'),
      traceId: createAwknId('trace'),
      aggregateType: 'review-target',
      aggregateId: 'target',
      producer: reviewer,
      status: 'SUCCESS',
      payload,
      payloadHash: receiptPayloadHash(REVIEW_RECEIPT_SCHEMA, payload),
      artifactRefs: [],
      createdAt: now,
    };
    assert.equal(ReviewReceiptSchema.safeParse(receipt).success, true);
    assert.equal(ReviewReceiptSchema.safeParse({ ...receipt, status: 'FAILURE' }).success, false);
    assert.equal(ReviewReceiptSchema.safeParse({ ...receipt, payloadHash: 'b'.repeat(64) }).success, false);
  });
});
