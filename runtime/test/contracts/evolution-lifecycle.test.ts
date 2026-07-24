import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/store/migrations.js';
import { EvolutionLifecycle } from '../../src/evolve/lifecycle.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return { db, lifecycle: new EvolutionLifecycle(db) };
}

describe('EvolutionLifecycle', () => {
  it('enforces candidate state transitions', () => {
    const { lifecycle } = setup();
    const candidate = lifecycle.createCandidate({ experienceId: 'EXP-1', contentPath: 'virtual.md', contentHash: 'hash-1' });
    assert.equal(candidate.status, 'DRAFT');
    assert.equal(lifecycle.transition(candidate.id, 'VALIDATING').status, 'VALIDATING');
    assert.equal(lifecycle.transition(candidate.id, 'APPROVED').status, 'APPROVED');
    assert.throws(() => lifecycle.transition(candidate.id, 'DRAFT'), /invalid transition/);
  });

  it('activates a new version and rolls back to the previous active version', () => {
    const { lifecycle } = setup();
    const v1 = lifecycle.createCandidate({ experienceId: 'EXP-2', contentPath: 'v1.md', contentHash: 'hash-v1' });
    lifecycle.transition(v1.id, 'VALIDATING');
    lifecycle.transition(v1.id, 'APPROVED');
    lifecycle.activate(v1.id);

    const v2 = lifecycle.createCandidate({ experienceId: 'EXP-2', contentPath: 'v2.md', contentHash: 'hash-v2' });
    lifecycle.transition(v2.id, 'VALIDATING');
    lifecycle.transition(v2.id, 'APPROVED');
    lifecycle.activate(v2.id);
    assert.equal(lifecycle.read(v1.id)?.status, 'RETIRED');
    assert.equal(lifecycle.read(v2.id)?.status, 'ACTIVE');

    const restored = lifecycle.rollback('EXP-2');
    assert.equal(restored.id, v1.id);
    assert.equal(restored.status, 'ACTIVE');
    assert.equal(lifecycle.read(v2.id)?.status, 'QUARANTINED');
  });
});
