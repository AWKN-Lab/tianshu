import type {
  AppendClaimCommand,
  ApplyClaimTransitionsCommand,
  ClaimLedgerEvent,
  ClaimLedgerRecord,
  ClaimRepositoryQuery,
} from '../../../../contracts/public.js';

export type ClaimRepositoryErrorCode =
  | 'CLAIM_NOT_FOUND'
  | 'CLAIM_ID_COLLISION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'INVALID_STATUS_TRANSITION'
  | 'EVENT_ID_COLLISION';

export class ClaimRepositoryError extends Error {
  constructor(
    readonly code: ClaimRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClaimRepositoryError';
  }
}

export interface ClaimRepositoryPort {
  append(command: AppendClaimCommand): Promise<ClaimLedgerRecord>;
  getById(claimId: string): Promise<ClaimLedgerRecord | undefined>;
  list(query: ClaimRepositoryQuery): Promise<ClaimLedgerRecord[]>;
  applyTransitions(command: ApplyClaimTransitionsCommand): Promise<ClaimLedgerRecord[]>;
  eventsFor(claimId: string): Promise<ClaimLedgerEvent[]>;
  replay(claimId: string): Promise<ClaimLedgerRecord | undefined>;
}
