/**
 * Policy Conflict + Source Isolation Contract Tests (Phase 6 / C04 / WP-AOS-06)
 *
 * Covers:
 * - Source isolation: isSourceAllowed, isForbiddenPolicyId, sourceAuthority
 * - FORBIDDEN_POLICY_ID_PREFIXES full enumeration
 * - Registry enforcement of source isolation (register rejects)
 * - Status transitions: POLICY_STATUS_TRANSITIONS matrix, isStatusTransitionAllowed
 * - PolicyRegistry.transitionStatus: legal + illegal + not-found
 * - Quarantine isolation: quarantined policy does not affect others
 * - snapshotActive reference isolation
 * - getContentHash stability
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

// ===========================================================================
// Section: Source Isolation
// ===========================================================================

describe('Source Isolation - isSourceAllowed', () => {
  it('returns true for core', () => {
    assert.equal(isSourceAllowed('core'), true);
  });
  it('returns true for project', () => {
    assert.equal(isSourceAllowed('project'), true);
  });
  it('returns true for task_profile', () => {
    assert.equal(isSourceAllowed('task_profile'), true);
  });
  it('returns true for evolve_candidate', () => {
    assert.equal(isSourceAllowed('evolve_candidate'), true);
  });
  it('returns false for gundam', () => {
    assert.equal(isSourceAllowed('gundam'), false);
  });
  it('returns false for coze', () => {
    assert.equal(isSourceAllowed('coze'), false);
  });
  it('returns false for unknown', () => {
    assert.equal(isSourceAllowed('unknown'), false);
  });
  it('returns false for empty string', () => {
    assert.equal(isSourceAllowed(''), false);
  });
  it('returns false for business project names', () => {
    assert.equal(isSourceAllowed('annie'), false);
    assert.equal(isSourceAllowed('subtitle'), false);
    assert.equal(isSourceAllowed('mr.mont'), false);
    assert.equal(isSourceAllowed('value'), false);
    assert.equal(isSourceAllowed('win'), false);
  });
});

describe('Source Isolation - sourceAuthority', () => {
  it('returns 3 for core (highest)', () => {
    assert.equal(sourceAuthority('core'), 3);
  });
  it('returns 2 for task_profile', () => {
    assert.equal(sourceAuthority('task_profile'), 2);
  });
  it('returns 1 for project', () => {
    assert.equal(sourceAuthority('project'), 1);
  });
  it('returns 0 for evolve_candidate (lowest)', () => {
    assert.equal(sourceAuthority('evolve_candidate'), 0);
  });
  it('returns -1 for unknown source', () => {
    assert.equal(sourceAuthority('gundam'), -1);
    assert.equal(sourceAuthority('unknown'), -1);
    assert.equal(sourceAuthority(''), -1);
  });
  it('core authority > task_profile > project > evolve_candidate', () => {
    const core = sourceAuthority('core');
    const tp = sourceAuthority('task_profile');
    const proj = sourceAuthority('project');
    const evolve = sourceAuthority('evolve_candidate');
    assert.ok(core > tp, 'core > task_profile');
    assert.ok(tp > proj, 'task_profile > project');
    assert.ok(proj > evolve, 'project > evolve_candidate');
  });
});

describe('Source Isolation - isForbiddenPolicyId', () => {
  it('returns true for each FORBIDDEN_POLICY_ID_PREFIXES prefix', () => {
    for (const prefix of FORBIDDEN_POLICY_ID_PREFIXES) {
      const policyId = `${prefix}some.policy`;
      assert.equal(
        isForbiddenPolicyId(policyId),
        true,
        `prefix "${prefix}" should be forbidden (tested: ${policyId})`,
      );
    }
  });

  it('returns true for gundam.foo', () => {
    assert.equal(isForbiddenPolicyId('gundam.foo'), true);
  });
  it('returns true for value.bar', () => {
    assert.equal(isForbiddenPolicyId('value.bar'), true);
  });
  it('returns true for win.baz', () => {
    assert.equal(isForbiddenPolicyId('win.baz'), true);
  });
  it('returns true for mr.mont.thing', () => {
    assert.equal(isForbiddenPolicyId('mr.mont.thing'), true);
  });
  it('returns true for annie.stuff', () => {
    assert.equal(isForbiddenPolicyId('annie.stuff'), true);
  });
  it('returns true for subtitle.item', () => {
    assert.equal(isForbiddenPolicyId('subtitle.item'), true);
  });
  it('returns true for coze.flow', () => {
    assert.equal(isForbiddenPolicyId('coze.flow'), true);
  });
  it('returns true for project.annie.special', () => {
    assert.equal(isForbiddenPolicyId('project.annie.special'), true);
  });

  it('returns false for core.foo', () => {
    assert.equal(isForbiddenPolicyId('core.foo'), false);
  });
  it('returns false for project.bar (not project.annie)', () => {
    assert.equal(isForbiddenPolicyId('project.bar'), false);
  });
  it('returns false for task_profile.baz', () => {
    assert.equal(isForbiddenPolicyId('task_profile.baz'), false);
  });
  it('returns false for evolve_candidate.thing', () => {
    assert.equal(isForbiddenPolicyId('evolve_candidate.thing'), false);
  });

  it('is case-insensitive (lowercases input)', () => {
    assert.equal(isForbiddenPolicyId('GUNDAM.Foo'), true);
    assert.equal(isForbiddenPolicyId('Value.Bar'), true);
    assert.equal(isForbiddenPolicyId('WIN.Baz'), true);
  });

  it('FORBIDDEN_POLICY_ID_PREFIXES is non-empty', () => {
    assert.ok(FORBIDDEN_POLICY_ID_PREFIXES.length > 0, 'should have forbidden prefixes');
  });

  it('FORBIDDEN_POLICY_ID_PREFIXES contains expected entries', () => {
    const expected = ['gundam.', 'value.', 'win.', 'mr.mont.', 'annie.', 'subtitle.', 'coze.', 'project.annie'];
    for (const prefix of expected) {
      assert.ok(
        FORBIDDEN_POLICY_ID_PREFIXES.includes(prefix),
        `expected prefix "${prefix}" in FORBIDDEN_POLICY_ID_PREFIXES`,
      );
    }
  });
});

// ===========================================================================
// Section: Registry Source Enforcement
// ===========================================================================

describe('PolicyRegistry - source enforcement on register', () => {
  it('rejects forbidden source with SOURCE_NOT_ALLOWED', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ source: 'gundam' });
    assert.throws(
      () => registry.register(policy, now),
      (err: unknown) => {
        assert.ok(err instanceof PolicyRegistryError);
        assert.equal((err as PolicyRegistryError).code, 'SOURCE_NOT_ALLOWED');
        return true;
      },
    );
  });

  it('rejects forbidden policyId with FORBIDDEN_POLICY_ID', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'gundam.evil.policy' });
    assert.throws(
      () => registry.register(policy, now),
      (err: unknown) => {
        assert.ok(err instanceof PolicyRegistryError);
        assert.equal((err as PolicyRegistryError).code, 'FORBIDDEN_POLICY_ID');
        return true;
      },
    );
  });

  it('rejects duplicate version with VERSION_CONFLICT', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.dup', version: '1.0.0' });
    registry.register(policy, now);
    assert.throws(
      () => registry.register(policy, now),
      (err: unknown) => {
        assert.ok(err instanceof PolicyRegistryError);
        assert.equal((err as PolicyRegistryError).code, 'VERSION_CONFLICT');
        return true;
      },
    );
  });

  it('accepts all 4 allowed sources', () => {
    const registry = new PolicyRegistry();
    const sources = ['core', 'project', 'task_profile', 'evolve_candidate'] as const;
    for (let i = 0; i < sources.length; i++) {
      const policy = makePolicy({
        policyId: `${sources[i]}.policy-${i}`,
        source: sources[i],
      });
      assert.doesNotThrow(() => registry.register(policy, now));
    }
    assert.equal(registry.size(), 4);
  });

  it('rejects each forbidden prefix on register', () => {
    for (const prefix of FORBIDDEN_POLICY_ID_PREFIXES) {
      const registry = new PolicyRegistry();
      const policy = makePolicy({ policyId: `${prefix}test` });
      assert.throws(
        () => registry.register(policy, now),
        (err: unknown) => {
          assert.ok(err instanceof PolicyRegistryError);
          assert.equal((err as PolicyRegistryError).code, 'FORBIDDEN_POLICY_ID');
          return true;
        },
        `should reject policyId starting with "${prefix}"`,
      );
    }
  });
});

// ===========================================================================
// Section: Status Transitions
// ===========================================================================

describe('POLICY_STATUS_TRANSITIONS matrix', () => {
  const allStatuses: PolicyStatus[] = [
    'DRAFT', 'VALIDATING', 'APPROVED', 'ACTIVE', 'QUARANTINED', 'RETIRED',
  ];

  it('defines transitions for all 6 statuses', () => {
    for (const status of allStatuses) {
      assert.ok(
        Array.isArray(POLICY_STATUS_TRANSITIONS[status]),
        `status ${status} should have transitions array`,
      );
    }
  });

  it('RETIRED has no allowed transitions (terminal state)', () => {
    assert.equal(POLICY_STATUS_TRANSITIONS.RETIRED.length, 0);
  });

  it('DRAFT can transition to VALIDATING and RETIRED', () => {
    assert.deepEqual([...POLICY_STATUS_TRANSITIONS.DRAFT].sort(), ['RETIRED', 'VALIDATING']);
  });

  it('VALIDATING can transition to APPROVED, QUARANTINED, DRAFT', () => {
    assert.deepEqual(
      [...POLICY_STATUS_TRANSITIONS.VALIDATING].sort(),
      ['APPROVED', 'DRAFT', 'QUARANTINED'],
    );
  });

  it('APPROVED can transition to ACTIVE and QUARANTINED', () => {
    assert.deepEqual(
      [...POLICY_STATUS_TRANSITIONS.APPROVED].sort(),
      ['ACTIVE', 'QUARANTINED'],
    );
  });

  it('ACTIVE can transition to QUARANTINED and RETIRED', () => {
    assert.deepEqual(
      [...POLICY_STATUS_TRANSITIONS.ACTIVE].sort(),
      ['QUARANTINED', 'RETIRED'],
    );
  });

  it('QUARANTINED can transition to RETIRED and VALIDATING', () => {
    assert.deepEqual(
      [...POLICY_STATUS_TRANSITIONS.QUARANTINED].sort(),
      ['RETIRED', 'VALIDATING'],
    );
  });

  it('matrix has exactly 6 status entries', () => {
    assert.equal(Object.keys(POLICY_STATUS_TRANSITIONS).length, 6);
  });

  it('each transition list contains only valid PolicyStatus values', () => {
    const validStatuses = new Set(allStatuses);
    for (const [from, allowed] of Object.entries(POLICY_STATUS_TRANSITIONS)) {
      for (const to of allowed) {
        assert.ok(
          validStatuses.has(to),
          `transition ${from} → ${to}: "${to}" is not a valid PolicyStatus`,
        );
      }
    }
  });
});

describe('isStatusTransitionAllowed', () => {
  it('returns true for DRAFT → VALIDATING', () => {
    assert.equal(isStatusTransitionAllowed('DRAFT', 'VALIDATING'), true);
  });
  it('returns true for VALIDATING → APPROVED', () => {
    assert.equal(isStatusTransitionAllowed('VALIDATING', 'APPROVED'), true);
  });
  it('returns true for APPROVED → ACTIVE', () => {
    assert.equal(isStatusTransitionAllowed('APPROVED', 'ACTIVE'), true);
  });
  it('returns true for ACTIVE → QUARANTINED', () => {
    assert.equal(isStatusTransitionAllowed('ACTIVE', 'QUARANTINED'), true);
  });
  it('returns true for ACTIVE → RETIRED', () => {
    assert.equal(isStatusTransitionAllowed('ACTIVE', 'RETIRED'), true);
  });
  it('returns true for QUARANTINED → VALIDATING', () => {
    assert.equal(isStatusTransitionAllowed('QUARANTINED', 'VALIDATING'), true);
  });
  it('returns true for QUARANTINED → RETIRED', () => {
    assert.equal(isStatusTransitionAllowed('QUARANTINED', 'RETIRED'), true);
  });

  it('returns false for ACTIVE → APPROVED (cannot go back)', () => {
    assert.equal(isStatusTransitionAllowed('ACTIVE', 'APPROVED'), false);
  });
  it('returns false for ACTIVE → DRAFT (cannot go back to draft)', () => {
    assert.equal(isStatusTransitionAllowed('ACTIVE', 'DRAFT'), false);
  });
  it('returns false for DRAFT → ACTIVE (must validate first)', () => {
    assert.equal(isStatusTransitionAllowed('DRAFT', 'ACTIVE'), false);
  });
  it('returns false for RETIRED → anything (terminal)', () => {
    const statuses: PolicyStatus[] = ['DRAFT', 'VALIDATING', 'APPROVED', 'ACTIVE', 'QUARANTINED', 'RETIRED'];
    for (const to of statuses) {
      assert.equal(isStatusTransitionAllowed('RETIRED', to), false, `RETIRED → ${to} should be false`);
    }
  });
  it('returns false for APPROVED → DRAFT (not in matrix)', () => {
    assert.equal(isStatusTransitionAllowed('APPROVED', 'DRAFT'), false);
  });
  it('returns false for same-status transition (DRAFT → DRAFT)', () => {
    assert.equal(isStatusTransitionAllowed('DRAFT', 'DRAFT'), false);
  });
});

describe('PolicyRegistry.transitionStatus', () => {
  it('allows legal transition DRAFT → VALIDATING', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.t1', status: 'DRAFT' });
    registry.register(policy, now);
    assert.doesNotThrow(() => registry.transitionStatus('core.t1', 'VALIDATING'));
    assert.equal(registry.listAll()[0]!.status, 'VALIDATING');
  });

  it('allows legal transition VALIDATING → APPROVED', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.t2', status: 'VALIDATING' });
    registry.register(policy, now);
    registry.transitionStatus('core.t2', 'APPROVED');
    assert.equal(registry.listAll()[0]!.status, 'APPROVED');
  });

  it('allows APPROVED → ACTIVE and sets activeVersion', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.t3', status: 'APPROVED', version: '1.0.0' });
    registry.register(policy, now);
    registry.transitionStatus('core.t3', 'ACTIVE');
    assert.equal(registry.getActive('core.t3')?.version, '1.0.0');
  });

  it('allows ACTIVE → QUARANTINED (via quarantine)', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.t4', status: 'ACTIVE', version: '1.0.0' });
    registry.register(policy, now);
    registry.quarantine('core.t4', 'test reason');
    assert.equal(registry.getActive('core.t4'), undefined);
    assert.equal(registry.listAll()[0]!.status, 'QUARANTINED');
  });

  it('allows ACTIVE → RETIRED', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.t5', status: 'ACTIVE', version: '1.0.0' });
    registry.register(policy, now);
    registry.transitionStatus('core.t5', 'RETIRED');
    assert.equal(registry.getActive('core.t5'), undefined);
    assert.equal(registry.listAll()[0]!.status, 'RETIRED');
  });

  it('allows QUARANTINED → VALIDATING (recovery path)', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.t6', status: 'QUARANTINED', version: '1.0.0' });
    registry.register(policy, now);
    registry.transitionStatus('core.t6', 'VALIDATING');
    assert.equal(registry.listAll()[0]!.status, 'VALIDATING');
  });

  it('rejects ACTIVE → APPROVED with INVALID_TRANSITION', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.t7', status: 'ACTIVE', version: '1.0.0' });
    registry.register(policy, now);
    assert.throws(
      () => registry.transitionStatus('core.t7', 'APPROVED'),
      (err: unknown) => {
        assert.ok(err instanceof PolicyRegistryError);
        assert.equal((err as PolicyRegistryError).code, 'INVALID_TRANSITION');
        return true;
      },
    );
    // status unchanged
    assert.equal(registry.listAll()[0]!.status, 'ACTIVE');
  });

  it('rejects DRAFT → ACTIVE with INVALID_TRANSITION', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.t8', status: 'DRAFT' });
    registry.register(policy, now);
    assert.throws(
      () => registry.transitionStatus('core.t8', 'ACTIVE'),
      (err: unknown) => {
        assert.ok(err instanceof PolicyRegistryError);
        assert.equal((err as PolicyRegistryError).code, 'INVALID_TRANSITION');
        return true;
      },
    );
  });

  it('rejects RETIRED → ACTIVE with INVALID_TRANSITION', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.t9', status: 'RETIRED' });
    registry.register(policy, now);
    assert.throws(
      () => registry.transitionStatus('core.t9', 'ACTIVE'),
      (err: unknown) => {
        assert.ok(err instanceof PolicyRegistryError);
        assert.equal((err as PolicyRegistryError).code, 'INVALID_TRANSITION');
        return true;
      },
    );
  });

  it('rejects same-status transition ACTIVE → ACTIVE', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.t10', status: 'ACTIVE', version: '1.0.0' });
    registry.register(policy, now);
    assert.throws(
      () => registry.transitionStatus('core.t10', 'ACTIVE'),
      (err: unknown) => {
        assert.ok(err instanceof PolicyRegistryError);
        assert.equal((err as PolicyRegistryError).code, 'INVALID_TRANSITION');
        return true;
      },
    );
  });

  it('throws NOT_FOUND for unknown policyId', () => {
    const registry = new PolicyRegistry();
    assert.throws(
      () => registry.transitionStatus('core.nonexistent', 'ACTIVE'),
      (err: unknown) => {
        assert.ok(err instanceof PolicyRegistryError);
        assert.equal((err as PolicyRegistryError).code, 'NOT_FOUND');
        return true;
      },
    );
  });
});

// ===========================================================================
// Section: Quarantine Isolation Invariants
// ===========================================================================

describe('PolicyRegistry.quarantine - isolation invariants', () => {
  it('quarantined policy disappears from getActive', () => {
    const registry = new PolicyRegistry();
    const a = makePolicy({ policyId: 'core.qa-a', status: 'ACTIVE', version: '1.0.0' });
    registry.register(a, now);
    assert.ok(registry.getActive('core.qa-a'));
    registry.quarantine('core.qa-a', 'test');
    assert.equal(registry.getActive('core.qa-a'), undefined);
  });

  it('quarantined policy does not affect other ACTIVE policies (getActive)', () => {
    const registry = new PolicyRegistry();
    const a = makePolicy({ policyId: 'core.qb-a', status: 'ACTIVE', version: '1.0.0' });
    const b = makePolicy({ policyId: 'core.qb-b', status: 'ACTIVE', version: '1.0.0' });
    registry.register(a, now);
    registry.register(b, now);
    registry.quarantine('core.qb-a', 'test');
    assert.equal(registry.getActive('core.qb-a'), undefined);
    assert.ok(registry.getActive('core.qb-b'), 'B should still be active');
    assert.equal(registry.getActive('core.qb-b')?.policyId, 'core.qb-b');
  });

  it('quarantined policy not in queryActive results', () => {
    const registry = new PolicyRegistry();
    const a = makePolicy({ policyId: 'core.qc-a', status: 'ACTIVE', version: '1.0.0' });
    const b = makePolicy({ policyId: 'core.qc-b', status: 'ACTIVE', version: '1.0.0' });
    registry.register(a, now);
    registry.register(b, now);
    registry.quarantine('core.qc-a', 'test');
    const active = registry.queryActive({ taskProfile: 'all', level: 'all' });
    const ids = active.map((p) => p.policyId);
    assert.equal(ids.includes('core.qc-a'), false, 'quarantined should not appear in queryActive');
    assert.equal(ids.includes('core.qc-b'), true, 'B should still appear');
  });

  it('quarantined policy not in snapshotActive', () => {
    const registry = new PolicyRegistry();
    const a = makePolicy({ policyId: 'core.qd-a', status: 'ACTIVE', version: '1.0.0' });
    const b = makePolicy({ policyId: 'core.qd-b', status: 'ACTIVE', version: '1.0.0' });
    registry.register(a, now);
    registry.register(b, now);
    registry.quarantine('core.qd-a', 'test');
    const snapshot = registry.snapshotActive();
    const ids = snapshot.map((p) => p.policyId);
    assert.equal(ids.includes('core.qd-a'), false, 'quarantined should not appear in snapshotActive');
    assert.equal(ids.includes('core.qd-b'), true, 'B should still appear in snapshotActive');
  });

  it('quarantined policy still in listAll (with QUARANTINED status)', () => {
    const registry = new PolicyRegistry();
    const a = makePolicy({ policyId: 'core.qe-a', status: 'ACTIVE', version: '1.0.0' });
    registry.register(a, now);
    registry.quarantine('core.qe-a', 'test');
    const all = registry.listAll();
    const found = all.find((p) => p.policyId === 'core.qe-a');
    assert.ok(found, 'quarantined policy should still be in listAll');
    assert.equal(found!.status, 'QUARANTINED');
  });

  it('activeCount decrements after quarantine', () => {
    const registry = new PolicyRegistry();
    const a = makePolicy({ policyId: 'core.qf-a', status: 'ACTIVE', version: '1.0.0' });
    const b = makePolicy({ policyId: 'core.qf-b', status: 'ACTIVE', version: '1.0.0' });
    registry.register(a, now);
    registry.register(b, now);
    assert.equal(registry.activeCount(), 2);
    registry.quarantine('core.qf-a', 'test');
    assert.equal(registry.activeCount(), 1);
  });

  it('size unchanged after quarantine (policy not removed)', () => {
    const registry = new PolicyRegistry();
    const a = makePolicy({ policyId: 'core.qg-a', status: 'ACTIVE', version: '1.0.0' });
    registry.register(a, now);
    const sizeBefore = registry.size();
    registry.quarantine('core.qg-a', 'test');
    assert.equal(registry.size(), sizeBefore);
  });
});

// ===========================================================================
// Section: snapshotActive Reference Isolation
// ===========================================================================

describe('PolicyRegistry.snapshotActive - reference isolation', () => {
  it('snapshot remains valid after subsequent quarantine', () => {
    const registry = new PolicyRegistry();
    const a = makePolicy({ policyId: 'core.sa-a', status: 'ACTIVE', version: '1.0.0' });
    const b = makePolicy({ policyId: 'core.sa-b', status: 'ACTIVE', version: '1.0.0' });
    registry.register(a, now);
    registry.register(b, now);
    const snapshot = registry.snapshotActive();
    const snapshotIds = snapshot.map((p) => p.policyId).sort();
    // Now quarantine A after snapshot
    registry.quarantine('core.sa-a', 'test');
    // Snapshot should still contain both A and B (it was taken before quarantine)
    assert.deepEqual(snapshotIds, ['core.sa-a', 'core.sa-b']);
  });

  it('snapshot remains valid after subsequent unregister', () => {
    const registry = new PolicyRegistry();
    const a = makePolicy({ policyId: 'core.sb-a', status: 'ACTIVE', version: '1.0.0' });
    registry.register(a, now);
    const snapshot = registry.snapshotActive();
    assert.equal(snapshot.length, 1);
    registry.unregister('core.sb-a');
    // Snapshot still has 1 entry
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]!.policyId, 'core.sb-a');
  });

  it('snapshot of empty registry returns empty array', () => {
    const registry = new PolicyRegistry();
    const snapshot = registry.snapshotActive();
    assert.equal(Array.isArray(snapshot), true);
    assert.equal(snapshot.length, 0);
  });

  it('snapshot only includes ACTIVE policies (not DRAFT/QUARANTINED/RETIRED)', () => {
    const registry = new PolicyRegistry();
    registry.register(makePolicy({ policyId: 'core.sc-active', status: 'ACTIVE', version: '1.0.0' }), now);
    registry.register(makePolicy({ policyId: 'core.sc-draft', status: 'DRAFT' }), now);
    registry.register(makePolicy({ policyId: 'core.sc-quarantined', status: 'QUARANTINED' }), now);
    const snapshot = registry.snapshotActive();
    const ids = snapshot.map((p) => p.policyId);
    assert.deepEqual(ids, ['core.sc-active']);
  });
});

// ===========================================================================
// Section: getContentHash
// ===========================================================================

describe('PolicyRegistry.getContentHash', () => {
  it('returns stable hash after registration', () => {
    const registry = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.gh-a' });
    registry.register(policy, now);
    const hash1 = registry.getContentHash('core.gh-a');
    const hash2 = registry.getContentHash('core.gh-a');
    assert.ok(hash1);
    assert.equal(hash1, hash2, 'hash should be stable');
  });

  it('returns undefined for unregistered policyId', () => {
    const registry = new PolicyRegistry();
    assert.equal(registry.getContentHash('core.nonexistent'), undefined);
  });

  it('returns 64-hex string', () => {
    const registry = new PolicyRegistry();
    registry.register(makePolicy({ policyId: 'core.gh-b' }), now);
    const hash = registry.getContentHash('core.gh-b');
    assert.ok(hash);
    assert.match(hash!, /^[0-9a-f]{64}$/, 'hash should be 64-char hex');
  });

  it('same content produces same hash', () => {
    const registry1 = new PolicyRegistry();
    const registry2 = new PolicyRegistry();
    const policy = makePolicy({ policyId: 'core.gh-c' });
    registry1.register(policy, now);
    registry2.register(policy, now);
    assert.equal(registry1.getContentHash('core.gh-c'), registry2.getContentHash('core.gh-c'));
  });

  it('different content produces different hash', () => {
    const registry = new PolicyRegistry();
    registry.register(makePolicy({ policyId: 'core.gh-d', priority: 100 }), now);
    registry.register(makePolicy({ policyId: 'core.gh-e', priority: 999 }), now);
    const hashD = registry.getContentHash('core.gh-d');
    const hashE = registry.getContentHash('core.gh-e');
    assert.notEqual(hashD, hashE, 'different policies should have different hashes');
  });
});

// ===========================================================================
// Section: PolicyRegistryError
// ===========================================================================

describe('PolicyRegistryError', () => {
  it('is an Error subclass', () => {
    const err = new PolicyRegistryError('test', 'TEST_CODE');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof PolicyRegistryError);
  });

  it('has code property', () => {
    const err = new PolicyRegistryError('test message', 'MY_CODE');
    assert.equal(err.code, 'MY_CODE');
    assert.equal(err.message, 'test message');
  });

  it('has name = PolicyRegistryError', () => {
    const err = new PolicyRegistryError('test', 'CODE');
    assert.equal(err.name, 'PolicyRegistryError');
  });
});
