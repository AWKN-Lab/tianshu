import {
  AppendClaimCommandSchema,
  ApplyClaimTransitionsCommandSchema,
  ClaimAppendedEventSchema,
  ClaimLedgerEventSchema,
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
} from '../../../../contracts/public.js';
import {
  ClaimRepositoryError,
  type ClaimRepositoryPort,
} from '../../ports/outbound/claim-repository-port.js';

interface IdempotencyRecord {
  signature: string;
  claimIds: string[];
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

function commandSignature(schema: string, value: unknown): string {
  return stableHash(schema, value as JsonValue);
}

function claimSignature(claim: Claim): string {
  return stableHash('awkn-claim/v3', claim as JsonValue);
}

function cloneRecord(record: ClaimLedgerRecord): ClaimLedgerRecord {
  return ClaimLedgerRecordSchema.parse(record);
}

function cloneEvent(event: ClaimLedgerEvent): ClaimLedgerEvent {
  return ClaimLedgerEventSchema.parse(event);
}

export class InMemoryClaimRepository implements ClaimRepositoryPort {
  private readonly records = new Map<string, ClaimLedgerRecord>();
  private readonly events = new Map<string, ClaimLedgerEvent[]>();
  private readonly eventOwners = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  async append(value: AppendClaimCommand): Promise<ClaimLedgerRecord> {
    const command = AppendClaimCommandSchema.parse(value);
    const signature = commandSignature(command.schema, command);
    const prior = this.idempotency.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.signature !== signature) {
        throw new ClaimRepositoryError(
          'IDEMPOTENCY_CONFLICT',
          `idempotency key reused with different append command: ${command.idempotencyKey}`,
        );
      }
      const record = this.records.get(prior.claimIds[0]);
      if (record === undefined) {
        throw new ClaimRepositoryError('CLAIM_NOT_FOUND', 'idempotent append result is missing');
      }
      return cloneRecord(record);
    }

    const eventOwner = this.eventOwners.get(command.eventId);
    if (eventOwner !== undefined) {
      throw new ClaimRepositoryError(
        'EVENT_ID_COLLISION',
        `eventId already belongs to ${eventOwner}: ${command.eventId}`,
      );
    }

    const existing = this.records.get(command.claim.claimId);
    if (existing !== undefined) {
      if (claimSignature(existing.claim) !== claimSignature(command.claim)) {
        throw new ClaimRepositoryError(
          'CLAIM_ID_COLLISION',
          `claimId already exists with different content: ${command.claim.claimId}`,
        );
      }
      this.idempotency.set(command.idempotencyKey, {
        signature,
        claimIds: [command.claim.claimId],
      });
      return cloneRecord(existing);
    }

    const record = ClaimLedgerRecordSchema.parse({
      schema: 'awkn-claim-ledger-record/v1',
      claim: command.claim,
      revision: 0,
      createdAt: command.occurredAt,
      updatedAt: command.occurredAt,
    });
    const event = ClaimAppendedEventSchema.parse({
      schema: 'awkn-claim-ledger-event/v1',
      eventId: command.eventId,
      eventType: 'CLAIM_APPENDED',
      claimId: command.claim.claimId,
      revision: 0,
      idempotencyKey: command.idempotencyKey,
      occurredAt: command.occurredAt,
      claim: command.claim,
    });

    this.records.set(command.claim.claimId, record);
    this.events.set(command.claim.claimId, [event]);
    this.eventOwners.set(command.eventId, command.claim.claimId);
    this.idempotency.set(command.idempotencyKey, {
      signature,
      claimIds: [command.claim.claimId],
    });
    return cloneRecord(record);
  }

  async getById(claimId: string): Promise<ClaimLedgerRecord | undefined> {
    const record = this.records.get(claimId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  async list(value: ClaimRepositoryQuery): Promise<ClaimLedgerRecord[]> {
    const query = ClaimRepositoryQuerySchema.parse(value);
    const statuses = new Set(query.statuses);
    return [...this.records.values()]
      .filter((record) => query.projectId === undefined || record.claim.projectId === query.projectId)
      .filter((record) => query.userId === undefined || record.claim.userId === query.userId)
      .filter((record) => statuses.size === 0 || statuses.has(record.claim.epistemicStatus))
      .sort((left, right) => left.claim.claimId.localeCompare(right.claim.claimId))
      .map(cloneRecord);
  }

  async applyTransitions(value: ApplyClaimTransitionsCommand): Promise<ClaimLedgerRecord[]> {
    const command = ApplyClaimTransitionsCommandSchema.parse(value);
    const signature = commandSignature(command.schema, command);
    const prior = this.idempotency.get(command.idempotencyKey);
    if (prior !== undefined) {
      if (prior.signature !== signature) {
        throw new ClaimRepositoryError(
          'IDEMPOTENCY_CONFLICT',
          `idempotency key reused with different transition command: ${command.idempotencyKey}`,
        );
      }
      return prior.claimIds.map((claimId) => {
        const record = this.records.get(claimId);
        if (record === undefined) {
          throw new ClaimRepositoryError('CLAIM_NOT_FOUND', `claim not found: ${claimId}`);
        }
        return cloneRecord(record);
      });
    }

    const prepared = command.transitions.map((transition) => {
      const eventOwner = this.eventOwners.get(transition.eventId);
      if (eventOwner !== undefined) {
        throw new ClaimRepositoryError(
          'EVENT_ID_COLLISION',
          `eventId already belongs to ${eventOwner}: ${transition.eventId}`,
        );
      }
      const record = this.records.get(transition.claimId);
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

      const nextClaim = ClaimSchema.parse({
        ...record.claim,
        epistemicStatus: transition.toStatus,
      });
      const nextRecord = ClaimLedgerRecordSchema.parse({
        ...record,
        claim: nextClaim,
        revision: record.revision + 1,
        updatedAt: command.occurredAt,
      });
      const event = ClaimStatusChangedEventSchema.parse({
        schema: 'awkn-claim-ledger-event/v1',
        eventId: transition.eventId,
        eventType: 'CLAIM_STATUS_CHANGED',
        claimId: transition.claimId,
        revision: nextRecord.revision,
        idempotencyKey: command.idempotencyKey,
        occurredAt: command.occurredAt,
        fromStatus: record.claim.epistemicStatus,
        toStatus: transition.toStatus,
        reasonCode: transition.reasonCode,
      });
      return { nextRecord, event };
    });

    for (const item of prepared) {
      this.records.set(item.nextRecord.claim.claimId, item.nextRecord);
      const events = this.events.get(item.nextRecord.claim.claimId) ?? [];
      events.push(item.event);
      this.events.set(item.nextRecord.claim.claimId, events);
      this.eventOwners.set(item.event.eventId, item.nextRecord.claim.claimId);
    }
    const claimIds = prepared.map((item) => item.nextRecord.claim.claimId).sort();
    this.idempotency.set(command.idempotencyKey, { signature, claimIds });
    return claimIds.map((claimId) => cloneRecord(this.records.get(claimId)!));
  }

  async eventsFor(claimId: string): Promise<ClaimLedgerEvent[]> {
    return (this.events.get(claimId) ?? []).map(cloneEvent);
  }

  async replay(claimId: string): Promise<ClaimLedgerRecord | undefined> {
    const events = (this.events.get(claimId) ?? []).map(cloneEvent);
    if (events.length === 0) return undefined;
    let record: ClaimLedgerRecord | undefined;
    for (const event of events.sort((left, right) => left.revision - right.revision)) {
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
        claim: ClaimSchema.parse({
          ...record.claim,
          epistemicStatus: event.toStatus,
        }),
        revision: event.revision,
        updatedAt: event.occurredAt,
      });
    }
    return record === undefined ? undefined : cloneRecord(record);
  }
}
