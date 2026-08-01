import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService } from '../src/memory/service.js';
import { HashEmbeddingProvider } from '../src/memory/embedding.js';
import type { MemoryEntry } from '../src/memory/types.js';

function freshService(): MemoryService {
  return new MemoryService(new HashEmbeddingProvider(), new HashEmbeddingProvider());
}

describe('hierarchical memory retrieval', () => {
  it('maintains L1 directory nodes when entries are put with a dirPath', async () => {
    const service = freshService();
    const scope = `dir-${Date.now()}-${Math.random()}`;
    await service.put({
      type: 'project_semantic',
      scopeId: scope,
      key: 'auth',
      dirPath: 'docs/api',
      content: 'OAuth2 uses PKCE with rotating refresh tokens.',
      importance: 0.9,
    });
    const apiDir = service.getLatest('project_semantic', scope, 'dir:docs/api');
    assert.ok(apiDir, 'docs/api directory node should exist');
    assert.equal(apiDir.level, 1);
    assert.equal(apiDir.dir_path, 'docs');
    assert.match(apiDir.content, /auth/);
    assert.match(apiDir.content, /Entries: 1/);

    const docsDir = service.getLatest('project_semantic', scope, 'dir:docs');
    assert.ok(docsDir, 'docs directory node should exist');
    assert.equal(docsDir.dir_path, '');

    const entry = service.getLatest('project_semantic', scope, 'auth');
    assert.equal(entry.level, 2);
    assert.equal(entry.dir_path, 'docs/api');
  });

  it('refreshes directory nodes when new children arrive', async () => {
    const service = freshService();
    const scope = `dir-refresh-${Date.now()}-${Math.random()}`;
    await service.put({ type: 'project_semantic', scopeId: scope, key: 'a', dirPath: 'docs', content: 'first doc', importance: 0.5 });
    await service.put({ type: 'project_semantic', scopeId: scope, key: 'b', dirPath: 'docs', content: 'second doc', importance: 0.6 });
    const dir = service.getLatest('project_semantic', scope, 'dir:docs');
    assert.ok(dir);
    assert.match(dir.content, /Entries: 2/);
    assert.match(dir.content, /- a/);
    assert.match(dir.content, /- b/);
  });

  it('expands matched directories into children with score propagation and trails', async () => {
    const service = freshService();
    const scope = `hier-${Date.now()}-${Math.random()}`;
    await service.put({ type: 'project_semantic', scopeId: scope, key: 'sqlite', dirPath: 'storage/db', content: 'SQLite WAL mode with foreign keys enabled', importance: 0.8 });
    await service.put({ type: 'project_semantic', scopeId: scope, key: 'postgres', dirPath: 'storage/db', content: 'pizza topping selection', importance: 0.7 });
    for (let index = 0; index < 20; index++) {
      await service.put({ type: 'project_semantic', scopeId: scope, key: `filler-${index}`, content: `unrelated filler entry number ${index}`, importance: 0.95 });
    }

    const flat = await service.search({ query: 'storage db', types: ['project_semantic'], scopeIds: [scope], limit: 10 });
    assert.ok(flat.some((r) => r.entry.memory_key === 'dir:storage/db'), 'directory node should rank in top results');
    assert.ok(!flat.some((r) => r.entry.memory_key === 'postgres'), 'postgres should stay below the flat top list');

    const hierarchical = await service.searchHierarchical({ query: 'storage db', types: ['project_semantic'], scopeIds: [scope], limit: 10 });
    const expanded = hierarchical.find((r) => r.entry.memory_key === 'postgres');
    assert.ok(expanded, 'sibling entry under matched directory should be expanded');
    assert.ok(expanded!.trail?.includes('dir:storage/db'), `trail should record the directory chain, got ${expanded!.trail?.join(',')}`);
    const withTrail = hierarchical.filter((r) => r.trail?.includes('dir:storage/db'));
    assert.ok(withTrail.length >= 1, `at least one expanded entry should carry the directory trail, got ${withTrail.length}`);
  });

  it('buildContext renders directory nodes as compact summaries and details as content', async () => {
    const service = freshService();
    const project = `ctx-hier-${Date.now()}-${Math.random()}`;
    await service.put({ type: 'project_semantic', scopeId: project, key: 'auth', dirPath: 'docs/api', content: 'OAuth2 uses PKCE with rotating refresh tokens.', importance: 0.9 });
    const context = await service.buildContext({ query: 'oauth pkce', projectId: project, sessionId: project, maxChars: 4000 });
    assert.match(context, /AWKN_MEMORY_CONTEXT/);
    assert.match(context, /dir;/);
    assert.match(context, /dir:docs\/api/);
    assert.match(context, /OAuth2 uses PKCE/);
    const dirLine = context.split('\n').find((line) => line.includes('dir;'));
    assert.ok(dirLine && dirLine.length < 400, `directory line should be compact, got ${dirLine?.length} chars`);
  });

  it('keeps plain search behaviour unchanged when hierarchical is not requested', async () => {
    const service = freshService();
    const scope = `flat-${Date.now()}-${Math.random()}`;
    await service.put({ type: 'project_semantic', scopeId: scope, key: 'k', dirPath: 'docs', content: 'flat retrieval baseline', importance: 0.8 });
    const results = await service.search({ query: 'flat retrieval baseline', types: ['project_semantic'], scopeIds: [scope], limit: 5 });
    assert.ok(results.some((r) => r.entry.memory_key === 'k'));
    const dirResults = results.filter((r) => r.entry.level === 1);
    assert.ok(dirResults.every((r) => r.trail === undefined), 'plain search should not attach trails');
  });

  it('loads memory entries with new columns from existing rows', async () => {
    const service = freshService();
    const scope = `legacy-${Date.now()}-${Math.random()}`;
    const entry = await service.put({ type: 'engineering_experience', scopeId: scope, key: 'legacy', content: 'legacy rows default to root level 2' });
    const loaded = service.read(entry.id) as MemoryEntry;
    assert.equal(loaded.dir_path, '');
    assert.equal(loaded.level, 2);
  });
});
