import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { describe, it } from 'node:test';
import { runAgentOsMigrations } from '../src/store/agent-os-migration-registry.js';

function withDatabase(test: (db: Database.Database) => void): void {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    test(db);
  } finally {
    db.close();
  }
}

function versions(db: Database.Database): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>)
    .map((row) => row.version);
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function insertClaim(db: Database.Database, id: string, status = 'asserted'): void {
  db.prepare(`
    INSERT INTO claims(
      id, content, content_hash, originator, speaker, claim_type,
      epistemic_status, confirmation_level, authority, confidence,
      sensitivity_class, revision, created_at, updated_at
    ) VALUES (?, 'claim', ?, 'human', 'human', 'fact', ?, 'field', 0.8, 0.9,
      'internal', 0, '2026-07-27T05:00:00.000Z', '2026-07-27T05:00:00.000Z')
  `).run(id, 'a'.repeat(64), status);
}

describe('Agent OS migration v12', () => {
  it('applies versions 1 through 12 and creates Claim Ledger tables', () => {
    withDatabase((db) => {
      runAgentOsMigrations(db);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      const tables = tableNames(db);
      for (const table of [
        'claims',
        'claim_sources',
        'claim_derivations',
        'claim_confirmations',
        'claim_conflicts',
        'claim_events',
        'claim_command_idempotency',
      ]) {
        assert.equal(tables.includes(table), true, `missing table ${table}`);
      }
    });
  });

  it('upgrades a v11 database and does not repeat v12', () => {
    withDatabase((db) => {
      runAgentOsMigrations(db, 11);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      runAgentOsMigrations(db);
      runAgentOsMigrations(db);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });
  });

  it('enforces Claim status, confidence and revision constraints', () => {
    withDatabase((db) => {
      runAgentOsMigrations(db);
      assert.throws(() => insertClaim(db, 'clm_11111111111111111111111111111111', 'invalid'));
      assert.throws(() => db.prepare(`
        INSERT INTO claims(
          id, content, content_hash, originator, speaker, claim_type,
          epistemic_status, confirmation_level, authority, confidence,
          sensitivity_class, revision, created_at, updated_at
        ) VALUES (?, 'claim', ?, 'human', 'human', 'fact', 'asserted', 'field', 1.2, 0.9,
          'internal', 0, ?, ?)
      `).run(
        'clm_22222222222222222222222222222222',
        'a'.repeat(64),
        '2026-07-27T05:00:00.000Z',
        '2026-07-27T05:00:00.000Z',
      ));
      assert.throws(() => db.prepare(`
        INSERT INTO claims(
          id, content, content_hash, originator, speaker, claim_type,
          epistemic_status, confirmation_level, authority, confidence,
          sensitivity_class, revision, created_at, updated_at
        ) VALUES (?, 'claim', ?, 'human', 'human', 'fact', 'asserted', 'field', 0.8, 0.9,
          'internal', -1, ?, ?)
      `).run(
        'clm_33333333333333333333333333333333',
        'a'.repeat(64),
        '2026-07-27T05:00:00.000Z',
        '2026-07-27T05:00:00.000Z',
      ));
    });
  });

  it('enforces source ownership, derivation parents and conflict uniqueness', () => {
    withDatabase((db) => {
      runAgentOsMigrations(db);
      const first = 'clm_11111111111111111111111111111111';
      const second = 'clm_22222222222222222222222222222222';
      insertClaim(db, first);
      insertClaim(db, second);
      assert.throws(() => db.prepare(`
        INSERT INTO claim_sources(claim_id, source_id, source_kind, source_json)
        VALUES ('clm_99999999999999999999999999999999', 'source', 'external_document', '{}')
      `).run());
      db.prepare(`
        INSERT INTO claim_derivations(claim_id, parent_claim_id, derivation_type, created_at)
        VALUES (?, ?, 'derived_from', '2026-07-27T05:00:00.000Z')
      `).run(second, first);
      db.prepare(`
        INSERT INTO claim_conflicts(id, left_claim_id, right_claim_id, status, created_at)
        VALUES ('conflict-1', ?, ?, 'OPEN', '2026-07-27T05:00:00.000Z')
      `).run(first, second);
      assert.throws(() => db.prepare(`
        INSERT INTO claim_conflicts(id, left_claim_id, right_claim_id, status, created_at)
        VALUES ('conflict-2', ?, ?, 'OPEN', '2026-07-27T05:00:00.000Z')
      `).run(second, first));
    });
  });

  it('cascades Claim-owned source and event rows on deletion', () => {
    withDatabase((db) => {
      runAgentOsMigrations(db);
      const claimId = 'clm_11111111111111111111111111111111';
      insertClaim(db, claimId);
      db.prepare(`
        INSERT INTO claim_sources(claim_id, source_id, source_kind, source_json)
        VALUES (?, 'source-1', 'external_document', '{}')
      `).run(claimId);
      db.prepare(`
        INSERT INTO claim_events(
          id, claim_id, event_type, revision, payload_schema,
          payload_json, idempotency_key, created_at
        ) VALUES ('evt_11111111111111111111111111111111', ?, 'CLAIM_APPENDED', 0,
          'awkn-claim-appended/v1', '{}', 'append-1', '2026-07-27T05:00:00.000Z')
      `).run(claimId);
      db.prepare('DELETE FROM claims WHERE id = ?').run(claimId);
      const sourceCount = db.prepare('SELECT COUNT(*) AS count FROM claim_sources').get() as { count: number };
      const eventCount = db.prepare('SELECT COUNT(*) AS count FROM claim_events').get() as { count: number };
      assert.equal(sourceCount.count, 0);
      assert.equal(eventCount.count, 0);
    });
  });
});
