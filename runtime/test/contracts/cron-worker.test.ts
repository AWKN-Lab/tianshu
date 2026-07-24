import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { CronWorker } from '../../src/cron/worker.js';
import { CronWorkStore } from '../../src/cron/work-store.js';
import { runMigrations } from '../../src/store/migrations.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cron_jobs (id, name, cron_expr, action_type, action_payload, enabled, run_count, created_at, updated_at) VALUES ('job', 'job', '* * * * *', 'http', '{}', 1, 0, ?, ?)`).run(now, now);
  return db;
}

describe('CronWorker', () => {
  it('executes a leased work item once', async () => {
    const db = setup();
    let calls = 0;
    const store = new CronWorkStore(db);
    const item = store.enqueue({ jobId: 'job', idempotencyKey: 'job:once', payload: { actionType: 'http', payload: { url: 'https://example.invalid' } } });
    const worker = new CronWorker(db, async () => { calls++; return 'ok'; }, 'worker');
    assert.deepEqual(await worker.processById(item.id), { ok: true });
    assert.deepEqual(await worker.processById(item.id), { ok: true });
    assert.equal(calls, 1);
  });
});
