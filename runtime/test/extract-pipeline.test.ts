import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getMemoryService } from '../src/memory/service.js';
import { parseOps } from '../src/memory/extract/schema.js';
import { mergeOps } from '../src/memory/extract/merge.js';
import { inputHash, runExtraction, type ExtractionDeps } from '../src/memory/extract/runner.js';
import type { ChatResponse } from '../src/llm/types.js';

function fakeChat(content: string): ExtractionDeps['chat'] {
  return async () => ({
    content,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    provider: 'trae' as const,
    model: 'fake',
    finishReason: 'stop' as const,
  });
}

function failingChat(): ExtractionDeps['chat'] {
  return async () => {
    throw new Error('llm unavailable');
  };
}

describe('memory extract schema', () => {
  it('parses valid op arrays and rejects malformed payloads', () => {
    const ops = parseOps('{"ops":[{"op":"upsert","type":"project_semantic","scopeId":"project","key":"db","content":"SQLite WAL","importance":0.7}]}');
    assert.ok(ops);
    assert.equal(ops![0]?.op, 'upsert');
    assert.equal(parseOps('{"ops":[{"op":"upsert","type":"nonsense","scopeId":"x","key":"y","content":"z"}]}'), null);
    assert.equal(parseOps('not json'), null);
    assert.equal(parseOps('{}'), null);
  });

  it('limits op count and field lengths fail-closed', () => {
    assert.equal(parseOps(`{"ops":${JSON.stringify(Array.from({ length: 9 }, () => ({ op: 'upsert', type: 'working', scopeId: 's', key: 'k', content: 'c' })))}}`), null);
  });
});

describe('memory extract merge chain', () => {
  it('keeps the latest upsert for the same key and lets delete win over upsert', () => {
    const merged = mergeOps([
      { op: 'upsert', type: 'project_semantic', scopeId: 'project', key: 'db', content: 'first version', importance: 0.8 },
      { op: 'upsert', type: 'project_semantic', scopeId: 'project', key: 'db', content: 'second version', importance: 0.3 },
      { op: 'delete', scopeId: 'project', key: 'db' },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.op, 'delete');
  });

  it('normalizes content, importance and dir paths', () => {
    const [op] = mergeOps([
      { op: 'upsert', type: 'working', scopeId: ' project ', key: ' key ', content: '  padded  ', importance: 2.5, dirPath: '/a//b/' },
    ]);
    assert.equal(op!.op, 'upsert');
    if (op!.op !== 'upsert') return;
    assert.equal(op!.scopeId, 'project');
    assert.equal(op!.key, 'key');
    assert.equal(op!.content, 'padded');
    assert.equal(op!.importance, 1);
    assert.equal(op!.dirPath, 'a/b');
  });
});

describe('memory extract runner', () => {
  it('extracts ops via LLM, applies them and records the log', async () => {
    const service = getMemoryService();
    const scope = `extract-${Date.now()}-${Math.random()}`;
    const userText = `remember that ${scope} uses Redis for caching`;
    const assistantText = 'Confirmed, noted.';
    const deps: ExtractionDeps = {
      chat: fakeChat(JSON.stringify({
        ops: [
          { op: 'upsert', type: 'project_semantic', scopeId: 'project', key: 'cache', content: `${scope} uses Redis for caching`, importance: 0.7, dirPath: 'infra' },
        ],
      })),
      put: (input) => service.put(input),
    };
    const result = await runExtraction({ userText, assistantText, projectId: 'default-project', sessionId: scope }, deps);
    assert.equal(result.degraded, false);
    assert.equal(result.applied, 1);
    assert.ok(result.ops.length === 1);
    assert.equal(service.getLatest('project_semantic', 'default-project', 'cache')?.content, `${scope} uses Redis for caching`);
    assert.equal(inputHash(userText, assistantText), inputHash(userText, assistantText));
  });

  it('is idempotent: a second run on the same conversation is skipped', async () => {
    const service = getMemoryService();
    const userText = `idempotency conversation ${Date.now()}`;
    const assistantText = 'ok';
    const deps: ExtractionDeps = { chat: fakeChat('{"ops":[]}'), put: (input) => service.put(input) };
    const first = await runExtraction({ userText, assistantText, projectId: 'p', sessionId: 's' }, deps);
    const second = await runExtraction({ userText, assistantText, projectId: 'p', sessionId: 's' }, deps);
    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
    assert.equal(second.applied, 0);
  });

  it('degrades to raw recording when the LLM is unavailable', async () => {
    const service = getMemoryService();
    const userText = `degraded conversation ${Date.now()}`;
    const result = await runExtraction(
      { userText, assistantText: 'failed reply', projectId: 'p', sessionId: 's' },
      { chat: failingChat(), put: (input) => service.put(input) },
    );
    assert.equal(result.degraded, true);
    assert.equal(result.applied, 0);
  });
});

describe('memory extract input hash', () => {
  it('is stable and input-sensitive', () => {
    const left = inputHash('a', 'b');
    const right = inputHash('a', 'b');
    const other = inputHash('a', 'c');
    assert.equal(left, right);
    assert.notEqual(left, other);
  });
});
