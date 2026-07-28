/**
 * Contracts ID Uniqueness + Bundle ID Determinism Tests (Phase 6 / C04)
 *
 * Covers:
 * - AWKN_ID_PREFIXES: full prefix enumeration + format validation
 * - createAwknId: uniqueness (1000 consecutive no collision) + format
 * - awknIdSchema / AnyAwknIdSchema: positive + negative validation
 * - createSkillBundleId: determinism (same contentHash → same ID) + fallback
 * - SKILL_BUNDLE_ID_PREFIX constant consistency
 * - stableHash: determinism, key-order independence, 64-hex output
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AWKN_ID_PREFIXES,
  createAwknId,
  awknIdSchema,
  AnyAwknIdSchema,
} from '../../src/contracts/ids.js';
import {
  createSkillBundleId,
  SKILL_BUNDLE_ID_PREFIX,
} from '../../src/contracts/skill.js';
import { stableHash } from '../../src/contracts/canonical-json.js';

// 64-char hex string for contentHash tests
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_ZERO = '0'.repeat(64);
const HASH_MIXED = '0123456789abcdef'.repeat(4);

// ===========================================================================
// Section: AWKN_ID_PREFIXES enumeration
// ===========================================================================

describe('AWKN_ID_PREFIXES - prefix enumeration', () => {
  it('is a non-empty object', () => {
    assert.ok(typeof AWKN_ID_PREFIXES === 'object');
    assert.ok(Object.keys(AWKN_ID_PREFIXES).length > 0);
  });

  it('contains expected kinds', () => {
    const expectedKinds = [
      'input', 'intent', 'context', 'contextRender', 'execution', 'trace',
      'goal', 'run', 'step', 'claim', 'evidence', 'receipt', 'authorization',
      'delivery', 'outcome', 'memoryTransaction', 'candidate',
      'event', 'flagSnapshot', 'shadowDiff', 'brokerPlan', 'modelRoute',
      'toolCall', 'policyBundle', 'skillBundle',
    ];
    for (const kind of expectedKinds) {
      assert.ok(
        kind in AWKN_ID_PREFIXES,
        `expected kind "${kind}" in AWKN_ID_PREFIXES`,
      );
    }
  });

  it('all prefix values are non-empty strings', () => {
    for (const [kind, prefix] of Object.entries(AWKN_ID_PREFIXES)) {
      assert.equal(typeof prefix, 'string', `prefix for ${kind} should be string`);
      assert.ok(prefix.length > 0, `prefix for ${kind} should be non-empty`);
    }
  });

  it('skillBundle prefix is "sb"', () => {
    assert.equal(AWKN_ID_PREFIXES.skillBundle, 'sb');
  });

  it('policyBundle prefix is "pb"', () => {
    assert.equal(AWKN_ID_PREFIXES.policyBundle, 'pb');
  });

  it('goal prefix is "goal"', () => {
    assert.equal(AWKN_ID_PREFIXES.goal, 'goal');
  });

  it('execution prefix is "exec"', () => {
    assert.equal(AWKN_ID_PREFIXES.execution, 'exec');
  });
});

// ===========================================================================
// Section: createAwknId format validation
// ===========================================================================

describe('createAwknId - format validation for all prefixes', () => {
  it('generates ID matching ^<prefix>_[0-9a-f]{32}$ for each kind', () => {
    for (const [kind, prefix] of Object.entries(AWKN_ID_PREFIXES)) {
      const id = createAwknId(kind as keyof typeof AWKN_ID_PREFIXES);
      const regex = new RegExp(`^${prefix}_[0-9a-f]{32}$`);
      assert.match(
        id,
        regex,
        `ID for kind "${kind}" (prefix "${prefix}") should match ^${prefix}_[0-9a-f]{32}$, got: ${id}`,
      );
    }
  });

  it('generates 32-char lowercase hex suffix', () => {
    const id = createAwknId('goal');
    const parts = id.split('_');
    assert.equal(parts.length, 2);
    const suffix = parts[1]!;
    assert.equal(suffix.length, 32);
    assert.match(suffix, /^[0-9a-f]{32}$/);
  });

  it('prefix matches AWKN_ID_PREFIXES[kind]', () => {
    const id = createAwknId('run');
    assert.ok(id.startsWith(`${AWKN_ID_PREFIXES.run}_`));
  });

  it('generates different IDs for different kinds (different prefixes)', () => {
    const goalId = createAwknId('goal');
    const runId = createAwknId('run');
    assert.notEqual(goalId, runId);
    assert.notEqual(goalId.split('_')[0], runId.split('_')[0]);
  });
});

// ===========================================================================
// Section: createAwknId uniqueness
// ===========================================================================

describe('createAwknId - uniqueness', () => {
  it('1000 consecutive goal IDs have no collision', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(createAwknId('goal'));
    }
    assert.equal(ids.size, 1000, 'expected 1000 unique goal IDs');
  });

  it('100 consecutive run IDs have no collision', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(createAwknId('run'));
    }
    assert.equal(ids.size, 100);
  });

  it('100 consecutive exec IDs have no collision', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(createAwknId('execution'));
    }
    assert.equal(ids.size, 100);
  });

  it('100 consecutive evidence IDs have no collision', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(createAwknId('evidence'));
    }
    assert.equal(ids.size, 100);
  });

  it('IDs across different kinds do not collide', () => {
    const allIds = new Set<string>();
    const kinds = Object.keys(AWKN_ID_PREFIXES) as Array<keyof typeof AWKN_ID_PREFIXES>;
    for (const kind of kinds) {
      for (let i = 0; i < 10; i++) {
        allIds.add(createAwknId(kind));
      }
    }
    assert.equal(allIds.size, kinds.length * 10);
  });
});

// ===========================================================================
// Section: awknIdSchema validation
// ===========================================================================

describe('awknIdSchema - validation', () => {
  it('accepts valid ID with matching prefix', () => {
    const id = createAwknId('goal');
    const schema = awknIdSchema('goal');
    const result = schema.safeParse(id);
    assert.equal(result.success, true);
  });

  it('accepts valid ID for each kind', () => {
    for (const [kind, prefix] of Object.entries(AWKN_ID_PREFIXES)) {
      const id = createAwknId(kind as keyof typeof AWKN_ID_PREFIXES);
      const schema = awknIdSchema(prefix as string);
      const result = schema.safeParse(id);
      assert.equal(result.success, true, `should accept valid ${kind} ID`);
    }
  });

  it('rejects ID with wrong prefix', () => {
    const goalId = createAwknId('goal');
    const runSchema = awknIdSchema('run');
    const result = runSchema.safeParse(goalId);
    assert.equal(result.success, false);
  });

  it('rejects ID with wrong suffix length (too short)', () => {
    const shortId = 'goal_abc123';
    const schema = awknIdSchema('goal');
    const result = schema.safeParse(shortId);
    assert.equal(result.success, false);
  });

  it('rejects ID with wrong suffix length (too long)', () => {
    const longId = `goal_${'a'.repeat(40)}`;
    const schema = awknIdSchema('goal');
    const result = schema.safeParse(longId);
    assert.equal(result.success, false);
  });

  it('rejects ID with non-hex suffix', () => {
    const badId = `goal_${'g'.repeat(32)}`; // 'g' is not hex
    const schema = awknIdSchema('goal');
    const result = schema.safeParse(badId);
    assert.equal(result.success, false);
  });

  it('rejects ID with uppercase hex suffix', () => {
    const upperId = `goal_${'A'.repeat(32)}`;
    const schema = awknIdSchema('goal');
    const result = schema.safeParse(upperId);
    assert.equal(result.success, false);
  });

  it('rejects ID without underscore separator', () => {
    const noUnder = `goal${'a'.repeat(32)}`;
    const schema = awknIdSchema('goal');
    const result = schema.safeParse(noUnder);
    assert.equal(result.success, false);
  });

  it('rejects empty string', () => {
    const schema = awknIdSchema('goal');
    const result = schema.safeParse('');
    assert.equal(result.success, false);
  });

  it('rejects non-string value', () => {
    const schema = awknIdSchema('goal');
    const result = schema.safeParse(123);
    assert.equal(result.success, false);
  });
});

// ===========================================================================
// Section: AnyAwknIdSchema validation
// ===========================================================================

describe('AnyAwknIdSchema - validation', () => {
  it('accepts valid ID for each kind', () => {
    for (const kind of Object.keys(AWKN_ID_PREFIXES)) {
      const id = createAwknId(kind as keyof typeof AWKN_ID_PREFIXES);
      const result = AnyAwknIdSchema.safeParse(id);
      assert.equal(result.success, true, `should accept valid ${kind} ID: ${id}`);
    }
  });

  it('rejects ID with unknown prefix', () => {
    const unknownId = `xxx_${'a'.repeat(32)}`;
    const result = AnyAwknIdSchema.safeParse(unknownId);
    assert.equal(result.success, false);
  });

  it('rejects ID with wrong suffix length', () => {
    const shortId = 'goal_abc';
    const result = AnyAwknIdSchema.safeParse(shortId);
    assert.equal(result.success, false);
  });

  it('rejects ID without underscore', () => {
    const noUnder = `goal${'a'.repeat(32)}`;
    const result = AnyAwknIdSchema.safeParse(noUnder);
    assert.equal(result.success, false);
  });

  it('rejects non-hex suffix', () => {
    const badId = `goal_${'z'.repeat(32)}`;
    const result = AnyAwknIdSchema.safeParse(badId);
    assert.equal(result.success, false);
  });

  it('rejects empty string', () => {
    const result = AnyAwknIdSchema.safeParse('');
    assert.equal(result.success, false);
  });

  it('rejects plain string without structure', () => {
    const result = AnyAwknIdSchema.safeParse('not-an-id');
    assert.equal(result.success, false);
  });
});

// ===========================================================================
// Section: createSkillBundleId determinism
// ===========================================================================

describe('createSkillBundleId - determinism with contentHash', () => {
  it('same contentHash produces same bundle ID', () => {
    const id1 = createSkillBundleId(HASH_A);
    const id2 = createSkillBundleId(HASH_A);
    assert.equal(id1, id2, 'same contentHash should produce same bundle ID');
  });

  it('different contentHash produces different bundle ID', () => {
    const idA = createSkillBundleId(HASH_A);
    const idB = createSkillBundleId(HASH_B);
    assert.notEqual(idA, idB, 'different contentHash should produce different bundle ID');
  });

  it('bundle ID format matches ^sb_[0-9a-f]{32}$', () => {
    const id = createSkillBundleId(HASH_A);
    assert.match(id, /^sb_[0-9a-f]{32}$/);
  });

  it('bundle ID uses first 32 chars of contentHash', () => {
    const id = createSkillBundleId(HASH_MIXED);
    // HASH_MIXED = '0123456789abcdef' repeated 4 times = 64 chars
    // First 32 chars = '0123456789abcdef0123456789abcdef'
    assert.equal(id, `sb_${HASH_MIXED.slice(0, 32)}`);
  });

  it('bundle ID with HASH_ZERO is sb_ + 32 zeros', () => {
    const id = createSkillBundleId(HASH_ZERO);
    assert.equal(id, `sb_${'0'.repeat(32)}`);
  });

  it('deterministic across 100 calls with same hash', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(createSkillBundleId(HASH_A));
    }
    assert.equal(ids.size, 1, 'all 100 calls should produce the same ID');
  });
});

describe('createSkillBundleId - fallback without contentHash', () => {
  it('falls back to createAwknId(skillBundle) when no argument', () => {
    const id = createSkillBundleId();
    assert.match(id, /^sb_[0-9a-f]{32}$/);
  });

  it('falls back when contentHash is undefined', () => {
    const id = createSkillBundleId(undefined);
    assert.match(id, /^sb_[0-9a-f]{32}$/);
  });

  it('falls back when contentHash is not 64-hex (too short)', () => {
    const id = createSkillBundleId('abc123');
    assert.match(id, /^sb_[0-9a-f]{32}$/);
  });

  it('falls back when contentHash is not 64-hex (too long)', () => {
    const id = createSkillBundleId(`${'a'.repeat(70)}`);
    assert.match(id, /^sb_[0-9a-f]{32}$/);
  });

  it('falls back when contentHash contains non-hex chars', () => {
    const id = createSkillBundleId(`${'g'.repeat(64)}`);
    assert.match(id, /^sb_[0-9a-f]{32}$/);
  });

  it('falls back when contentHash is empty string', () => {
    const id = createSkillBundleId('');
    assert.match(id, /^sb_[0-9a-f]{32}$/);
  });

  it('fallback produces unique IDs (100 calls no collision)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(createSkillBundleId());
    }
    assert.equal(ids.size, 100, 'fallback should produce unique IDs');
  });

  it('fallback IDs differ from deterministic IDs', () => {
    const deterministic = createSkillBundleId(HASH_A);
    const fallback = createSkillBundleId();
    assert.notEqual(deterministic, fallback);
  });
});

// ===========================================================================
// Section: SKILL_BUNDLE_ID_PREFIX consistency
// ===========================================================================

describe('SKILL_BUNDLE_ID_PREFIX - constant consistency', () => {
  it('equals "sb"', () => {
    assert.equal(SKILL_BUNDLE_ID_PREFIX, 'sb');
  });

  it('equals AWKN_ID_PREFIXES.skillBundle', () => {
    assert.equal(SKILL_BUNDLE_ID_PREFIX, AWKN_ID_PREFIXES.skillBundle);
  });

  it('is a string', () => {
    assert.equal(typeof SKILL_BUNDLE_ID_PREFIX, 'string');
  });

  it('is non-empty', () => {
    assert.ok(SKILL_BUNDLE_ID_PREFIX.length > 0);
  });
});

// ===========================================================================
// Section: stableHash determinism
// ===========================================================================

describe('stableHash - determinism', () => {
  // schemaId must match /^awkn-[a-z0-9-]+\/v[1-9][0-9]*$/
  const SCHEMA = 'awkn-test-hash/v1';

  it('same input produces same output', () => {
    const h1 = stableHash(SCHEMA, { a: 1, b: 2 });
    const h2 = stableHash(SCHEMA, { a: 1, b: 2 });
    assert.equal(h1, h2);
  });

  it('key order does not matter ({a:1,b:2} vs {b:2,a:1})', () => {
    const h1 = stableHash(SCHEMA, { a: 1, b: 2 });
    const h2 = stableHash(SCHEMA, { b: 2, a: 1 });
    assert.equal(h1, h2, 'key order should not affect hash');
  });

  it('different content produces different output', () => {
    const h1 = stableHash(SCHEMA, { a: 1 });
    const h2 = stableHash(SCHEMA, { a: 2 });
    assert.notEqual(h1, h2);
  });

  it('different schemaId produces different output', () => {
    const h1 = stableHash('awkn-schema-a/v1', { a: 1 });
    const h2 = stableHash('awkn-schema-b/v1', { a: 1 });
    assert.notEqual(h1, h2);
  });

  it('output is 64-char lowercase hex', () => {
    const h = stableHash(SCHEMA, { a: 1 });
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('handles empty object', () => {
    const h = stableHash(SCHEMA, {});
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('handles empty array', () => {
    const h = stableHash(SCHEMA, []);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('handles null', () => {
    const h = stableHash(SCHEMA, null);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('handles string value', () => {
    const h = stableHash(SCHEMA, 'hello');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('handles number value', () => {
    const h = stableHash(SCHEMA, 42);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('handles nested object key order independence', () => {
    const h1 = stableHash(SCHEMA, { outer: { x: 1, y: 2 }, z: 3 });
    const h2 = stableHash(SCHEMA, { z: 3, outer: { y: 2, x: 1 } });
    assert.equal(h1, h2);
  });

  it('handles array element order (order matters for arrays)', () => {
    const h1 = stableHash(SCHEMA, [1, 2, 3]);
    const h2 = stableHash(SCHEMA, [3, 2, 1]);
    assert.notEqual(h1, h2, 'array order should matter');
  });

  it('100 calls with same input produce same output', () => {
    const first = stableHash(SCHEMA, { a: 1, b: 'hello' });
    for (let i = 0; i < 99; i++) {
      assert.equal(stableHash(SCHEMA, { a: 1, b: 'hello' }), first);
    }
  });
});

// ===========================================================================
// Section: createSkillBundleId + stableHash integration
// ===========================================================================

describe('createSkillBundleId + stableHash integration', () => {
  const BUNDLE_SCHEMA = 'awkn-bundle-content/v1';

  it('stableHash output (64-hex) can be used as contentHash for createSkillBundleId', () => {
    const contentHash = stableHash(BUNDLE_SCHEMA, { skills: ['a', 'b'], version: '1.0.0' });
    assert.match(contentHash, /^[0-9a-f]{64}$/);
    const bundleId = createSkillBundleId(contentHash);
    assert.match(bundleId, /^sb_[0-9a-f]{32}$/);
  });

  it('same content → same contentHash → same bundleId (end-to-end determinism)', () => {
    const content1 = { skills: ['a', 'b'], version: '1.0.0' };
    const content2 = { version: '1.0.0', skills: ['a', 'b'] }; // different key order
    const hash1 = stableHash(BUNDLE_SCHEMA, content1);
    const hash2 = stableHash(BUNDLE_SCHEMA, content2);
    assert.equal(hash1, hash2);
    const id1 = createSkillBundleId(hash1);
    const id2 = createSkillBundleId(hash2);
    assert.equal(id1, id2, 'end-to-end: same content → same bundle ID');
  });

  it('different content → different bundleId', () => {
    const hash1 = stableHash(BUNDLE_SCHEMA, { skills: ['a'] });
    const hash2 = stableHash(BUNDLE_SCHEMA, { skills: ['a', 'b'] });
    assert.notEqual(hash1, hash2);
    const id1 = createSkillBundleId(hash1);
    const id2 = createSkillBundleId(hash2);
    assert.notEqual(id1, id2);
  });
});
