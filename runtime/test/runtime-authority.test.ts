import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const governanceScript = readFileSync(
  resolve(repoRoot, 'scripts', 'phase4-evolve-governance.ps1'),
  'utf-8',
);
const authorityDoc = readFileSync(resolve(repoRoot, 'docs', 'runtime-authority.md'), 'utf-8');

describe('Runtime authority', () => {
  it('governance script resolves the repository root Runtime', () => {
    assert.match(governanceScript, /Join-Path \$repoRoot "runtime"/);
    assert.doesNotMatch(governanceScript, /packages\\awkn-engine-mcp\\runtime/i);
  });

  it('complete-drafts is opt-in rather than automatic', () => {
    assert.match(governanceScript, /\[switch\]\$CompleteDrafts/);
    assert.match(governanceScript, /if \(\$CompleteDrafts\)/);
  });

  it('documents one authoritative Runtime source', () => {
    assert.match(authorityDoc, /<repo>\/runtime/);
    assert.match(authorityDoc, /legacy packaged copy/i);
  });
});
