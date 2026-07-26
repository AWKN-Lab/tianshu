import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalizeJson, stableHash } from '../../src/contracts/public.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'fixtures', 'contracts', 'canonical-json', 'numbers');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

describe('canonical number vectors', () => {
  it('freezes ECMAScript shortest round-trip serialization', () => {
    const input = readJson(join(root, 'input.json')) as Record<string, unknown>;
    const normalized = readJson(join(root, 'normalized.json'));
    const canonical = readFileSync(join(root, 'canonical.json'), 'utf8');
    const expectedHash = readFileSync(join(root, 'sha256.txt'), 'utf8').trim();
    const expectation = readJson(join(root, 'expected-validation.json')) as {
      valid?: unknown;
      schemaId?: unknown;
      numberSerialization?: unknown;
    };

    assert.equal(expectation.valid, true);
    assert.equal(expectation.schemaId, 'awkn-number-vectors/v1');
    assert.equal(typeof expectation.numberSerialization, 'string');
    assert.equal(Object.is(input.negativeZero, -0), true);
    assert.equal(canonicalizeJson(input), canonical);
    assert.deepEqual(JSON.parse(canonical), normalized);
    assert.equal(stableHash(String(expectation.schemaId), input), expectedHash);
  });
});
