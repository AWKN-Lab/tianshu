import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetricRegistry } from '../src/observability/metrics.js';

function freshRegistry(): MetricRegistry {
  return new MetricRegistry({ defaultTtlMs: 1_000, defaultMaxSeries: 3 });
}

describe('metric registry label contract', () => {
  it('rejects unknown labels and unregistered metrics', () => {
    const registry = freshRegistry();
    registry.register({ name: 'http_requests', labelNames: ['method', 'route'] });
    assert.throws(() => registry.set('http_requests', { method: 'GET', nope: 'x' }, 1));
    assert.throws(() => registry.set('missing', {}, 1));
    assert.throws(() => registry.get('http_requests', { method: 'GET', nope: 'x' }));
  });

  it('stores and reads values with canonical label ordering', () => {
    const registry = freshRegistry();
    registry.register({ name: 'http_requests', labelNames: ['method', 'route'] });
    registry.set('http_requests', { method: 'GET', route: '/a' }, 5);
    registry.set('http_requests', { route: '/a', method: 'GET' }, 7);
    assert.equal(registry.get('http_requests', { method: 'GET', route: '/a' }), 7);
  });
});

describe('metric registry series limits', () => {
  it('evicts the oldest series (LRU) once the cap is hit', () => {
    const registry = freshRegistry();
    registry.register({ name: 'series', labelNames: ['id'], maxSeries: 3 });
    registry.set('series', { id: 'a' }, 1);
    registry.set('series', { id: 'b' }, 2);
    registry.set('series', { id: 'c' }, 3);
    registry.set('series', { id: 'd' }, 4);
    assert.equal(registry.get('series', { id: 'a' }), null);
    assert.equal(registry.get('series', { id: 'b' }), 2);
    assert.equal(registry.get('series', { id: 'd' }), 4);
  });
});

describe('metric registry TTL gating', () => {
  it('returns null once the entry is older than its TTL', async () => {
    const registry = new MetricRegistry({ defaultTtlMs: 30 });
    registry.register({ name: 'temp', labelNames: [] });
    registry.set('temp', {}, 42, Date.now() - 100);
    assert.equal(registry.get('temp', {}), null);
  });

  it('getStale returns the old value flagged as stale', async () => {
    const registry = new MetricRegistry({ defaultTtlMs: 30 });
    registry.register({ name: 'temp', labelNames: [] });
    registry.set('temp', {}, 42, Date.now() - 100);
    const result = registry.getStale('temp', {});
    assert.equal(result.value, 42);
    assert.equal(result.stale, true);
  });
});

describe('metric registry SWR background refresh', () => {
  it('refreshes a stale series via refreshFn with a deadline', async () => {
    const registry = new MetricRegistry({ defaultTtlMs: 30 });
    registry.register({ name: 'upstream', labelNames: [] });
    let calls = 0;
    const value = await registry.ensureFresh(
      'upstream',
      {},
      async () => {
        calls++;
        return 99;
      },
      1_000,
    );
    assert.equal(value, 99);
    assert.equal(calls, 1);
    assert.equal(registry.get('upstream', {}), 99);
  });

  it('deduplicates concurrent refreshes of the same series', async () => {
    const registry = new MetricRegistry({ defaultTtlMs: 30 });
    registry.register({ name: 'dedup', labelNames: [] });
    let calls = 0;
    const refresh = async (): Promise<number> => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 1;
    };
    const results = await Promise.all([
      registry.ensureFresh('dedup', {}, refresh, 1_000),
      registry.ensureFresh('dedup', {}, refresh, 1_000),
      registry.ensureFresh('dedup', {}, refresh, 1_000),
    ]);
    assert.deepEqual(results, [1, 1, 1]);
    assert.equal(calls, 1);
  });

  it('times out slow collectors past the deadline and reports null', async () => {
    const registry = new MetricRegistry({ defaultTtlMs: 30 });
    registry.register({ name: 'slow', labelNames: [] });
    const value = await registry.ensureFresh(
      'slow',
      {},
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 7;
      },
      30,
    );
    assert.equal(value, null);
  });
});

describe('metric registry refreshAll', () => {
  it('collects all registered metrics in parallel within the deadline', async () => {
    const registry = freshRegistry();
    let firstDone = false;
    registry.register({
      name: 'a',
      labelNames: ['instance'],
      collect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        firstDone = true;
        return [{ instance: 'i1', value: 1 }];
      },
    });
    registry.register({
      name: 'b',
      labelNames: ['instance'],
      collect: async () => [{ instance: 'i1', value: 2 }],
    });
    await registry.refreshAll(1_000);
    assert.equal(registry.get('a', { instance: 'i1' }), 1);
    assert.equal(registry.get('b', { instance: 'i1' }), 2);
  });

  it('does not throw when one collector fails', async () => {
    const registry = freshRegistry();
    registry.register({
      name: 'broken',
      labelNames: [],
      collect: async () => {
        throw new Error('collector down');
      },
    });
    registry.register({ name: 'fine', labelNames: [], collect: async () => [{ value: 5 }] });
    await registry.refreshAll(1_000);
    assert.equal(registry.get('fine', {}), 5);
    assert.equal(registry.get('broken', {}), null);
  });
});
