import type { AuthorizationRecord } from './authorization.js';
import { stableHash } from './canonical-json.js';
import type { Claim } from './claim.js';
import type { ExecutionEnvelope } from './execution-envelope.js';
import type { GoalSpec } from './goal.js';
import type { JsonValue } from './json-value.js';

export function claimHashProjection(claim: Claim): JsonValue {
  const { contentHash: _contentHash, ...projection } = claim;
  return projection as JsonValue;
}

export function claimRecordHash(claim: Claim): string {
  return stableHash(claim.schema, claimHashProjection(claim));
}

export function goalSpecHashProjection(goal: GoalSpec): JsonValue {
  const { goalId: _goalId, createdAt: _createdAt, ...projection } = goal;
  return projection as JsonValue;
}

export function goalSpecContentHash(goal: GoalSpec): string {
  return stableHash(goal.schema, goalSpecHashProjection(goal));
}

export function executionEnvelopeHashProjection(envelope: ExecutionEnvelope): JsonValue {
  const {
    traceId: _traceId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    closedAt: _closedAt,
    ...projection
  } = envelope;
  return projection as JsonValue;
}

export function executionEnvelopeStateHash(envelope: ExecutionEnvelope): string {
  return stableHash(envelope.schema, executionEnvelopeHashProjection(envelope));
}

export function authorizationScopeHashProjection(authorization: AuthorizationRecord): JsonValue {
  const {
    tokenHash: _tokenHash,
    usedCount: _usedCount,
    status: _status,
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    revokedAt: _revokedAt,
    ...projection
  } = authorization;
  return projection as JsonValue;
}

export function authorizationScopeHash(authorization: AuthorizationRecord): string {
  return stableHash(authorization.schema, authorizationScopeHashProjection(authorization));
}
