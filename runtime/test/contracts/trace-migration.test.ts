import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/store/migrations.js';

describe('trace schema migration', () => {
  it('adds and indexes trace_id on runs', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const columns = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'trace_id'));
    const indexes = db.prepare('PRAGMA index_list(runs)').all() as Array<{ name: string }>;
    assert.ok(indexes.some((index) => index.name === 'idx_runs_trace_id'));
  });
});
