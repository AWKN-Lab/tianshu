import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  NativeGitReviewAdapter,
  OcrCliSpecProvider,
  OcrRangeWorkspaceAdapter,
  createReviewTarget,
  type OcrCommandRunner,
  type OcrCommandResult,
  type ReviewSpecProviderPort,
} from '../src/review/public.js';

const created: string[] = [];
after(async () => {
  await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
});

function ocrWire(root: string): Record<string, unknown> {
  const hash = 'a'.repeat(64);
  return {
    schema: 'ocr-delegate-spec/v1',
    ocr_version: '1.2.3-awkn.1',
    repository: { root },
    target: {
      mode: 'range',
      from_ref: 'main',
      from_oid: '1'.repeat(40),
      to_ref: 'feature',
      to_oid: '2'.repeat(40),
      merge_base_oid: '3'.repeat(40),
    },
    diff_fingerprint: `sha256:${hash}`,
    rule_bundle_hash: `sha256:${'b'.repeat(64)}`,
    summary: { total_files: 1, reviewable_files: 0, excluded_files: 1, total_insertions: 1, total_deletions: 0 },
    files: [{
      path: 'src/a.test.ts',
      old_path: null,
      status: 'modified',
      insertions: 1,
      deletions: 0,
      will_review: false,
      exclude_reason: 'default_path',
      rule_group_id: 1,
      diff_fingerprint: `sha256:${hash}`,
    }],
    rule_groups: [{
      id: 1,
      source: 'project',
      pattern: '**/*.ts',
      content_hash: `sha256:${'c'.repeat(64)}`,
      rule: 'Review tests.',
      files: ['src/a.test.ts'],
    }],
  };
}

describe('OcrCliSpecProvider', () => {
  it('uses a secret-free process boundary and maps tests back into scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awkn-ocr-adapter-'));
    created.push(root);
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedArgs: readonly string[] = [];
    const runner: OcrCommandRunner = {
      async run(_file, args, options): Promise<OcrCommandResult> {
        capturedArgs = args;
        capturedEnv = options.env;
        return {
          stdout: Buffer.from(JSON.stringify(ocrWire(root))),
          stderr: new Uint8Array(),
          exitCode: 0,
        };
      },
    };
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-cross-boundary';
    try {
      const provider = new OcrCliSpecProvider({
        binaryPath: join(root, 'ocr'), allowedBinaryRoot: root, expectedVersion: '1.2.3-awkn.1', runner,
      });
      const scope = await provider.createScope({
        repositoryRoot: root,
        mode: 'COMMIT_RANGE',
        baseRef: 'main',
        headRef: 'feature',
      });
      assert.equal(scope.provider, 'open-code-review');
      assert.equal(scope.files[0]!.willReview, true, 'AWKN policy must include test files');
      assert.equal(capturedEnv?.OPENAI_API_KEY, undefined);
      assert.deepEqual(capturedArgs.slice(0, 4), ['delegate', 'spec', '--format', 'json']);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('rejects duplicate JSON keys before schema parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awkn-ocr-duplicate-'));
    created.push(root);
    const wire = JSON.stringify(ocrWire(root));
    const duplicate = wire.replace('{', '{"schema":"ocr-delegate-spec/v1",');
    const runner: OcrCommandRunner = {
      async run() { return { stdout: Buffer.from(duplicate), stderr: new Uint8Array(), exitCode: 0 }; },
    };
    const provider = new OcrCliSpecProvider({ binaryPath: join(root, 'ocr'), allowedBinaryRoot: root, runner });
    await assert.rejects(
      provider.createScope({ repositoryRoot: root, mode: 'COMMIT_RANGE', baseRef: 'main', headRef: 'feature' }),
      /trusted JSON/,
    );
  });

  it('rejects an OCR executable outside the engine-owned integration root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awkn-ocr-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'awkn-ocr-outside-'));
    created.push(root, outside);
    const provider = new OcrCliSpecProvider({
      binaryPath: join(outside, 'ocr'),
      allowedBinaryRoot: root,
      runner: { async run() { throw new Error('must not execute'); } },
    });
    await assert.rejects(
      provider.createScope({ repositoryRoot: root, mode: 'COMMIT_RANGE', baseRef: 'main', headRef: 'feature' }),
      /inside the AWKN engine/,
    );
  });
});

describe('NativeGitReviewAdapter', () => {
  it('captures staged, unstaged, and untracked test files in a worktree snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awkn-native-git-'));
    created.push(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init');
    git('config', 'user.email', 'review-test@example.invalid');
    git('config', 'user.name', 'Review Test');
    await writeFile(join(root, 'staged.ts'), 'export const staged = 1;\n');
    await writeFile(join(root, 'unstaged.ts'), 'export const unstaged = 1;\n');
    git('add', '.');
    git('commit', '-m', 'base');
    await writeFile(join(root, 'staged.ts'), 'export const staged = 2;\n');
    git('add', 'staged.ts');
    await writeFile(join(root, 'unstaged.ts'), 'export const unstaged = 2;\n');
    await writeFile(join(root, 'new.test.ts'), 'test("new", () => {});\n');

    const adapter = new NativeGitReviewAdapter();
    const scope = await adapter.createScope({ repositoryRoot: root, mode: 'WORKTREE' });
    assert.deepEqual(scope.files.map((file) => file.path).sort(), ['new.test.ts', 'staged.ts', 'unstaged.ts']);
    assert.ok(scope.files.every((file) => file.willReview));

    const target = {
      schema: 'awkn-review-target/v1' as const,
      targetId: `rtgt_${'1'.repeat(32)}`,
      mode: 'WORKTREE' as const,
      repositoryRoot: root,
      baseRef: scope.baseRef,
      headRef: scope.headRef,
      mergeBase: scope.mergeBase,
      diffFingerprint: scope.diffFingerprint,
      prdRefs: [], specRefs: [], acceptanceCriteriaRefs: [], includePatterns: [], excludePatterns: [],
      initiator: { schema: 'awkn-actor-ref/v1' as const, actorId: 'test', actorType: 'human' as const },
      implementer: { schema: 'awkn-actor-ref/v1' as const, actorId: 'builder', actorType: 'assistant' as const },
      createdAt: '2026-07-28T08:00:00.000Z',
    };
    const artifacts = await adapter.freeze(target);
    assert.equal(artifacts.targetFingerprint, scope.diffFingerprint);
    assert.equal(artifacts.files.length, 3);
  });

  it('rejects untracked symbolic links before reading their targets', async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'awkn-native-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'awkn-native-outside-'));
    created.push(root, outside);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init');
    git('config', 'user.email', 'review-test@example.invalid');
    git('config', 'user.name', 'Review Test');
    await writeFile(join(root, 'base.ts'), 'export const base = 1;\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const secret = join(outside, 'secret.ts');
    await writeFile(secret, 'export const secret = "do-not-read";\n');
    try {
      await symlink(secret, join(root, 'linked.ts'), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip('Windows symlink privilege is unavailable');
        return;
      }
      throw error;
    }
    const adapter = new NativeGitReviewAdapter();
    await assert.rejects(
      adapter.createScope({ repositoryRoot: root, mode: 'WORKTREE' }),
      /symbolic links are not reviewable|resolves outside repository/,
    );
  });
});

describe('OcrRangeWorkspaceAdapter', () => {
  it('rejects OCR and Native Git ranges with matching stats but different content hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awkn-ocr-native-binding-'));
    created.push(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init');
    git('config', 'user.email', 'review-test@example.invalid');
    git('config', 'user.name', 'Review Test');
    await writeFile(join(root, 'a.ts'), 'export const value = 1;\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const baseRef = git('rev-parse', 'HEAD');
    await writeFile(join(root, 'a.ts'), 'export const value = 2;\n');
    git('add', '.');
    git('commit', '-m', 'head');
    const headRef = git('rev-parse', 'HEAD');

    const native = new NativeGitReviewAdapter();
    const nativeScope = await native.createScope({ repositoryRoot: root, mode: 'COMMIT_RANGE', baseRef, headRef });
    const forgedScope = {
      ...nativeScope,
      provider: 'open-code-review' as const,
      providerVersion: '1.2.3-awkn.1',
      diffFingerprint: 'f'.repeat(64),
      files: nativeScope.files.map((file) => ({ ...file, diffFingerprint: 'e'.repeat(64) })),
    };
    const ocr: ReviewSpecProviderPort = {
      provider: 'open-code-review',
      async createScope() { return forgedScope; },
    };
    const target = createReviewTarget(forgedScope, {
      mode: 'COMMIT_RANGE',
      initiator: { schema: 'awkn-actor-ref/v1', actorId: 'initiator', actorType: 'human' },
      implementer: { schema: 'awkn-actor-ref/v1', actorId: 'builder', actorType: 'assistant' },
      createdAt: '2026-07-28T08:00:00.000Z',
    });
    await assert.rejects(
      new OcrRangeWorkspaceAdapter(ocr, native).freeze(target),
      /content fingerprint/,
    );
  });
});
