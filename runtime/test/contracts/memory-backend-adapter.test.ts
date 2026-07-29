import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AwknMemoryOsBackend,
  MemoryHttpError,
  MemoryProtocolError,
} from '../../src/memory/awkn-memory-os-backend.js';
import { inspectMemoryPayload, MemoryDlpBlockedError, guardMemoryPayload } from '../../src/memory/dlp.js';
import { LocalMemoryBackend } from '../../src/memory/local-backend.js';
import { MemoryOutbox } from '../../src/memory/outbox.js';
import { MemoryBackendRouter } from '../../src/memory/router.js';
import { getMemoryService } from '../../src/memory/service.js';

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function startMemoryServer(input: {
  emptyContext?: boolean;
  protocolMajor?: number;
  projectsStatus?: number;
} = {}): Promise<{
  url: string;
  requests: Array<{ method: string; path: string }>;
}> {
  const requests: Array<{ method: string; path: string }> = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    requests.push({ method: request.method ?? 'GET', path });
    response.setHeader('content-type', 'application/json');
    if (path === '/api/v1/protocol') {
      response.end(JSON.stringify({
        protocol: 'awkn-core-sdk/1.0', major: input.protocolMajor ?? 1, minor: 0, schema_version: 17,
        min_sdk_version: '0.9.0', features: ['context-ledger-v1', 'observed-usage-v1'],
      }));
      return;
    }
    if (path === '/api/v1/projects') {
      if (input.projectsStatus !== undefined) {
        response.statusCode = input.projectsStatus;
        response.end(JSON.stringify({ error: 'project access denied' }));
        return;
      }
      response.end(JSON.stringify([{ project_id: 'project-1' }]));
      return;
    }
    if (path === '/api/v1/context/assemble') {
      response.end(JSON.stringify(input.emptyContext
        ? { receipt_id: 'receipt-empty', item_count: 0, items: [] }
        : { receipt_id: 'receipt-1', item_count: 1, items: [{ type: 'experience', id: 'exp-1' }] }));
      return;
    }
    if (path === '/api/v1/context/receipts/receipt-1/render') {
      response.end(JSON.stringify({
        render_id: 'render-1', prompt_hash: 'hash-1', prompt: '[AWKN_MEMORY M1 experience:exp-1]\nPreserve APIs',
        items: [{ type: 'experience', id: 'exp-1', citation_key: 'M1', content_hash: 'content-1' }],
      }));
      return;
    }
    response.statusCode = 201;
    response.end(JSON.stringify({ status: 'ok' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

describe('Memory backend adapter', () => {
  it('blocks private keys and redacts bearer tokens before persistence', () => {
    assert.throws(
      () => guardMemoryPayload({ text: '-----BEGIN PRIVATE KEY-----\nsecret' }),
      MemoryDlpBlockedError,
    );
    const decision = inspectMemoryPayload({ authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' });
    assert.equal(decision.status, 'REDACTED');
    assert.match(JSON.stringify(decision.value), /REDACTED/);
  });

  it('negotiates protocol, compiles a receipt and renders immutable context', async () => {
    const { url, requests } = await startMemoryServer();
    const backend = new AwknMemoryOsBackend({ baseUrl: url, token: 'test-token', timeoutMs: 500 });
    const context = await backend.compileContext({ projectId: 'project-1', sessionId: 'session-1', query: 'upgrade API' });
    assert.equal(context.backend, 'awkn-memory-os');
    assert.equal(context.receiptId, 'receipt-1');
    assert.equal(context.renderId, 'render-1');
    assert.equal(context.items[0]?.citationKey, 'M1');
    assert.match(context.prompt, /Preserve APIs/);
    assert.deepEqual(requests.slice(0, 4).map((request) => request.path), [
      '/api/v1/protocol',
      '/api/v1/projects',
      '/api/v1/context/assemble',
      '/api/v1/context/receipts/receipt-1/render',
    ]);
  });

  it('treats an empty Context Receipt as a healthy no-memory cycle without Render', async () => {
    const { url, requests } = await startMemoryServer({ emptyContext: true });
    const backend = new AwknMemoryOsBackend({ baseUrl: url, token: 'test-token', timeoutMs: 500 });
    const context = await backend.compileContext({ projectId: 'project-1', sessionId: 'session-1', query: 'new task' });
    assert.equal(context.backend, 'awkn-memory-os');
    assert.equal(context.stale, false);
    assert.equal(context.receiptId, 'receipt-empty');
    assert.equal(context.renderId, undefined);
    assert.equal(context.prompt, '');
    assert.deepEqual(context.items, []);
    assert.equal(requests.some((request) => request.path.includes('/render')), false);
  });

  it('runs protocol, auth, context and outbox diagnosis through one entry point', async () => {
    const { url } = await startMemoryServer({ emptyContext: true });
    const directory = mkdtempSync(join(tmpdir(), 'awkn-memory-diagnose-'));
    temporaryDirectories.push(directory);
    const remote = new AwknMemoryOsBackend({
      baseUrl: url,
      token: 'test-token',
      timeoutMs: 500,
      outbox: new MemoryOutbox(join(directory, 'outbox.jsonl')),
    });
    const router = new MemoryBackendRouter({ mode: 'memory-os', remote, local: new LocalMemoryBackend() });
    const diagnostic = await router.diagnose({ projectId: 'project-1', sessionId: 'session-1', query: 'smoke' });
    assert.equal(diagnostic.remoteEnabled, true);
    assert.equal(diagnostic.error, undefined);
    assert.equal(diagnostic.remote?.capabilities.protocol?.protocol, 'awkn-core-sdk/1.0');
    assert.equal(diagnostic.remote?.context?.receiptId, 'receipt-empty');
    assert.equal(diagnostic.remote?.outbox.pending, 0);
  });

  it('falls back to stale local context on transport failure only in auto mode', async () => {
    const projectId = `fallback-${Date.now()}-${Math.random()}`;
    getMemoryService().put({
      type: 'project_semantic', scopeId: projectId, key: 'architecture',
      content: 'Preserve the existing public API during upgrades.', importance: 0.9,
    });
    const directory = mkdtempSync(join(tmpdir(), 'awkn-memory-router-'));
    temporaryDirectories.push(directory);
    const remote = new AwknMemoryOsBackend({
      baseUrl: 'http://127.0.0.1:1', timeoutMs: 30,
      outbox: new MemoryOutbox(join(directory, 'outbox.jsonl')),
    });
    const router = new MemoryBackendRouter({ mode: 'auto', remote, local: new LocalMemoryBackend() });
    const context = await router.compileAndRender({ projectId, sessionId: projectId, query: 'public API upgrade' });
    assert.equal(context.backend, 'local');
    assert.equal(context.stale, true);
    assert.match(context.prompt, /Preserve the existing public API/);
  });

  it('fails closed on transport failure in explicit memory-os mode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'awkn-memory-strict-'));
    temporaryDirectories.push(directory);
    const remote = new AwknMemoryOsBackend({
      baseUrl: 'http://127.0.0.1:1', timeoutMs: 30,
      outbox: new MemoryOutbox(join(directory, 'outbox.jsonl')),
    });
    const router = new MemoryBackendRouter({ mode: 'memory-os', remote, local: new LocalMemoryBackend() });
    await assert.rejects(
      router.compileAndRender({ projectId: 'project-1', sessionId: 'session-1', query: 'strict mode' }),
      (error: unknown) => error instanceof TypeError || (error instanceof Error && error.name === 'AbortError'),
    );
  });

  it('fails closed on 401 and 403 in auto mode', async () => {
    for (const status of [401, 403]) {
      const { url } = await startMemoryServer({ projectsStatus: status });
      const remote = new AwknMemoryOsBackend({ baseUrl: url, token: 'invalid-token', timeoutMs: 500 });
      const router = new MemoryBackendRouter({ mode: 'auto', remote, local: new LocalMemoryBackend() });
      await assert.rejects(
        router.compileAndRender({ projectId: 'project-1', sessionId: 'session-1', query: 'protected context' }),
        (error: unknown) => error instanceof MemoryHttpError && error.status === status,
      );
    }
  });

  it('fails closed on incompatible protocol in auto mode', async () => {
    const { url } = await startMemoryServer({ protocolMajor: 2 });
    const remote = new AwknMemoryOsBackend({ baseUrl: url, token: 'test-token', timeoutMs: 500 });
    const router = new MemoryBackendRouter({ mode: 'auto', remote, local: new LocalMemoryBackend() });
    await assert.rejects(
      router.compileAndRender({ projectId: 'project-1', sessionId: 'session-1', query: 'protocol check' }),
      MemoryProtocolError,
    );
  });

  it('falls back on Core 5xx in auto mode and preserves strict mode failure', async () => {
    const autoServer = await startMemoryServer({ projectsStatus: 503 });
    const autoRemote = new AwknMemoryOsBackend({ baseUrl: autoServer.url, token: 'test-token', timeoutMs: 500 });
    const autoRouter = new MemoryBackendRouter({ mode: 'auto', remote: autoRemote, local: new LocalMemoryBackend() });
    const fallback = await autoRouter.compileAndRender({
      projectId: 'project-1', sessionId: 'session-1', query: 'temporary outage',
    });
    assert.equal(fallback.backend, 'local');
    assert.equal(fallback.stale, true);

    const strictServer = await startMemoryServer({ projectsStatus: 503 });
    const strictRemote = new AwknMemoryOsBackend({ baseUrl: strictServer.url, token: 'test-token', timeoutMs: 500 });
    const strictRouter = new MemoryBackendRouter({ mode: 'memory-os', remote: strictRemote, local: new LocalMemoryBackend() });
    await assert.rejects(
      strictRouter.compileAndRender({ projectId: 'project-1', sessionId: 'session-1', query: 'temporary outage' }),
      (error: unknown) => error instanceof MemoryHttpError && error.status === 503,
    );
  });

  it('queues capture operations durably on transport failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'awkn-memory-outbox-'));
    temporaryDirectories.push(directory);
    const outbox = new MemoryOutbox(join(directory, 'outbox.jsonl'));
    const backend = new AwknMemoryOsBackend({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 30, outbox });
    const result = await backend.capture({
      projectId: 'project-1', sessionId: 'session-1', eventType: 'test.event', payload: { value: 1 },
    });
    assert.equal(result.queued, true);
    assert.ok(outbox.readValid().length >= 2, 'session start and capture are both durable');
  });
});
