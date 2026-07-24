import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getMemoryService } from '../../src/memory/service.js';

describe('MemoryService', () => {
  it('versions project memories, retrieves related content and rolls back monotonically', () => {
    const service = getMemoryService();
    const scope = `project-${Date.now()}-${Math.random()}`;
    const first = service.put({
      type: 'project_semantic',
      scopeId: scope,
      key: 'architecture',
      content: 'The project uses SQLite event sourcing and Docker sandbox execution.',
      importance: 0.9,
    });
    const second = service.put({
      type: 'project_semantic',
      scopeId: scope,
      key: 'architecture',
      content: 'The project uses PostgreSQL only.',
      importance: 0.2,
    });
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(service.read(first.id)?.status, 'superseded');

    const results = service.search({ query: 'SQLite sandbox architecture', types: ['project_semantic'], scopeIds: [scope] });
    assert.equal(results[0]?.entry.id, second.id);

    const restored = service.rollback('project_semantic', scope, 'architecture', 1);
    assert.equal(restored.version, 3);
    assert.match(restored.content, /SQLite event sourcing/);
    assert.equal(service.getLatest('project_semantic', scope, 'architecture')?.id, restored.id);
  });

  it('expires working memory and excludes it from retrieval', () => {
    const service = getMemoryService();
    const scope = `session-${Date.now()}-${Math.random()}`;
    const entry = service.put({
      type: 'working',
      scopeId: scope,
      key: 'expired',
      content: 'temporary context',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(service.expireNow(), 1);
    assert.equal(service.read(entry.id)?.status, 'expired');
    assert.equal(service.search({ query: 'temporary', types: ['working'], scopeIds: [scope] }).length, 0);
  });

  it('compresses multiple entries and preserves compaction provenance', () => {
    const service = getMemoryService();
    const scope = `experience-${Date.now()}-${Math.random()}`;
    service.put({ type: 'engineering_experience', scopeId: scope, key: 'one', content: 'Always preserve existing interfaces before extending a runtime.', importance: 0.8 });
    service.put({ type: 'engineering_experience', scopeId: scope, key: 'two', content: 'Add deterministic contract tests for every state transition.', importance: 0.9 });
    const compacted = service.compress({ type: 'engineering_experience', scopeId: scope, key: 'rules' });
    assert.ok(compacted);
    assert.match(compacted!.content, /deterministic contract tests/);
    assert.equal(service.getLatest('engineering_experience', scope, 'rules')?.id, compacted!.id);
  });

  it('builds a bounded multi-layer context', () => {
    const service = getMemoryService();
    const project = `context-${Date.now()}-${Math.random()}`;
    service.put({ type: 'project_semantic', scopeId: project, key: 'database', content: 'Use SQLite WAL mode for local durability.', importance: 0.8 });
    const context = service.buildContext({ query: 'database durability', projectId: project, sessionId: project, maxChars: 1000 });
    assert.match(context, /AWKN_MEMORY_CONTEXT/);
    assert.match(context, /SQLite WAL mode/);
    assert.ok(context.length <= 1000);
  });
});
