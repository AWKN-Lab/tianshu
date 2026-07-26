import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalizeJson, stableHash } from '../../src/contracts/public.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures', 'contracts', 'canonical-json', 'basic');

interface GoldenInput {
  schemaId: string;
  value: unknown;
}

describe('contract golden fixtures', () => {
  it('matches normalized value, frozen canonical bytes and stable hash', () => {
    const input = JSON.parse(readFileSync(join(fixtureRoot, 'input.json'), 'utf8')) as GoldenInput;
    const normalized = JSON.parse(readFileSync(join(fixtureRoot, 'normalized.json'), 'utf8')) as unknown;
    const canonical = readFileSync(join(fixtureRoot, 'canonical.json'), 'utf8');
    const expectedHash = readFileSync(join(fixtureRoot, 'sha256.txt'), 'utf8').trim();
    const expectedValidation = JSON.parse(
      readFileSync(join(fixtureRoot, 'expected-validation.json'), 'utf8'),
    ) as { valid: boolean };

    assert.equal(expectedValidation.valid, true);
    assert.deepEqual(JSON.parse(canonicalizeJson(input.value)), normalized);
    assert.equal(canonicalizeJson(input.value), canonical);
    assert.equal(stableHash(input.schemaId, input.value), expectedHash);
  });
});
