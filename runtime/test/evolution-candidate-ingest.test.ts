import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from '../src/store/db.js';
import {
  ingestCandidateDraft,
  ingestCandidateManifest,
  validateCandidateDraft,
  type ExperienceCandidateDraft,
  type ExperienceCandidateManifest,
} from '../src/evolve/candidate-ingest.js';

const tempRoots: string[] = [];
const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

afterEach(() => {
  closeDb();
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function createWorkspace(content: string): { root: string; draft: ExperienceCandidateDraft } {
  const root = mkdtempSync(resolve(tmpdir(), 'candidate-ingest-'));
  tempRoots.push(root);
  const contentPath = 'agents/tianhuo/04-记忆与知识/EXPERIENCE/derived/EXP-DRV-20260806-099.md';
  const absolute = resolve(root, contentPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
  return {
    root,
    draft: {
      experienceId: 'EXP-DRV-20260806-099',
      contentPath,
      title: 'candidate ingest test',
      sourceFingerprint: 'a'.repeat(64),
      sourceKind: 'test_fixture',
      correctionIds: [],
    },
  };
}

const SAFE_DRAFT = `---
schema: awkn-experience/v1
experience_id: EXP-DRV-20260806-099
status: DRAFT
needs_completion: false
security_review: sanitized
---

# Safe candidate

No credentials are present.
`;

describe('Evolution candidate ingest', () => {
  it('validates a structured and sanitized DRAFT without touching the database', () => {
    const { root, draft } = createWorkspace(SAFE_DRAFT);
    const result = ingestCandidateDraft(draft, { workspaceRoot: root, dryRun: true });
    assert.equal(result.status, 'VALIDATED');
    assert.equal(result.candidateId, null);
    assert.equal(result.sourceFingerprint, 'a'.repeat(64));
    assert.equal(result.contentHash.length, 64);
  });

  it('creates one DRAFT candidate and reuses it idempotently', () => {
    const { root, draft } = createWorkspace(SAFE_DRAFT);
    const db = getDb(resolve(root, 'runtime.db'));
    const first = ingestCandidateDraft(draft, { workspaceRoot: root, db });
    const second = ingestCandidateDraft(draft, { workspaceRoot: root, db });

    assert.equal(first.status, 'DRAFT');
    assert.ok(first.candidateId);
    assert.equal(first.reusedCandidate, false);
    assert.equal(second.candidateId, first.candidateId);
    assert.equal(second.reusedCandidate, true);

    const count = db.prepare('SELECT COUNT(*) AS count FROM evolution_candidates').get() as { count: number };
    assert.equal(count.count, 1);
  });

  it('rejects credential-like content before ingest', () => {
    const { root, draft } = createWorkspace(SAFE_DRAFT.replace(
      'No credentials are present.',
      'DB_URL=postgresql://user:plaintext-password@db.example.invalid/app',
    ));
    assert.throws(
      () => validateCandidateDraft(draft, root),
      /credential-like content|forbidden secret material/,
    );
  });

  it('rejects path traversal outside the workspace', () => {
    const { root, draft } = createWorkspace(SAFE_DRAFT);
    assert.throws(
      () => validateCandidateDraft({ ...draft, contentPath: '../outside.md' }, root),
      /escapes workspace/,
    );
  });

  it('rejects manifest duplicates before applying any candidate', () => {
    const { root, draft } = createWorkspace(SAFE_DRAFT);
    assert.throws(
      () => ingestCandidateManifest({
        schema: 'awkn-experience-candidate-manifest/v1',
        candidates: [draft, { ...draft }],
      }, { workspaceRoot: root, dryRun: true }),
      /duplicate experienceId/,
    );
  });

  it('ingests the real ten-candidate manifest into an isolated database', () => {
    const manifest = JSON.parse(readFileSync(
      resolve(repoRoot, '.better-harness/tasks/evolution-candidate-manifest-2026-08-06.json'),
      'utf-8',
    )) as ExperienceCandidateManifest;
    const dbRoot = mkdtempSync(resolve(tmpdir(), 'candidate-manifest-db-'));
    tempRoots.push(dbRoot);
    const db = getDb(resolve(dbRoot, 'runtime.db'));

    const first = ingestCandidateManifest(manifest, { workspaceRoot: repoRoot, db });
    assert.equal(first.length, 10);
    assert.ok(first.every((result) => result.status === 'DRAFT'));
    assert.ok(first.every((result) => result.reusedCandidate === false));

    const second = ingestCandidateManifest(manifest, { workspaceRoot: repoRoot, db });
    assert.equal(second.length, 10);
    assert.ok(second.every((result) => result.reusedCandidate === true));

    const count = db.prepare('SELECT COUNT(*) AS count FROM evolution_candidates').get() as { count: number };
    assert.equal(count.count, 10);
  });
});
