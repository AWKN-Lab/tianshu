import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('Review Kernel baseline corpus manifest', () => {
  it('keeps 30-50 uniquely identified, fail-closed scenarios', async () => {
    const url = new URL('./fixtures/review-kernel/baseline-corpus.json', import.meta.url);
    const corpus = JSON.parse(await readFile(url, 'utf8')) as {
      schema: string;
      status: string;
      minimumIndependentAnnotators: number;
      cases: Array<{ id: string; scenario: string; expected: string; blockers: string[] }>;
    };
    assert.equal(corpus.schema, 'awkn-review-baseline-corpus/v1');
    assert.equal(corpus.status, 'DESIGNED');
    assert.equal(corpus.minimumIndependentAnnotators, 2);
    assert.ok(corpus.cases.length >= 30 && corpus.cases.length <= 50);
    assert.equal(new Set(corpus.cases.map((item) => item.id)).size, corpus.cases.length);
    assert.equal(new Set(corpus.cases.map((item) => item.scenario)).size, corpus.cases.length);
    const valid = new Set(['PASS', 'FAIL', 'PARTIAL', 'STALE', 'INVALID']);
    assert.ok(corpus.cases.every((item) => valid.has(item.expected)));
  });
});
