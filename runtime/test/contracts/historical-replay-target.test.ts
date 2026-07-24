import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { HistoricalReplayManager } from '../../src/evolve/operational-evolution.js';
import { runHistoricalReplayTargetMigration } from '../../src/store/historical-replay-target-migration.js';
import { runMigrations } from '../../src/store/migrations.js';
import { runOperationalEvolutionMigration } from '../../src/store/operational-evolution-migration.js';

describe('historical replay target', () => {
  it('targets successful completion even when the historical Run failed', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    runOperationalEvolutionMigration(db);
    runHistoricalReplayTargetMigration(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs
       (id, workflow_name, status, input_json, output_json, started_at, finished_at, updated_at, trace_id)
       VALUES ('failed-run', 'repair', 'failed', ?, '{}', ?, ?, ?, '00112233445566778899aabbccddeeff')`,
    ).run(JSON.stringify({ userInput: 'repair this failing task' }), now, now, now);

    assert.deepEqual(new HistoricalReplayManager(db).importTerminalRuns(10), { imported: 1, skipped: 0 });
    const row = db.prepare('SELECT expected_json FROM evolution_replay_cases WHERE source_run_id = ?')
      .get('failed-run') as { expected_json: string };
    const expected = JSON.parse(row.expected_json) as { success: boolean; baselineStatus: string };
    assert.equal(expected.success, true);
    assert.equal(expected.baselineStatus, 'failed');
  });
});
