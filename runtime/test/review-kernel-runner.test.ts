import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { parseReviewRolloutMode, runStructuredWorktreeReview, globToRegExp } from '../src/adapter/review-kernel-runner.js';
import type { LlmRouter } from '../src/llm/router.js';
import { runAgentOsMigrations } from '../src/store/agent-os-migration-registry.js';
import { NativeGitReviewAdapter, type OcrCommandRunner } from '../src/review/public.js';
import { reviewRepositoryTool } from '../src/tools/builtin/review-repository-tool.js';

const TEST_IMPLEMENTER = {
  schema: 'awkn-actor-ref/v1',
  actorId: 'model:trae:builder',
  actorType: 'assistant',
} as const;

async function emptyDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runAgentOsMigrations(db);
  return db;
}

function fakeRouter(content = '{"findings":[]}'): LlmRouter {
  return {
    async chat() {
      return {
        content,
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        provider: 'codex' as const,
        model: 'review-model',
        finishReason: 'stop' as const,
      };
    },
  } as unknown as LlmRouter;
}

describe('review kernel runtime composition', () => {
  it('parses the dedicated rollout flag fail-closed', () => {
    assert.equal(parseReviewRolloutMode(undefined), '0');
    assert.equal(parseReviewRolloutMode('shadow'), 'shadow');
    assert.throws(() => parseReviewRolloutMode('yes'), /must be 0, shadow, or enforce/);
  });

  it('refuses direct review without an implementer actor', async () => {
    await assert.rejects(reviewRepositoryTool.execute({ mode: 'enforce' }), /trusted implementer Actor is missing/);
    const properties = reviewRepositoryTool.parameters.properties as Record<string, unknown>;
    assert.equal('implementerActorId' in properties, false, 'caller must not be allowed to claim implementer identity');
  });

  it('runs a real worktree snapshot through a structured reviewer and audit store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awkn-kernel-runner-'));
    const db = new Database(':memory:');
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      git('init');
      git('config', 'user.email', 'review-test@example.invalid');
      git('config', 'user.name', 'Review Test');
      await writeFile(join(root, 'a.ts'), 'export const value = 1;\n');
      git('add', '.');
      git('commit', '-m', 'base');
      await writeFile(join(root, 'a.ts'), 'export const value = 2;\n');

      db.pragma('foreign_keys = ON');
      runAgentOsMigrations(db);
      const fakeRouter = {
        async chat() {
          return {
            content: '{"findings":[]}',
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
            provider: 'codex' as const,
            model: 'review-model',
            finishReason: 'stop' as const,
          };
        },
      } as unknown as LlmRouter;
      const result = await runStructuredWorktreeReview({
        repositoryRoot: root,
        mode: 'enforce',
        router: fakeRouter,
        reviewerProvider: 'codex',
        implementer: {
          schema: 'awkn-actor-ref/v1',
          actorId: 'model:trae:builder-model',
          actorType: 'assistant',
        },
        db,
        createdAt: '2026-07-28T08:00:00.000Z',
      });
      assert.equal(result.totalTokens, 7);
      assert.equal(result.receipt.payload.verdict.status, 'PASS');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n, 1);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM evidence_records').get() as { n: number }).n, 1);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('injects frozen contract content and evidence into SPEC review units', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awkn-kernel-contract-'));
    const db = new Database(':memory:');
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      git('init');
      git('config', 'user.email', 'review-test@example.invalid');
      git('config', 'user.name', 'Review Test');
      await writeFile(join(root, 'a.ts'), 'export const value = 1;\n');
      git('add', '.');
      git('commit', '-m', 'base');
      await writeFile(join(root, 'a.ts'), 'export const value = 2;\n');
      db.pragma('foreign_keys = ON');
      runAgentOsMigrations(db);
      const contract = 'AC-1: value must equal 2';
      let sawContract = false;
      const fakeRouter = {
        async chat(request: { messages: Array<{ content: string }> }) {
          sawContract ||= request.messages.some((message) => message.content.includes(contract));
          return {
            content: '{"findings":[]}',
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
            provider: 'codex' as const, model: 'review-model', finishReason: 'stop' as const,
          };
        },
      } as unknown as LlmRouter;
      const result = await runStructuredWorktreeReview({
        repositoryRoot: root, mode: 'enforce', router: fakeRouter, reviewerProvider: 'codex',
        implementer: { schema: 'awkn-actor-ref/v1', actorId: 'model:trae:builder', actorType: 'assistant' },
        db,
        contractArtifacts: [{
          kind: 'ACCEPTANCE_CRITERION',
          ref: {
            schema: 'awkn-object-ref/v1', objectType: 'acceptance-criterion', objectId: 'AC-1',
            schemaId: 'awkn-acceptance-criterion/v1',
            contentHash: createHash('sha256').update(contract).digest('hex'),
          },
          content: contract,
        }],
      });
      assert.equal(sawContract, true);
      assert.equal(result.receipt.payload.verdict.status, 'PASS');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM evidence_records').get() as { n: number }).n, 2);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses OCR as the authority for pinned commit-range review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awkn-kernel-ocr-range-'));
    const db = new Database(':memory:');
    try {
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
      const nativeScope = await new NativeGitReviewAdapter().createScope({
        repositoryRoot: root, mode: 'COMMIT_RANGE', baseRef, headRef,
      });
      let ocrCalls = 0;
      const runner: OcrCommandRunner = {
        async run() {
          ocrCalls++;
          const files = nativeScope.files.map((file) => ({
            path: file.path,
            old_path: file.oldPath ?? null,
            status: file.status.toLowerCase(),
            insertions: file.insertions,
            deletions: file.deletions,
            will_review: true,
            exclude_reason: null,
            rule_group_id: 1,
            diff_fingerprint: `sha256:${file.diffFingerprint}`,
          }));
          return {
            stdout: Buffer.from(JSON.stringify({
              schema: 'ocr-delegate-spec/v1', ocr_version: '1.2.3-awkn.1', repository: { root },
              target: {
                mode: 'range', from_ref: baseRef, from_oid: nativeScope.baseRef,
                to_ref: headRef, to_oid: nativeScope.headRef, merge_base_oid: nativeScope.mergeBase,
              },
              diff_fingerprint: `sha256:${nativeScope.diffFingerprint}`,
              rule_bundle_hash: `sha256:${'b'.repeat(64)}`,
              summary: {
                total_files: files.length, reviewable_files: files.length, excluded_files: 0,
                total_insertions: files.reduce((sum, file) => sum + file.insertions, 0),
                total_deletions: files.reduce((sum, file) => sum + file.deletions, 0),
              },
              files,
              rule_groups: [{
                id: 1, source: 'project', pattern: '**/*.ts', content_hash: `sha256:${'c'.repeat(64)}`,
                rule: 'Review TypeScript.', files: files.map((file) => file.path),
              }],
            })),
            stderr: new Uint8Array(), exitCode: 0,
          };
        },
      };
      db.pragma('foreign_keys = ON');
      runAgentOsMigrations(db);
      const fakeRouter = {
        async chat() {
          return {
            content: '{"findings":[]}', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
            provider: 'codex' as const, model: 'review-model', finishReason: 'stop' as const,
          };
        },
      } as unknown as LlmRouter;
      const result = await runStructuredWorktreeReview({
        repositoryRoot: root, mode: 'enforce', router: fakeRouter, reviewerProvider: 'codex',
        implementer: { schema: 'awkn-actor-ref/v1', actorId: 'model:trae:builder', actorType: 'assistant' },
        db, baseRef, headRef,
        ocr: {
          binaryPath: join(root, 'ocr'), allowedBinaryRoot: root,
          expectedVersion: '1.2.3-awkn.1', runner,
        },
      });
      assert.ok(ocrCalls >= 3);
      assert.equal(result.receipt.payload.verdict.status, 'PASS');
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('isolates prepare channel failure into a PARTIAL receipt with coverage gap', async () => {
    const db = await emptyDb();
    try {
      const result = await runStructuredWorktreeReview({
        repositoryRoot: join(tmpdir(), 'awkn-does-not-exist-' + Date.now()),
        mode: 'enforce',
        router: fakeRouter(),
        reviewerProvider: 'codex',
        implementer: TEST_IMPLEMENTER,
        db,
        createdAt: '2026-07-28T08:00:00.000Z',
      });
      assert.equal(result.receipt.payload.verdict.status, 'PARTIAL');
      assert.ok(result.receipt.payload.verdict.reasonCodes.includes('PROVIDER_INVALID'));
      assert.equal(result.receipt.status, 'PARTIAL');
      assert.equal(result.receipt.payload.coverage.plannedUnits, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n, 1);
    } finally {
      db.close();
    }
  });

  it('isolates plan channel failure into a structured PARTIAL receipt', async () => {
    const db = await emptyDb();
    const root = await mkdtemp(join(tmpdir(), 'awkn-kernel-plan-fail-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      git('init');
      git('config', 'user.email', 'review-test@example.invalid');
      git('config', 'user.name', 'Review Test');
      await writeFile(join(root, 'a.ts'), 'export const value = 1;\n');
      git('add', '.');
      git('commit', '-m', 'base');
      const result = await runStructuredWorktreeReview({
        repositoryRoot: root,
        mode: 'enforce',
        router: fakeRouter(),
        reviewerProvider: 'codex',
        implementer: TEST_IMPLEMENTER,
        db,
        createdAt: '2026-07-28T08:00:00.000Z',
        ocr: {
          binaryPath: join(root, 'ocr'),
          allowedBinaryRoot: root,
          expectedVersion: '1.2.3-awkn.1',
          runner: {
            async run() {
              return { stdout: Buffer.from('not-json'), stderr: new Uint8Array(), exitCode: 1 };
            },
          },
        },
        baseRef: '1'.repeat(40),
        headRef: '2'.repeat(40),
      });
      assert.equal(result.receipt.payload.verdict.status, 'PARTIAL');
      assert.ok(result.receipt.payload.verdict.reasonCodes.includes('PROVIDER_INVALID'));
      assert.equal(result.receipt.payload.providerError, undefined);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compiles glob patterns (**/*, *, ?) and escapes literals', () => {
    assert.match('src/memory/service.ts', globToRegExp('src/**/*.ts'));
    assert.doesNotMatch('src/memory/service.js', globToRegExp('src/**/*.ts'));
    assert.match('a/b/c.ts', globToRegExp('**/*.ts'));
    assert.match('src/x.ts', globToRegExp('src/?.ts'));
    assert.doesNotMatch('src/xy.ts', globToRegExp('src/?.ts'));
    assert.match('a[1].ts', globToRegExp('a[1].ts'));
    assert.doesNotMatch('sub/a.ts', globToRegExp('a.ts'));
  });

  it('include/exclude patterns narrow the frozen review scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awkn-kernel-scope-'));
    const db = new Database(':memory:');
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      git('init');
      git('config', 'user.email', 'review-test@example.invalid');
      git('config', 'user.name', 'Review Test');
      await writeFile(join(root, 'a.ts'), 'export const value = 1;\n');
      await writeFile(join(root, 'b.md'), '# docs\n');
      git('add', '.');
      git('commit', '-m', 'base');
      await writeFile(join(root, 'a.ts'), 'export const value = 2;\n');
      await writeFile(join(root, 'b.md'), '# docs v2\n');
      db.pragma('foreign_keys = ON');
      runAgentOsMigrations(db);
      const result = await runStructuredWorktreeReview({
        repositoryRoot: root,
        mode: 'enforce',
        router: fakeRouter(),
        reviewerProvider: 'codex',
        implementer: TEST_IMPLEMENTER,
        db,
        includePatterns: ['**/*.ts'],
        excludePatterns: ['**/*.md'],
      });
      assert.equal(result.receipt.payload.verdict.status, 'PASS');
      const planned = result.receipt.payload.coverage.plannedFiles;
      assert.deepEqual(planned, ['a.ts']);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
