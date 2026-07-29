import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { describe, it } from 'node:test';
import { SqliteReviewAuditAdapter } from '../../src/adapter/sqlite-review-audit-adapter.js';
import { buildReviewShadowDiffReceipt } from '../../src/review/public.js';
import {
  REVIEW_COVERAGE_SCHEMA,
  REVIEW_RECEIPT_SCHEMA,
  REVIEW_VERDICT_SCHEMA,
  createAwknId,
  parseJsonValue,
  receiptPayloadHash,
  type ActorRef,
  type EvidenceRecord,
  type ReviewReceipt,
} from '../../src/contracts/public.js';
import { runAgentOsMigrations } from '../../src/store/agent-os-migration-registry.js';

const now = '2026-07-28T08:00:00.000Z';
const actor: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'review-service', actorType: 'service' };

describe('SqliteReviewAuditAdapter', () => {
  it('atomically persists and idempotently replays receipt, evidence, and event', async () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      runAgentOsMigrations(db);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map((row) => row.name);
      assert.ok(tables.includes('evidence_records'));

      const adapter = new SqliteReviewAuditAdapter(db);
      const executionId = createAwknId('execution');
      const traceId = createAwknId('trace');
      adapter.ensureExecution({
        executionId,
        traceId,
        actor,
        repositoryRoot: 'D:\\repo',
        rolloutMode: 'enforce',
        createdAt: now,
      });
      const evidenceId = createAwknId('evidence');
      const evidence: EvidenceRecord = {
        schema: 'awkn-evidence/v2',
        evidenceId,
        executionId,
        traceId,
        claimIds: [],
        type: 'artifact',
        level: 1,
        contentHash: 'd'.repeat(64),
        sourceRef: {
          schema: 'awkn-source-ref/v1',
          sourceKind: 'tool_observation',
          sourceId: 'native-git-snapshot',
          contentHash: 'd'.repeat(64),
        },
        observedAt: now,
        producer: actor,
        verifiedBy: [],
      };
      const coverage = {
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
      const payload = parseJsonValue({
        schema: REVIEW_RECEIPT_SCHEMA,
        reviewRunId: createAwknId('reviewRun'),
        targetFingerprint: 'a'.repeat(64),
        planHash: 'b'.repeat(64),
        ruleBundleHash: 'c'.repeat(64),
        reviewerActors: [actor],
        findings: [],
        coverage,
        verdict: {
          schema: REVIEW_VERDICT_SCHEMA,
          status: 'PASS',
          reasonCodes: ['OK'],
          blockerFindingIds: [],
          coverage,
          evaluatedAt: now,
        },
        evidenceRefs: [evidenceId],
      });
      const receipt: ReviewReceipt = {
        schema: 'awkn-receipt-envelope/v1',
        receiptId: createAwknId('receipt'),
        receiptType: 'REVIEW',
        payloadSchema: REVIEW_RECEIPT_SCHEMA,
        executionId,
        traceId,
        aggregateType: 'review-target',
        aggregateId: 'rtgt_' + '1'.repeat(32),
        producer: actor,
        status: 'SUCCESS',
        payload: payload as ReviewReceipt['payload'],
        payloadHash: receiptPayloadHash(REVIEW_RECEIPT_SCHEMA, payload),
        artifactRefs: [],
        createdAt: now,
      };

      await adapter.persist(receipt, [evidence]);
      await adapter.persist(receipt, [evidence]);
      const shadowReceipt = buildReviewShadowDiffReceipt({
        executionId,
        traceId,
        producer: actor,
        reviewReceipt: receipt,
        legacyPassed: false,
        createdAt: now,
      });
      adapter.persistEnvelope(shadowReceipt);
      assert.equal(shadowReceipt.payload.classification, 'SAFETY_REGRESSION');
      assert.equal(shadowReceipt.status, 'FAILURE');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n, 2);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM evidence_records').get() as { n: number }).n, 1);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM domain_events').get() as { n: number }).n, 1);
      assert.equal((db.prepare('SELECT state FROM executions WHERE id = ?').get(executionId) as { state: string }).state, 'DELIVERED');
      assert.match(adapter.receiptReplayHash(receipt), /^[0-9a-f]{64}$/);

      const collidingEvidence = {
        ...evidence,
        contentHash: 'e'.repeat(64),
        sourceRef: { ...evidence.sourceRef, contentHash: 'e'.repeat(64) },
      };
      await assert.rejects(adapter.persist(receipt, [collidingEvidence]), /evidence ID collision/);

      const changedPayload = parseJsonValue({ ...receipt.payload, planHash: 'e'.repeat(64) });
      const collidingReceipt: ReviewReceipt = {
        ...receipt,
        payload: changedPayload as ReviewReceipt['payload'],
        payloadHash: receiptPayloadHash(REVIEW_RECEIPT_SCHEMA, changedPayload),
      };
      await assert.rejects(adapter.persist(collidingReceipt, [evidence]), /receipt ID collision/);

      const collidingEnvelope: ReviewReceipt = {
        ...receipt,
        producer: { ...actor, actorId: 'different-review-service' },
      };
      await assert.rejects(adapter.persist(collidingEnvelope, [evidence]), /different envelope/);
    } finally {
      db.close();
    }
  });
});
