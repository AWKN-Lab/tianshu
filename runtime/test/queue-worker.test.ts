import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ack, claimDue, enqueue, nack, queueStats } from '../src/store/queue.js';
import { queryRun } from '../src/store/db.js';
import { startAsyncWorker } from '../src/memory/async-worker.js';

function freshQueueName(): string {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('persistent queue & worker', { concurrency: false }, () => {
  it('enqueues, claims with a lease and acks items away', async () => {
    const queue = freshQueueName();
    const item = enqueue(queue, { hello: 'world' });
    const claimed = claimDue(queue, 'test-owner', { leaseMs: 60_000 });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.id, item.id);
    assert.equal(queueStats(queue).inProgress, 1);
    assert.ok(ack(claimed[0]!.id));
    assert.equal(queueStats(queue).inProgress, 0);
    assert.equal(claimDue(queue, 'test-owner').length, 0);
  });

  it('respects idempotency keys: duplicate enqueue is ignored', () => {
    const queue = freshQueueName();
    const key = `same-${Date.now()}-${Math.random()}`;
    enqueue(queue, { x: 1 }, { idempotencyKey: key });
    enqueue(queue, { x: 2 }, { idempotencyKey: key });
    assert.equal(claimDue(queue, 'o', { batch: 10 }).length, 1);
  });

  it('honors delay: item is not claimable before available_at', () => {
    const queue = freshQueueName();
    enqueue(queue, { x: 1 }, { delayMs: 60_000 });
    assert.equal(claimDue(queue, 'o').length, 0);
  });

  it('releases stale in_progress items whose lease expired (crash recovery)', () => {
    const queue = freshQueueName();
    const item = enqueue(queue, { x: 1 });
    claimDue(queue, 'crashed-owner', { leaseMs: 60_000 });
    queryRun(`UPDATE queue_work_items SET lease_expires_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), item.id]);
    const recovered = claimDue(queue, 'new-owner', { leaseMs: 60_000 });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.id, item.id);
    const stats = queueStats(queue);
    assert.equal(stats.inProgress, 1);
    assert.equal(stats.pending, 0);
  });

  it('retries with backoff and gives up after max attempts', () => {
    const queue = freshQueueName();
    const item = enqueue(queue, { x: 1 }, { maxAttempts: 2 });
    const first = claimDue(queue, 'o', { leaseMs: 60_000 })[0]!;
    nack(first.id, 'boom', { retryDelayMs: 0 });
    const pending = queueStats(queue).pending;
    assert.equal(pending, 1);
    const second = claimDue(queue, 'o', { leaseMs: 60_000 })[0]!;
    assert.equal(second.attempt, 1);
    nack(second.id, 'boom again');
    assert.equal(queueStats(queue).done, 1);
    assert.equal(queueStats(queue).pending, 0);
    assert.equal(item.maxAttempts, 2);
  });

  it('processes queued items and stops cleanly', async () => {
    const queue = freshQueueName();
    const processed: number[] = [];
    const handle = startAsyncWorker({
      queueName: queue,
      handler: async (item) => {
        processed.push((JSON.parse(item.payloadJson) as { n: number }).n);
      },
      pollIntervalMs: 20,
      leaseMs: 30_000,
    });
    enqueue(queue, { n: 1 });
    enqueue(queue, { n: 2 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    handle.stop();
    assert.deepEqual(processed.sort(), [1, 2]);
    assert.equal(queueStats(queue).inProgress, 0);
  });

  it('nacks failing items and keeps them for retry', async () => {
    const queue = freshQueueName();
    let attempts = 0;
    const handle = startAsyncWorker({
      queueName: queue,
      handler: () => {
        attempts++;
        throw new Error('transient failure');
      },
      pollIntervalMs: 20,
      leaseMs: 30_000,
      retryDelayMs: 5,
    });
    enqueue(queue, { n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    handle.stop();
    assert.ok(attempts >= 2, `expected retries, got ${attempts}`);
    assert.equal(queueStats(queue).done, 1);
  });
});
