import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('Review capability manifest', () => {
  it('binds every capability card by SHA-256 and keeps audit hybrid', async () => {
    const manifest = await readFile(resolve(repositoryRoot, 'capabilities/project/manifest.yaml'), 'utf8');
    const entries = [...manifest.matchAll(
      /- id: ([^\r\n]+)[\s\S]*?card: ([^\r\n]+)[\s\S]*?content_hash: ([0-9a-f]{64})/g,
    )];
    assert.ok(entries.length >= 5);
    for (const match of entries) {
      const card = match[2]!.trim();
      const expected = match[3]!;
      const content = await readFile(resolve(repositoryRoot, 'capabilities', card), 'utf8');
      const actual = createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
      assert.equal(actual, expected, `${match[1]!.trim()} card hash mismatch`);
    }
    assert.match(manifest, /- id: audit[\s\S]*?execution_mode: hybrid[\s\S]*?canonical_skill: awkn-审核|\n\s*canonical_skill: awkn-审核[\s\S]*?execution_mode: hybrid/);
  });
});
