import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { describe, it } from 'node:test';
import { runAgentOsMigrations } from '../src/store/agent-os-migration-registry.js';
import { runAllMigrations } from '../src/store/migration-registry-v2.js';

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

function objectNames(db: Database.Database, type: 'table' | 'index'): string[] {
  return (db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as Array<{ name: string }>)
    .map((row) => row.name);
}

function insertExecution(db: Database.Database, id = 'exec_11111111111111111111111111111111'): void {
  const now = '2026-07-27T05:00:00.000Z';
  db.prepare(`
    INSERT INTO executions(
      id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
      input_ref_json, feature_flags_ref_json, state, created_at, updated_at
    ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?)
  `).run(
    id,
    'tr_22222222222222222222222222222222',
    '{}',
    'awkn-actor-ref/v1',
    '{}',
    'awkn-execution-scope/v1',
    '{}',
    '{}',
    now,
    now,
  );
}

describe('Agent OS migration v11', () => {
  it('applies versions 1 through 11 from the startup registry', () => {
    withDatabase((db) => {
      runAgentOsMigrations(db, 11);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      const tables = objectNames(db, 'table');
      for (const table of ['executions', 'execution_snapshots', 'receipts', 'domain_events']) {
        assert.equal(tables.includes(table), true, `missing table ${table}`);
      }
      const indexes = objectNames(db, 'index');
      for (const index of [
        'idx_executions_trace',
        'idx_executions_state_updated',
        'idx_receipts_payload_dedupe',
        'idx_receipts_execution_type',
        'idx_receipts_run',
        'idx_domain_events_execution',
        'idx_domain_events_aggregate',
      ]) {
        assert.equal(indexes.includes(index), true, `missing index ${index}`);
      }
    });
  });

  it('upgrades a v10 database and is idempotent', () => {
    withDatabase((db) => {
      runAllMigrations(db);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      runAgentOsMigrations(db, 11);
      runAgentOsMigrations(db, 11);
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });
  });

  it('enforces execution state and non-negative revision constraints', () => {
    withDatabase((db) => {
      runAgentOsMigrations(db);
      insertExecution(db);
      assert.throws(() => db.prepare(`
        INSERT INTO executions(
          id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
          input_ref_json, feature_flags_ref_json, state, created_at, updated_at
        ) VALUES (?, ?, -1, '{}', 'actor/v1', '{}', 'scope/v1', '{}', '{}', 'RECEIVED', ?, ?)
      `).run(
        'exec_33333333333333333333333333333333',
        'tr_44444444444444444444444444444444',
        '2026-07-27T05:00:00.000Z',
        '2026-07-27T05:00:00.000Z',
      ));
      assert.throws(() => db.prepare("UPDATE executions SET state = 'INVALID' WHERE id = ?")
        .run('exec_11111111111111111111111111111111'));
    });
  });

  it('deduplicates receipt payloads per type and aggregate', () => {
    withDatabase((db) => {
      runAgentOsMigrations(db);
      insertExecution(db);
      const insert = db.prepare(`
        INSERT INTO receipts(
          id, receipt_type, payload_schema, execution_id, trace_id,
          aggregate_type, aggregate_id, producer_json, status,
          payload_json, payload_hash, created_at
        ) VALUES (?, 'INPUT', 'awkn-input-json-receipt/v1', ?, ?, 'input', 'input-1', '{}',
          'SUCCESS', '{}', ?, '2026-07-27T05:00:00.000Z')
      `);
      insert.run(
        'rcpt_11111111111111111111111111111111',
        'exec_11111111111111111111111111111111',
        'tr_22222222222222222222222222222222',
        'a'.repeat(64),
      );
      assert.throws(() => insert.run(
        'rcpt_22222222222222222222222222222222',
        'exec_11111111111111111111111111111111',
        'tr_22222222222222222222222222222222',
        'a'.repeat(64),
      ));
    });
  });

  it('enforces domain event idempotency and aggregate revision uniqueness', () => {
    withDatabase((db) => {
      runAgentOsMigrations(db);
      insertExecution(db);
      const insert = db.prepare(`
        INSERT INTO domain_events(
          id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_revision, execution_id, trace_id, actor_json,
          idempotency_key, payload_schema, payload_json, occurred_at
        ) VALUES (?, 'execution.received', 1, 'execution', ?, ?, ?, ?, '{}', ?,
          'awkn-execution-received/v1', '{}', '2026-07-27T05:00:00.000Z')
      `);
      insert.run(
        'evt_11111111111111111111111111111111',
        'exec_11111111111111111111111111111111',
        0,
        'exec_11111111111111111111111111111111',
        'tr_22222222222222222222222222222222',
        'execution:1:received',
      );
      assert.throws(() => insert.run(
        'evt_22222222222222222222222222222222',
        'exec_11111111111111111111111111111111',
        1,
        'exec_11111111111111111111111111111111',
        'tr_22222222222222222222222222222222',
        'execution:1:received',
      ));
      assert.throws(() => insert.run(
        'evt_33333333333333333333333333333333',
        'exec_11111111111111111111111111111111',
        0,
        'exec_11111111111111111111111111111111',
        'tr_22222222222222222222222222222222',
        'execution:1:other',
      ));
    });
  });
});
