import type Database from 'better-sqlite3';
import {
  EvidenceRecordSchema,
  ReceiptEnvelopeSchema,
  ReviewReceiptSchema,
  createAwknId,
  stableHash,
  type ActorRef,
  type EvidenceRecord,
  type ReceiptEnvelope,
  type ReviewReceipt,
} from '../contracts/public.js';
import type { ReviewAuditPort } from '../review/public.js';

export interface EnsureReviewExecutionInput {
  readonly executionId: string;
  readonly traceId: string;
  readonly actor: ActorRef;
  readonly repositoryRoot: string;
  readonly rolloutMode: '0' | 'shadow' | 'enforce';
  readonly createdAt: string;
}

interface StoredReceiptRow {
  readonly receiptType: string;
  readonly payloadSchema: string;
  readonly executionId: string;
  readonly traceId: string;
  readonly runId: string | null;
  readonly stepId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly producerJson: string;
  readonly status: string;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly artifactRefsJson: string;
  readonly createdAt: string;
}

const STORED_RECEIPT_SELECT = `
  SELECT
    receipt_type AS receiptType, payload_schema AS payloadSchema,
    execution_id AS executionId, trace_id AS traceId, run_id AS runId, step_id AS stepId,
    aggregate_type AS aggregateType, aggregate_id AS aggregateId,
    producer_json AS producerJson, status, payload_json AS payloadJson,
    payload_hash AS payloadHash, artifact_refs_json AS artifactRefsJson, created_at AS createdAt
  FROM receipts WHERE id = ?
`;

function assertSameReceiptEnvelope(receipt: ReceiptEnvelope, row: StoredReceiptRow): void {
  const stored = ReceiptEnvelopeSchema.parse({
    schema: 'awkn-receipt-envelope/v1',
    receiptId: receipt.receiptId,
    receiptType: row.receiptType,
    payloadSchema: row.payloadSchema,
    executionId: row.executionId,
    traceId: row.traceId,
    ...(row.runId === null ? {} : { runId: row.runId }),
    ...(row.stepId === null ? {} : { stepId: row.stepId }),
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    producer: JSON.parse(row.producerJson),
    status: row.status,
    payload: JSON.parse(row.payloadJson),
    payloadHash: row.payloadHash,
    artifactRefs: JSON.parse(row.artifactRefsJson),
    createdAt: row.createdAt,
  });
  const domain = 'awkn-receipt-envelope-identity/v1';
  if (stableHash(domain, stored) !== stableHash(domain, receipt)) {
    throw new Error(`receipt ID collision with different envelope: ${receipt.receiptId}`);
  }
}

export class SqliteReviewAuditAdapter implements ReviewAuditPort {
  constructor(private readonly db: Database.Database) {}

  ensureExecution(input: EnsureReviewExecutionInput): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO executions(
        id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
        input_ref_json, feature_flags_ref_json, state, created_at, updated_at
      ) VALUES (?, ?, 0, ?, 'awkn-actor-ref/v1', ?, 'awkn-execution-scope/v1', ?, ?, 'RUNNING', ?, ?)
    `).run(
      input.executionId,
      input.traceId,
      JSON.stringify(input.actor),
      JSON.stringify({ repositoryRoot: input.repositoryRoot }),
      JSON.stringify({ source: 'review-kernel' }),
      JSON.stringify({ AWKN_REVIEW_OCR_V1: input.rolloutMode }),
      input.createdAt,
      input.createdAt,
    );
  }

  async persist(receipt: ReviewReceipt, evidence: readonly EvidenceRecord[]): Promise<void> {
    const parsedReceipt = ReviewReceiptSchema.parse(receipt) as ReviewReceipt;
    const parsedEvidence = evidence.map((record) => EvidenceRecordSchema.parse(record));
    const transaction = this.db.transaction(() => {
      const execution = this.db.prepare('SELECT id FROM executions WHERE id = ?').get(parsedReceipt.executionId);
      if (execution === undefined) throw new Error(`review execution does not exist: ${parsedReceipt.executionId}`);

      for (const record of parsedEvidence) {
        if (record.executionId !== parsedReceipt.executionId || record.traceId !== parsedReceipt.traceId) {
          throw new Error(`evidence ${record.evidenceId} belongs to another execution or trace`);
        }
        const existing = this.db.prepare(
          'SELECT content_hash AS contentHash, record_json AS recordJson FROM evidence_records WHERE id = ?',
        ).get(record.evidenceId) as { contentHash: string; recordJson: string } | undefined;
        const recordJson = JSON.stringify(record);
        if (existing !== undefined) {
          if (existing.contentHash !== record.contentHash || existing.recordJson !== recordJson) {
            throw new Error(`evidence ID collision with different content: ${record.evidenceId}`);
          }
          continue;
        }
        this.db.prepare(`
          INSERT INTO evidence_records(
            id, execution_id, trace_id, evidence_type, evidence_level,
            content_hash, record_json, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.evidenceId,
          record.executionId,
          record.traceId,
          record.type,
          record.level,
          record.contentHash,
          recordJson,
          record.observedAt,
        );
      }

      const existingReceipt = this.db.prepare(STORED_RECEIPT_SELECT)
        .get(parsedReceipt.receiptId) as StoredReceiptRow | undefined;
      const payloadJson = JSON.stringify(parsedReceipt.payload);
      if (existingReceipt !== undefined) assertSameReceiptEnvelope(parsedReceipt, existingReceipt);
      if (existingReceipt === undefined) this.db.prepare(`
        INSERT INTO receipts(
          id, receipt_type, payload_schema, execution_id, trace_id, run_id, step_id,
          aggregate_type, aggregate_id, producer_json, status, payload_json,
          payload_hash, artifact_refs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        parsedReceipt.receiptId,
        parsedReceipt.receiptType,
        parsedReceipt.payloadSchema,
        parsedReceipt.executionId,
        parsedReceipt.traceId,
        parsedReceipt.runId ?? null,
        parsedReceipt.stepId ?? null,
        parsedReceipt.aggregateType,
        parsedReceipt.aggregateId,
        JSON.stringify(parsedReceipt.producer),
        parsedReceipt.status,
        payloadJson,
        parsedReceipt.payloadHash,
        JSON.stringify(parsedReceipt.artifactRefs),
        parsedReceipt.createdAt,
      );

      const idempotencyKey = `review:${parsedReceipt.aggregateId}:${parsedReceipt.payloadHash}`;
      const exists = this.db.prepare('SELECT id FROM domain_events WHERE idempotency_key = ?').get(idempotencyKey);
      if (exists !== undefined) return;
      const revisionRow = this.db.prepare(
        'SELECT COALESCE(MAX(aggregate_revision), -1) AS revision FROM domain_events WHERE aggregate_id = ?',
      ).get(parsedReceipt.aggregateId) as { revision: number };
      const aggregateRevision = revisionRow.revision + 1;
      const eventPayload = {
        reviewReceiptId: parsedReceipt.receiptId,
        verdict: parsedReceipt.payload.verdict.status,
        planHash: parsedReceipt.payload.planHash,
      };
      this.db.prepare(`
        INSERT INTO domain_events(
          id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_revision, execution_id, trace_id, actor_json, idempotency_key,
          receipt_ids_json, payload_schema, payload_json, occurred_at
        ) VALUES (?, 'review.completed', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        createAwknId('event'),
        parsedReceipt.aggregateType,
        parsedReceipt.aggregateId,
        aggregateRevision,
        parsedReceipt.executionId,
        parsedReceipt.traceId,
        JSON.stringify(parsedReceipt.producer),
        idempotencyKey,
        JSON.stringify([parsedReceipt.receiptId]),
        'awkn-review-completed-event/v1',
        JSON.stringify(eventPayload),
        parsedReceipt.createdAt,
      );

      const state = parsedReceipt.status === 'SUCCESS'
        ? 'DELIVERED'
        : parsedReceipt.status === 'PARTIAL'
          ? 'PARTIAL'
          : 'FAILED';
      this.db.prepare('UPDATE executions SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(state, parsedReceipt.createdAt, parsedReceipt.executionId);
    });
    transaction();
  }

  persistEnvelope(receipt: ReceiptEnvelope): void {
    const parsed = ReceiptEnvelopeSchema.parse(receipt);
    const transaction = this.db.transaction(() => {
      const execution = this.db.prepare('SELECT id FROM executions WHERE id = ?').get(parsed.executionId);
      if (execution === undefined) throw new Error(`review execution does not exist: ${parsed.executionId}`);
      const existing = this.db.prepare(STORED_RECEIPT_SELECT)
        .get(parsed.receiptId) as StoredReceiptRow | undefined;
      const payloadJson = JSON.stringify(parsed.payload);
      if (existing !== undefined) {
        assertSameReceiptEnvelope(parsed, existing);
        return;
      }
      this.db.prepare(`
        INSERT INTO receipts(
          id, receipt_type, payload_schema, execution_id, trace_id, run_id, step_id,
          aggregate_type, aggregate_id, producer_json, status, payload_json,
          payload_hash, artifact_refs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        parsed.receiptId,
        parsed.receiptType,
        parsed.payloadSchema,
        parsed.executionId,
        parsed.traceId,
        parsed.runId ?? null,
        parsed.stepId ?? null,
        parsed.aggregateType,
        parsed.aggregateId,
        JSON.stringify(parsed.producer),
        parsed.status,
        payloadJson,
        parsed.payloadHash,
        JSON.stringify(parsed.artifactRefs),
        parsed.createdAt,
      );
    });
    transaction();
  }

  receiptReplayHash(receipt: ReviewReceipt): string {
    return stableHash('awkn-review-replay/v1', {
      payloadSchema: receipt.payloadSchema,
      payloadHash: receipt.payloadHash,
      artifactRefs: receipt.artifactRefs,
    });
  }
}
