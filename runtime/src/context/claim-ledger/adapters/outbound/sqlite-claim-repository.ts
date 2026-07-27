import type Database from 'better-sqlite3';
import {
  AppendClaimCommandSchema,
  ApplyClaimTransitionsCommandSchema,
  ClaimAppendedEventSchema,
  ClaimLedgerRecordSchema,
  ClaimRepositoryQuerySchema,
  ClaimSchema,
  ClaimStatusChangedEventSchema,
  stableHash,
  type AppendClaimCommand,
  type ApplyClaimTransitionsCommand,
  type Claim,
  type ClaimLedgerEvent,
  type ClaimLedgerRecord,
  type ClaimRepositoryQuery,
  type JsonValue,
  type SourceRef,
} from '../../../../contracts/public.js';
import {
  ClaimRepositoryError,
  type ClaimRepositoryPort,
} from '../../ports/outbound/claim-repository-port.js';

interface ClaimRow {
  id: string;
  content: string | null;
  content_hash: string;
  originator: Claim['originator'];
  speaker: Claim['speaker'];
  claim_type: Claim['claimType'];
  epistemic_status: Claim['epistemicStatus'];
  confirmation_level: Claim['confirmationLevel'];
  authority: number;
  confidence: number;
  sensitivity_class: string;
  project_id: string | null;
  user_id: string | null;
  valid_from: string | null;
  valid_until: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  claim_id: string;
  event_type: 'CLAIM_APPENDED' | 'CLAIM_STATUS_CHANGED';
  revision: number;
  payload_schema: string;
  payload_json: string;
  idempotency_key: string;
  created_at: string;
}

interface IdempotencyRow {
  command_hash: string;
  claim_ids_json: string;
}

const ALLOWED_TRANSITIONS: Record<Claim['epistemicStatus'], ReadonlySet<Claim['epistemicStatus']>> = {
  proposed: new Set(['asserted', 'disputed', 'superseded', 'expired']),
  asserted: new Set(['disputed', 'superseded', 'expired']),
  derived: new Set(['disputed', 'superseded', 'expired']),
  observed: new Set(['disputed', 'superseded', 'expired']),
  disputed: new Set(['asserted', 'superseded', 'expired']),
  superseded: new Set(),
  expired: new Set(),
};

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function commandHash(schema: string, value: unknown): string {
  return stableHash(schema, asJsonValue(value));
}

function claimHash(claim: Claim): string {
  return stableHash('awkn-claim/v3', asJsonValue(claim));
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function cloneRecord(record: ClaimLedgerRecord): ClaimLedgerRecord {
  return ClaimLedgerRecordSchema.parse(record);
}

export class SqliteClaimRepository implements ClaimRepositoryPort {
  constructor(private readonly db: Database.Database) {}

  async append(value: AppendClaimCommand): Promise<ClaimLedgerRecord> {
    const command = AppendClaimCommandSchema.parse(value);
    const signature = commandHash(command.schema, command);
    const prior = this.readIdempotency(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.command_hash !== signature) {
        throw new ClaimRepositoryError(
          'IDEMPOTENCY_CONFLICT',
          `idempotency key reused with different append command: ${command.idempotencyKey}`,
        );
      }
      const claimIds = parseJson<string[]>(prior.claim_ids_json);
      const record = this.readRecord(claimIds[0] ?? command.claim.claimId);
      if (record === undefined) {
        throw new ClaimRepositoryError('CLAIM_NOT_FOUND', 'idempotent append result is missing');
      }
      return record;
    }

    this.assertEventIdAvailable(command.eventId);
    const existing = this.readRecord(command.claim.claimId);
    if (existing !== undefined) {
      if (claimHash(existing.claim) !== claimHash(command.claim)) {
        throw new ClaimRepositoryError(
          'CLAIM_ID_COLLISION',
          `claimId already exists with different content: ${command.claim.claimId}`,
        );
      }
      this.insertIdempotency(
        command.idempotencyKey,
        command.schema,
        signature,
        [command.claim.claimId],
        command.occurredAt,
      );
      return existing;
    }

    const apply = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO claims(
          id, content, content_hash, originator, speaker, claim_type,
          epistemic_status, confirmation_level, authority, confidence,
          sensitivity_class, project_id, user_id, valid_from, valid_until,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        command.claim.claimId,
        command.claim.content,
        command.claim.contentHash,
        command.claim.originator,
        command.claim.speaker,
        command.claim.claimType,
        command.claim.epistemicStatus,
        command.claim.confirmationLevel,
        command.claim.authority,
        command.claim.confidence,
        command.claim.sensitivityClass,
        command.claim.projectId ?? null,
        command.claim.userId ?? null,
        command.claim.validFrom ?? null,
        command.claim.validUntil ?? null,
        command.occurredAt,
        command.occurredAt,
      );

      const sourceInsert = this.db.prepare(`
        INSERT INTO claim_sources(
          claim_id, source_id, source_kind, source_uri, source_span_json,
          source_hash, observed_at, source_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const source of command.claim.sourceRefs) {
        sourceInsert.run(
          command.claim.claimId,
          source.sourceId,
          source.sourceKind,
          source.uri ?? null,
          source.span === undefined ? null : JSON.stringify(source.span),
          source.contentHash ?? null,
          source.observedAt ?? null,
          JSON.stringify(source),
        );
      }

      const derivationInsert = this.db.prepare(`
        INSERT INTO claim_derivations(claim_id, parent_claim_id, derivation_type, created_at)
        VALUES (?, ?, 'derived_from', ?)
      `);
      for (const parentClaimId of command.claim.derivedFrom) {
        derivationInsert.run(command.claim.claimId, parentClaimId, command.occurredAt);
      }

      this.db.prepare(`
        INSERT INTO claim_events(
          id, claim_id, event_type, revision, payload_schema,
          payload_json, idempotency_key, created_at
        ) VALUES (?, ?, 'CLAIM_APPENDED', 0, 'awkn-claim-appended/v1', ?, ?, ?)
      `).run(
        command.eventId,
        command.claim.claimId,
        JSON.stringify({ claim: command.claim }),
        command.idempotencyKey,
        command.occurredAt,
      );
      this.insertIdempotency(
        command.idempotencyKey,
        command.schema,
        signature,
        [command.claim.claimId],
        command.occurredAt,
      );
    });

    try {
      apply();
    } catch (error) {
      if (error instanceof ClaimRepositoryError) throw error;
      throw error;
    }
    const record = this.readRecord(command.claim.claimId);
    if (record === undefined) throw new ClaimRepositoryError('CLAIM_NOT_FOUND', 'appended claim is missing');
    return record;
  }

  async getById(claimId: string): Promise<ClaimLedgerRecord | undefined> {
    return this.readRecord(claimId);
  }

  async list(value: ClaimRepositoryQuery): Promise<ClaimLedgerRecord[]> {
    const query = ClaimRepositoryQuerySchema.parse(value);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.projectId !== undefined) {
      clauses.push('project_id = ?');
      params.push(query.projectId);
    }
    if (query.userId !== undefined) {
      clauses.push('user_id = ?');
      params.push(query.userId);
    }
    if (query.statuses.length > 0) {
      clauses.push(`epistemic_status IN (${query.statuses.map(() => '?').join(',')})`);
      params.push(...query.statuses);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = this.db.prepare(`SELECT id FROM claims ${where} ORDER BY id`).all(...params) as Array<{ id: string }>;
    return rows.map((row) => this.readRecord(row.id)).filter((record): record is ClaimLedgerRecord => record !== undefined);
  }

  async applyTransitions(value: ApplyClaimTransitionsCommand): Promise<ClaimLedgerRecord[]> {
    const command = ApplyClaimTransitionsCommandSchema.parse(value);
    const signature = commandHash(command.schema, command);
    const prior = this.readIdempotency(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.command_hash !== signature) {
        throw new ClaimRepositoryError(
          'IDEMPOTENCY_CONFLICT',
          `idempotency key reused with different transition command: ${command.idempotencyKey}`,
        );
      }
      return parseJson<string[]>(prior.claim_ids_json).map((claimId) => {
        const record = this.readRecord(claimId);
        if (record === undefined) throw new ClaimRepositoryError('CLAIM_NOT_FOUND', `claim not found: ${claimId}`);
        return record;
      });
    }

    const prepared = command.transitions.map((transition) => {
      this.assertEventIdAvailable(transition.eventId);
      const record = this.readRecord(transition.claimId);
      if (record === undefined) {
        throw new ClaimRepositoryError('CLAIM_NOT_FOUND', `claim not found: ${transition.claimId}`);
      }
      if (record.revision !== transition.expectedRevision) {
        throw new ClaimRepositoryError(
          'REVISION_CONFLICT',
          `expected revision ${transition.expectedRevision}, found ${record.revision}: ${transition.claimId}`,
        );
      }
      if (!ALLOWED_TRANSITIONS[record.claim.epistemicStatus].has(transition.toStatus)) {
        throw new ClaimRepositoryError(
          'INVALID_STATUS_TRANSITION',
          `cannot move ${record.claim.epistemicStatus} to ${transition.toStatus}: ${transition.claimId}`,
        );
      }
      return { transition, record };
    });

    const apply = this.db.transaction(() => {
      const update = this.db.prepare(`
        UPDATE claims
        SET epistemic_status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `);
      const eventInsert = this.db.prepare(`
        INSERT INTO claim_events(
          id, claim_id, event_type, revision, payload_schema,
          payload_json, idempotency_key, created_at
        ) VALUES (?, ?, 'CLAIM_STATUS_CHANGED', ?, 'awkn-claim-status-changed/v1', ?, ?, ?)
      `);
      for (const item of prepared) {
        const result = update.run(
          item.transition.toStatus,
          command.occurredAt,
          item.transition.claimId,
          item.transition.expectedRevision,
        );
        if (result.changes !== 1) {
          throw new ClaimRepositoryError('REVISION_CONFLICT', `revision changed during transaction: ${item.transition.claimId}`);
        }
        eventInsert.run(
          item.transition.eventId,
          item.transition.claimId,
          item.record.revision + 1,
          JSON.stringify({
            fromStatus: item.record.claim.epistemicStatus,
            toStatus: item.transition.toStatus,
            reasonCode: item.transition.reasonCode,
          }),
          `${command.idempotencyKey}:${item.transition.claimId}`,
          command.occurredAt,
        );
      }
      const claimIds = prepared.map((item) => item.transition.claimId).sort();
      this.insertIdempotency(
        command.idempotencyKey,
        command.schema,
        signature,
        claimIds,
        command.occurredAt,
      );
    });
    apply();

    return prepared
      .map((item) => this.readRecord(item.transition.claimId))
      .filter((record): record is ClaimLedgerRecord => record !== undefined)
      .sort((left, right) => left.claim.claimId.localeCompare(right.claim.claimId));
  }

  async eventsFor(claimId: string): Promise<ClaimLedgerEvent[]> {
    return this.readEvents(claimId);
  }

  async replay(claimId: string): Promise<ClaimLedgerRecord | undefined> {
    const events = this.readEvents(claimId);
    if (events.length === 0) return undefined;
    let record: ClaimLedgerRecord | undefined;
    for (const event of events) {
      if (event.eventType === 'CLAIM_APPENDED') {
        if (record !== undefined || event.revision !== 0) {
          throw new ClaimRepositoryError('REVISION_CONFLICT', `invalid append event sequence: ${claimId}`);
        }
        record = ClaimLedgerRecordSchema.parse({
          schema: 'awkn-claim-ledger-record/v1',
          claim: event.claim,
          revision: 0,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        });
        continue;
      }
      if (record === undefined || event.revision !== record.revision + 1) {
        throw new ClaimRepositoryError('REVISION_CONFLICT', `invalid event revision sequence: ${claimId}`);
      }
      record = ClaimLedgerRecordSchema.parse({
        ...record,
        claim: ClaimSchema.parse({ ...record.claim, epistemicStatus: event.toStatus }),
        revision: event.revision,
        updatedAt: event.occurredAt,
      });
    }
    return record === undefined ? undefined : cloneRecord(record);
  }

  private readIdempotency(key: string): IdempotencyRow | undefined {
    return this.db.prepare(`
      SELECT command_hash, claim_ids_json FROM claim_command_idempotency WHERE idempotency_key = ?
    `).get(key) as IdempotencyRow | undefined;
  }

  private insertIdempotency(
    key: string,
    schema: string,
    hash: string,
    claimIds: string[],
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO claim_command_idempotency(
        idempotency_key, command_schema, command_hash, claim_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(key, schema, hash, JSON.stringify(claimIds), createdAt);
  }

  private assertEventIdAvailable(eventId: string): void {
    const owner = this.db.prepare('SELECT claim_id FROM claim_events WHERE id = ?').get(eventId) as { claim_id: string } | undefined;
    if (owner !== undefined) {
      throw new ClaimRepositoryError(
        'EVENT_ID_COLLISION',
        `eventId already belongs to ${owner.claim_id}: ${eventId}`,
      );
    }
  }

  private readRecord(claimId: string): ClaimLedgerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId) as ClaimRow | undefined;
    if (row === undefined) return undefined;
    const sources = (this.db.prepare(`
      SELECT source_json FROM claim_sources WHERE claim_id = ? ORDER BY source_id
    `).all(claimId) as Array<{ source_json: string }>).map((item) => parseJson<SourceRef>(item.source_json));
    const derivedFrom = (this.db.prepare(`
      SELECT parent_claim_id FROM claim_derivations WHERE claim_id = ? ORDER BY parent_claim_id
    `).all(claimId) as Array<{ parent_claim_id: string }>).map((item) => item.parent_claim_id);
    const claim = ClaimSchema.parse({
      schema: 'awkn-claim/v3',
      claimId: row.id,
      content: row.content,
      contentHash: row.content_hash,
      originator: row.originator,
      speaker: row.speaker,
      claimType: row.claim_type,
      epistemicStatus: row.epistemic_status,
      confirmationLevel: row.confirmation_level,
      sourceRefs: sources,
      derivedFrom,
      authority: row.authority,
      confidence: row.confidence,
      sensitivityClass: row.sensitivity_class,
      ...(row.project_id === null ? {} : { projectId: row.project_id }),
      ...(row.user_id === null ? {} : { userId: row.user_id }),
      ...(row.valid_from === null ? {} : { validFrom: row.valid_from }),
      ...(row.valid_until === null ? {} : { validUntil: row.valid_until }),
    });
    return ClaimLedgerRecordSchema.parse({
      schema: 'awkn-claim-ledger-record/v1',
      claim,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private readEvents(claimId: string): ClaimLedgerEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM claim_events WHERE claim_id = ? ORDER BY revision
    `).all(claimId) as EventRow[];
    return rows.map((row) => {
      if (row.event_type === 'CLAIM_APPENDED') {
        const payload = parseJson<{ claim: Claim }>(row.payload_json);
        return ClaimAppendedEventSchema.parse({
          schema: 'awkn-claim-ledger-event/v1',
          eventId: row.id,
          eventType: 'CLAIM_APPENDED',
          claimId: row.claim_id,
          revision: row.revision,
          idempotencyKey: row.idempotency_key,
          occurredAt: row.created_at,
          claim: payload.claim,
        });
      }
      const payload = parseJson<{
        fromStatus: Claim['epistemicStatus'];
        toStatus: Claim['epistemicStatus'];
        reasonCode: string;
      }>(row.payload_json);
      return ClaimStatusChangedEventSchema.parse({
        schema: 'awkn-claim-ledger-event/v1',
        eventId: row.id,
        eventType: 'CLAIM_STATUS_CHANGED',
        claimId: row.claim_id,
        revision: row.revision,
        idempotencyKey: row.idempotency_key,
        occurredAt: row.created_at,
        fromStatus: payload.fromStatus,
        toStatus: payload.toStatus,
        reasonCode: payload.reasonCode,
      });
    });
  }
}
