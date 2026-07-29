/**
 * Policy Conflict + Source Isolation Contract Tests (Phase 6 / C04 / WP-AOS-06)
 *
 * Covers:
 * - Source isolation: isSourceAllowed, isForbiddenPolicyId, sourceAuthority
 * - Registry enforcement of source isolation
 * - Status transitions: POLICY_STATUS_TRANSITIONS, isStatusTransitionAllowed
 * - Quarantine isolation: quarantined policy does not affect others
 * - snapshotActive and getContentHash
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Policy, PolicyStatus } from '../../src/contracts/policy.js';
import {
  PolicyRegistry,
  PolicyRegistryError,
  POLICY_STATUS_TRANSITIONS,
  isStatusTransitionAllowed,
} from '../../src/policy/registry.js';
import {
  isSourceAllowed,
  sourceAuthority,
  isForbiddenPolicyId,
  FORBIDDEN_POLICY_ID_PREFIXES,
} from '../../src/policy/resolver.js';

const now = '2026-07-28T10:00:00.000Z';

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  const base: Policy = {
    schema: 'awkn-policy/v1',
    policyId: 'core.test-policy',
    version: '1.0.0',
    status: 'ACTIVE',
    type: 'identity',
    scope: { taskProfiles: ['all'], levels: ['all'] },
    priority: 500,
    condition: { operator: 'exists', field: 'user.id' },
    decision: 'ALLOW',
    requiredActions: [],
    prohibitedActions: ['execute_without_authorization'],
    evidenceRequirements: ['context_manifest_hash'],
    onFailure: 'BLOCK',
    description: 'Test policy',
    createdAt: now,
    updatedAt: now,
    source: 'core',
  };
  return { ...base, ...overrides } as Policy;
}