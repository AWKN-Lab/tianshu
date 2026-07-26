import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  AuthorizationRecordSchema,
  ExecutionEnvelopeSchema,
  GoalSpecSchema,
  ReceiptEnvelopeSchema,
  canonicalizeJson,
  stableHash,
  validateReceiptPayloadHash,
} from '../../src/contracts/public.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures', 'contracts');

type ContractSchema = z.ZodTypeAny;

interface GoldenCase {
  name: string;
  directory: string[];
  schema: ContractSchema;
  extra?: (parsed: unknown) => void;
}

const cases: GoldenCase[] = [
  {
    name: 'ExecutionEnvelope received',
    directory: ['execution-envelope', 'received'],
    schema: ExecutionEnvelopeSchema,
  },
  {
    name: 'GoalSpec core contracts',
    directory: ['goal-spec', 'core-contracts'],
    schema: GoalSpecSchema,
  },
  {
    name: 'ReceiptEnvelope policy allow',
    directory: ['receipt', 'policy-allow'],
    schema: ReceiptEnvelopeSchema,
    extra: (parsed) => {
      assert.equal(validateReceiptPayloadHash(ReceiptEnvelopeSchema.parse(parsed)), true);
    },
  },
  {
    name: 'Authorization active single use',
    directory: ['authorization', 'active-single-use'],
    schema: AuthorizationRecordSchema,
  },
];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

describe('core contract golden cases', () => {
  for (const goldenCase of cases) {
    it(`matches ${goldenCase.name}`, () => {
      const root = join(fixtureRoot, ...goldenCase.directory);
      const input = readJson(join(root, 'input.json'));
      const normalized = readJson(join(root, 'normalized.json'));
      const canonical = readFileSync(join(root, 'canonical.json'), 'utf8');
      const expectedHash = readFileSync(join(root, 'sha256.txt'), 'utf8').trim();
      const expectation = readJson(join(root, 'expected-validation.json')) as { valid?: unknown };

      assert.equal(expectation.valid, true);
      const parsed = goldenCase.schema.parse(input) as { schema: string };
      assert.deepEqual(parsed, normalized);
      assert.equal(canonicalizeJson(parsed), canonical);
      assert.equal(stableHash(parsed.schema, parsed), expectedHash);
      goldenCase.extra?.(parsed);
    });
  }
});
