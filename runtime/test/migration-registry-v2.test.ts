import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { describe, it } from 'node:test';
import { runHistoricalReplayTargetMigration } from '../src/store/historical-replay-target-migration.js';
import { runAllMigrations } from '../src/store/migration-registry-v2.js';
import { runMemoryAuthorityMigration } from '../src/store/memory-authority-migration.js';
import { runMigrations as runLegacyMigrationsV1To7 } from '../src/store/migrations.js';
import { runOperationalEvolutionMigration } from '../src/store/operational-evolution-migration.js';

function versions(db: Database.Database): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>)
    .map((row) => row.version);
}

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function hasTrigger(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) !== undefined;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function withDatabase(test: (db: Database.Database) => void): void {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    test(db);
  } finally {
    db.close();
  }
}

describe('Migration Registry v2', () => {
  it('applies versions 1 through 10 in one ordered entrypoint', () => {
    withDatabase((db) => {
      runAllMigrations(db);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(hasTable(db, 'evolution_candidate_corrections'), true);
      assert.equal(hasTable(db, 'evolution_replay_runs'), true);
      assert.equal(hasTable(db, 'memory_authority_outbox'), true);
      assert.equal(hasTrigger(db, 'trg_evolution_historical_success_target'), true);
      assert.equal(hasTrigger(db, 'trg_runs_memory_authority_terminal'), true);
      assert.equal(columns(db, 'evolution_candidates').includes('source_fingerprint'), true);
      assert.equal(columns(db, 'evolution_candidates').includes('authority_rule_id'), true);
    });
  });

  it('is idempotent after version 10 is recorded', () => {
    withDatabase((db) => {
      runAllMigrations(db);
      const first = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
      runAllMigrations(db);
      const second = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
      assert.equal(first.count, 10);
      assert.equal(second.count, 10);
    });
  });

  it('upgrades an existing v7 database without rerunning earlier versions', () => {
    withDatabase((db) => {
      runLegacyMigrationsV1To7(db);
      const before = versions(db);
      assert.deepEqual(before, [1, 2, 3, 4, 5, 6, 7]);

      db.prepare(`
        INSERT INTO evolution_replay_cases(id, name, input_json, expected_json, tags_json, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run('case-existing', 'existing', '{}', '{}', '[]', '2026-07-27T04:00:00.000Z');

      runAllMigrations(db);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const existing = db.prepare('SELECT id FROM evolution_replay_cases WHERE id = ?').get('case-existing');
      assert.notEqual(existing, undefined);
    });
  });

  it('keeps deprecated wrappers ordered and free of nested future migrations', () => {
    withDatabase((db) => {
      runLegacyMigrationsV1To7(db);

      runOperationalEvolutionMigration(db);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.equal(hasTable(db, 'memory_authority_outbox'), false);

      runHistoricalReplayTargetMigration(db);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.equal(hasTable(db, 'memory_authority_outbox'), false);

      runMemoryAuthorityMigration(db);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(hasTable(db, 'memory_authority_outbox'), true);
    });
  });

  it('updates historical replay targets through the registered v9 trigger', () => {
    withDatabase((db) => {
      runAllMigrations(db);
      db.prepare(`
        INSERT INTO evolution_replay_cases(
          id, name, input_json, expected_json, tags_json, enabled, created_at, source_run_id
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        'case-trigger',
        'trigger case',
        '{}',
        '{}',
        '["historical","status","succeeded"]',
        '2026-07-27T04:00:00.000Z',
        'run-historical',
      );
      const row = db.prepare('SELECT expected_json FROM evolution_replay_cases WHERE id = ?')
        .get('case-trigger') as { expected_json: string };
      const expected = JSON.parse(row.expected_json) as { success?: boolean; baselineStatus?: string };
      assert.equal(expected.success, true);
      assert.equal(expected.baselineStatus, 'succeeded');
    });
  });
});
