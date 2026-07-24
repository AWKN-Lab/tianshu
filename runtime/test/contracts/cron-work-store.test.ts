import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/store/migrations.js';
import { CronWorkStore } from '../../src/cron/work-store.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cron_jobs (id, name, cron_expr, action_type, action_payload, enabled, run_count, created_at, updated_at) VALUES ('job', 'job', '* * * * *', 'http', '{}', 1, 0, ?, ?)`).run(now, now);
  return { db, store: new CronWorkStore(db) };
}

describe('CronWorkStore', () => {
  it('deduplicates the same idempotency key', () => {
    const { db, store } = setup();
    const a = store.enqueue({ jobId: 'job', idempotencyKey: 'job:slot', payload: {} });
    const b = store.enqueue({ jobId: 'job', idempotencyKey: 'job:slot', payload: {} });
    assert.equal(a.id, b.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM cron_work_items').get() as { n: number };
    assert.equal(count.n, 1);
  });

  it('allows only one worker to claim an item', () => {
    const { store } = setup();
    store.enqueue({ jobId: 'job', idempotencyKey: 'job:claim', payload: {} });
    assert.ok(store.claimNext('worker-a', 30_000));
    assert.equal(store.claimNext('worker-b', 30_000), null);
  });

  it('retries with backoff and moves to dead letter', () => {
    const { store } = setup();
    const item = store.enqueue({ jobId: 'job', idempotencyKey: 'job:retry', payload: {}, maxAttempts: 2 });
    const first = store.claimById(item.id, 'worker', 30_000)!;
    const retry = store.fail(first.id, 'worker', 'first', 0);
    assert.equal(retry.status, 'retry');
    const second = store.claimById(item.id, 'worker', 30_000, new Date(Date.now() + 1))!;
    const dead = store.fail(second.id, 'worker', 'second', 0);
    assert.equal(dead.status, 'dead');
    assert.equal(store.countDeadLetters(), 1);
  });

  it('recovers expired leases', () => {
    const { store } = setup();
    const item = store.enqueue({ jobId: 'job', idempotencyKey: 'job:expired', payload: {} });
    const started = new Date();
    store.claimById(item.id, 'worker-a', 1, started);
    const afterExpiry = new Date(started.getTime() + 10);
    assert.equal(store.recoverExpired(afterExpiry), 1);
    assert.ok(store.claimById(item.id, 'worker-b', 30_000, afterExpiry));
  });
});
