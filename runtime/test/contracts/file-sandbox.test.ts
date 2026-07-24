import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicSandboxWrite } from '../../src/sandbox/file-sandbox.js';

describe('atomicSandboxWrite', () => {
  it('writes atomically and records hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-file-sandbox-'));
    const first = atomicSandboxWrite({
      path: 'output.txt', content: 'first', workspaceRoot: root, sessionId: 's',
    });
    const second = atomicSandboxWrite({
      path: 'output.txt', content: 'second', workspaceRoot: root, sessionId: 's',
    });
    assert.equal(first.status, 'success');
    assert.equal(second.status, 'success');
    assert.ok(first.artifacts[0]?.afterSha256);
    assert.equal(second.artifacts[0]?.beforeSha256, first.artifacts[0]?.afterSha256);
    assert.equal(readFileSync(join(root, 'output.txt'), 'utf-8'), 'second');
  });
});
