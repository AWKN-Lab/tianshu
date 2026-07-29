import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { NativeGitReviewAdapter, OcrCliSpecProvider } from '../src/review/public.js';

const binaryPath = process.env.AWKN_TEST_OCR_BINARY;
const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../integrations/open-code-review');

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

it('binds the engine-local OCR producer to the Native Git frozen range', {
  skip: binaryPath === undefined ? 'AWKN_TEST_OCR_BINARY is not configured' : false,
}, async () => {
  const repository = await mkdtemp(resolve(tmpdir(), 'awkn-ocr-producer-'));
  git(repository, 'init');
  git(repository, 'config', 'user.email', 'review-kernel@example.invalid');
  git(repository, 'config', 'user.name', 'Review Kernel Test');
  mkdirSync(resolve(repository, 'src'), { recursive: true });
  writeFileSync(resolve(repository, 'src/a.ts'), 'export const value = 1;\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'base');
  const baseRef = git(repository, 'rev-parse', 'HEAD');
  writeFileSync(resolve(repository, 'src/a.ts'), 'export const value = 2;\n');
  mkdirSync(resolve(repository, 'tests'), { recursive: true });
  writeFileSync(resolve(repository, 'tests/中文 case.test.ts'), 'export const covered = true;\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'head');
  const headRef = git(repository, 'rev-parse', 'HEAD');
  const request = { repositoryRoot: repository, mode: 'COMMIT_RANGE' as const, baseRef, headRef };

  const ocr = await new OcrCliSpecProvider({
    binaryPath: binaryPath!,
    allowedBinaryRoot: integrationRoot,
    expectedVersion: '0.1.0-awkn.1',
  }).createScope(request);
  const native = await new NativeGitReviewAdapter().createScope(request);

  assert.equal(ocr.diffFingerprint, native.diffFingerprint);
  assert.deepEqual(
    ocr.files.map(({ path, oldPath, status, insertions, deletions, diffFingerprint }) => ({
      path, oldPath: oldPath ?? null, status, insertions, deletions, diffFingerprint,
    })),
    native.files.map(({ path, oldPath, status, insertions, deletions, diffFingerprint }) => ({
      path, oldPath: oldPath ?? null, status, insertions, deletions, diffFingerprint,
    })),
  );
  assert.ok(ocr.files.some((file) => file.path === 'tests/中文 case.test.ts' && file.willReview));
});
