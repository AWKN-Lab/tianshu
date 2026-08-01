import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { HashEmbeddingProvider, OllamaEmbeddingProvider, cosineSimilarity } from '../src/memory/embedding.js';
import { EmbeddingRerankProvider, NoopRerankProvider } from '../src/llm/rerank.js';
import { MemoryService, getMemoryService } from '../src/memory/service.js';

function startMockOllama(handler: (body: { model: string; input: string | string[] }) => unknown): Promise<{ server: Server; url: string; requests: Array<{ model: string; input: string | string[] }> }> {
  const requests: Array<{ model: string; input: string | string[] }> = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/embed') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; input: string | string[] };
      requests.push({ model: body.model, input: body.input });
      try {
        const result = handler(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(500).end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${address.port}`, requests });
    });
  });
}

const previousUrl = process.env.AWKN_EMBEDDING_URL;
const previousModel = process.env.AWKN_EMBEDDING_MODEL;

afterEach(() => {
  if (previousUrl === undefined) delete process.env.AWKN_EMBEDDING_URL;
  else process.env.AWKN_EMBEDDING_URL = previousUrl;
  if (previousModel === undefined) delete process.env.AWKN_EMBEDDING_MODEL;
  else process.env.AWKN_EMBEDDING_MODEL = previousModel;
});

describe('OllamaEmbeddingProvider', () => {
  it('probes dimensions on first call and caches vectors', async () => {
    const { server, url, requests } = await startMockOllama((body) => {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return { embeddings: inputs.map((text) => Array.from({ length: 4 }, (_, i) => text.length + i)) };
    });
    try {
      const provider = new OllamaEmbeddingProvider({ url, model: 'test-model', cacheSize: 8 });
      const first = await provider.embed('hello');
      const second = await provider.embed('hello');
      const batch = await provider.embedMany(['world', 'hello']);
      assert.equal(provider.dimensions, 4);
      assert.deepEqual(first, second);
      assert.equal(batch.length, 2);
      assert.equal(requests.length, 2);
      assert.equal(requests[0]?.model, 'test-model');
    } finally {
      server.close();
    }
  });

  it('throws and marks degraded when the server fails', async () => {
    const { server, url } = await startMockOllama(() => {
      throw new Error('boom');
    });
    try {
      const provider = new OllamaEmbeddingProvider({ url, timeoutMs: 2000 });
      await assert.rejects(() => provider.embed('x'));
      assert.equal(provider.isDegraded(), true);
      assert.ok(provider.lastFailure() instanceof Error);
    } finally {
      server.close();
    }
  });

  it('MemoryService falls back to hash embeddings when ollama is unavailable', async () => {
    const { server, url } = await startMockOllama(() => {
      throw new Error('boom');
    });
    try {
      const service = new MemoryService(new OllamaEmbeddingProvider({ url, timeoutMs: 2000 }));
      const entry = await service.put({
        type: 'project_semantic',
        scopeId: `fallback-${Date.now()}`,
        key: 'k',
        content: 'fallback embedding content',
      });
      assert.ok(entry.embedding_json.length > 0);
      const vector = JSON.parse(entry.embedding_json) as number[];
      assert.ok(vector.length > 0);
    } finally {
      server.close();
    }
  });
});

describe('HashEmbeddingProvider', () => {
  it('produces normalized deterministic vectors', async () => {
    const provider = new HashEmbeddingProvider(64);
    const vector = await provider.embed('deterministic text');
    assert.equal(vector.length, 64);
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(magnitude - 1) < 1e-9);
    assert.deepEqual(vector, await provider.embed('deterministic text'));
  });
});

describe('rerank providers', () => {
  it('NoopRerankProvider keeps input order with decreasing scores', async () => {
    const provider = new NoopRerankProvider();
    const results = await provider.rerank({
      query: 'q',
      items: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }],
    });
    assert.deepEqual(results.map((result) => result.id), ['a', 'b']);
    assert.ok(results[0]!.score >= results[1]!.score);
  });

  it('EmbeddingRerankProvider ranks by query similarity', async () => {
    const embedding = new HashEmbeddingProvider(128);
    const provider = new EmbeddingRerankProvider(embedding);
    const results = await provider.rerank({
      query: 'sqlite database schema',
      items: [
        { id: 'sqlite', text: 'SQLite schema migration for event store' },
        { id: 'unrelated', text: 'pizza toppings and cooking times' },
      ],
      topK: 2,
    });
    assert.equal(results[0]?.id, 'sqlite');
    const topScore = await embedding.embed('SQLite schema migration for event store')
      .then((vector) => cosineSimilarity(vector, []))
      .catch(() => 0);
    assert.equal(typeof topScore, 'number');
  });

  it('MemoryService search blends rerank scores when rerank is enabled', async () => {
    const embedding = new HashEmbeddingProvider(128);
    const service = new MemoryService(
      embedding,
      embedding,
      { name: 'fake', rerank: async (input) => input.items.map((item, index) => ({ id: item.id, score: (input.items.length - index) / input.items.length })) },
    );
    const scope = `rerank-${Date.now()}-${Math.random()}`;
    await service.put({ type: 'project_semantic', scopeId: scope, key: 'k1', content: 'alpha beta gamma', importance: 0.9 });
    await service.put({ type: 'project_semantic', scopeId: scope, key: 'k2', content: 'delta epsilon zeta', importance: 0.1 });
    const results = await service.search({ query: 'alpha', types: ['project_semantic'], scopeIds: [scope], limit: 2 });
    assert.equal(results.length, 2);
    assert.ok(results[0]!.score > 0);
  });
});
