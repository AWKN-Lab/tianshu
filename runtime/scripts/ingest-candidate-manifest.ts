import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ingestCandidateManifest,
  type ExperienceCandidateManifest,
} from '../src/evolve/candidate-ingest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const manifestArg = arg('--manifest');
if (!manifestArg) {
  console.error('Usage: tsx scripts/ingest-candidate-manifest.ts --manifest <path> [--apply] [--db <path>] [--workspace <path>] [--receipt <path>]');
  process.exit(1);
}

const workspaceRoot = resolve(arg('--workspace') ?? resolve(__dirname, '..', '..'));
const manifestPath = resolve(workspaceRoot, manifestArg);
if (!existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ExperienceCandidateManifest;
const apply = process.argv.includes('--apply');
let close: (() => void) | undefined;

try {
  let db;
  if (apply) {
    const store = await import('../src/store/db.js');
    db = store.getDb(arg('--db') ? resolve(arg('--db')!) : undefined);
    close = store.closeDb;
  }
  const results = ingestCandidateManifest(manifest, {
    workspaceRoot,
    db,
    dryRun: !apply,
  });
  const receipt = {
    schema: 'awkn-experience-candidate-ingest-receipt/v1',
    mode: apply ? 'APPLY' : 'DRY_RUN',
    manifestPath,
    runtimeRoot: resolve(__dirname, '..'),
    generatedAt: new Date().toISOString(),
    candidateCount: results.length,
    results,
  };
  const receiptArg = arg('--receipt');
  if (receiptArg) writeFileSync(resolve(workspaceRoot, receiptArg), `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  close?.();
}
