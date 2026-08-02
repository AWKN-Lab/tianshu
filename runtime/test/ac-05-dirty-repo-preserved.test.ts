/**
 * AC-05 — Dirty Repository Preserved During Workflow
 *
 * 验收标准：Git 集成阶段（executeGitIntegration）仅产出 GIT 回执，
 * 不得修改源代码或工作区文件。仓库中已有的未提交修改（dirty changes）
 * 必须在 workflow 执行后原样保留。
 *
 * 这是对 Git Agent "只读" 边界的端到端验证：
 *   - 工作区快照（文件列表 + 内容 hash）在调用前后完全一致
 *   - 唯一副作用是 DB 中的 GIT receipt
 *   - uncommitted changes（含 untracked 文件）保持不变
 *
 * 对应源码: src/git-agent/git-coordinator.ts (executeGitIntegration)
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import {
  cleanupIsolatedTestDb,
  makeEnvelopeId,
  makeInstanceV2,
  makeMissionId,
  makeProfileV2,
  makeWorkPackageId,
  seedAuthorizationEnvelope,
  setupIsolatedTestDb,
  SHA256_HEX,
  SOURCE_SHA,
} from './_ac-helpers.js';
import { executeGitIntegration } from '../src/git-agent/git-coordinator.js';
import { queryOne } from '../src/store/db.js';

// ─── 工作区快照辅助 ───────────────────────────────────────

interface WorkspaceSnapshot {
  readonly files: ReadonlyMap<string, string>; // relativePath → sha256(content)
}

async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const files = new Map<string, string>();
  await walk(root, root, files);
  return { files };
}

async function walk(
  root: string,
  current: string,
  files: Map<string, string>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, files);
    } else if (entry.isFile()) {
      const content = await readFile(fullPath);
      const rel = fullPath.slice(root.length + 1).replace(/\\/g, '/');
      files.set(rel, createHash('sha256').update(content).digest('hex'));
    }
  }
}

describe('AC-05 — Dirty Repository Preserved During Workflow', () => {
  let missionId: string;
  let envelopeId: string;
  let workDir: string;

  before(async () => {
    await setupIsolatedTestDb('wf-ac05-');
    missionId = makeMissionId();
    envelopeId = makeEnvelopeId();
    seedAuthorizationEnvelope(envelopeId, missionId, { allowGitCommit: true });
    workDir = await mkdtemp(join(tmpdir(), 'wf-ac05-repo-'));
  });

  after(async () => {
    await cleanupIsolatedTestDb();
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('preserves uncommitted modifications to tracked files', async () => {
    // Simulate a tracked source file with uncommitted modifications
    await mkdir(join(workDir, 'src'), { recursive: true });
    const dirtyContent = 'export const X = 42;\n// uncommitted edit\n';
    await writeFile(join(workDir, 'src', 'index.ts'), dirtyContent, 'utf8');

    const before = await snapshotWorkspace(workDir);

    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE', 'prof-git-ac05-mod');
    const gitInstance = makeInstanceV2(gitProfile.profileId, 'actor-git-ac05-mod', envelopeId);

    const result = await executeGitIntegration({
      missionId,
      workItemId: makeWorkPackageId(),
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [],
      priorProfiles: [],
      commitSha: 'c'.repeat(40),
      commitVerified: true,
      filesChanged: ['src/index.ts'],
    });

    assert.equal(result.success, true, `git integration should succeed: ${result.reason}`);
    assert.equal(result.verdict, 'PASS');

    const after = await snapshotWorkspace(workDir);
    assert.deepEqual(after.files, before.files, 'workspace files must be unchanged');
    // Specifically: the dirty edit is still there
    const dirtyAfter = await readFile(join(workDir, 'src', 'index.ts'), 'utf8');
    assert.equal(dirtyAfter, dirtyContent, 'uncommitted modification must be preserved');
  });

  it('preserves untracked files (new files not yet added)', async () => {
    // Untracked file in the working directory
    const untrackedPath = join(workDir, 'src', 'new-feature.ts');
    const untrackedContent = 'export const NEW = "untracked";\n';
    await writeFile(untrackedPath, untrackedContent, 'utf8');

    const before = await snapshotWorkspace(workDir);

    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE', 'prof-git-ac05-untracked');
    const gitInstance = makeInstanceV2(gitProfile.profileId, 'actor-git-ac05-untracked', envelopeId);

    const result = await executeGitIntegration({
      missionId,
      workItemId: makeWorkPackageId(),
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [],
      priorProfiles: [],
      commitSha: 'd'.repeat(40),
      commitVerified: true,
      filesChanged: [],
    });

    assert.equal(result.success, true);

    const after = await snapshotWorkspace(workDir);
    assert.deepEqual(after.files, before.files, 'untracked files must be preserved');

    const untrackedAfter = await readFile(untrackedPath, 'utf8');
    assert.equal(untrackedAfter, untrackedContent, 'untracked file content must be unchanged');
  });

  it('does not create any new files in the working directory', async () => {
    const sentinel = join(workDir, 'staged-for-commit.txt');
    await writeFile(sentinel, 'staged content\n', 'utf8');

    const before = await snapshotWorkspace(workDir);

    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE', 'prof-git-ac05-nocreate');
    const gitInstance = makeInstanceV2(gitProfile.profileId, 'actor-git-ac05-nocreate', envelopeId);

    await executeGitIntegration({
      missionId,
      workItemId: makeWorkPackageId(),
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [],
      priorProfiles: [],
      commitSha: 'e'.repeat(40),
      commitVerified: true,
      filesChanged: ['staged-for-commit.txt'],
    });

    const after = await snapshotWorkspace(workDir);
    // No new files created, no existing files modified
    assert.equal(after.files.size, before.files.size, 'file count must not change');
    for (const [rel, hash] of before.files) {
      assert.equal(after.files.get(rel), hash, `file ${rel} must not change`);
    }
  });

  it('the only side effect is a GIT receipt in the DB', async () => {
    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE', 'prof-git-ac05-receipt');
    const gitInstance = makeInstanceV2(gitProfile.profileId, 'actor-git-ac05-receipt', envelopeId);

    const result = await executeGitIntegration({
      missionId,
      workItemId: makeWorkPackageId(),
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [],
      priorProfiles: [],
      commitSha: 'f'.repeat(40),
      commitVerified: true,
      filesChanged: ['src/index.ts'],
    });

    assert.equal(result.success, true);
    assert.ok(result.receiptId, 'must produce a receipt ID');

    const receipt = queryOne<{ receipt_type: string; status: string; payload_json: string }>(
      'SELECT receipt_type, status, payload_json FROM receipts WHERE id = ?',
      [result.receiptId],
    );
    assert.ok(receipt, 'receipt must be persisted');
    assert.equal(receipt!.receipt_type, 'GIT');
    assert.equal(receipt!.status, 'SUCCESS');
    const payload = JSON.parse(receipt!.payload_json) as { verdict: string; commitSha: string };
    assert.equal(payload.verdict, 'PASS');
    assert.equal(payload.commitSha, 'f'.repeat(40));
  });

  it('preserves dirty state even when commit verification fails (FAIL verdict)', async () => {
    const dirtyPath = join(workDir, 'src', 'fail-case.ts');
    const dirtyContent = 'export const FAIL = true;\n';
    await writeFile(dirtyPath, dirtyContent, 'utf8');

    const before = await snapshotWorkspace(workDir);

    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE', 'prof-git-ac05-fail');
    const gitInstance = makeInstanceV2(gitProfile.profileId, 'actor-git-ac05-fail', envelopeId);

    const result = await executeGitIntegration({
      missionId,
      workItemId: makeWorkPackageId(),
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [],
      priorProfiles: [],
      commitSha: '0'.repeat(40),
      commitVerified: false, // → FAIL verdict
      filesChanged: ['src/fail-case.ts'],
    });

    // commitVerified=false → verdict FAIL, but the workflow still does not modify files
    assert.equal(result.success, false);
    assert.equal(result.verdict, 'FAIL');

    const after = await snapshotWorkspace(workDir);
    assert.deepEqual(after.files, before.files, 'dirty state must be preserved even on FAIL verdict');

    const dirtyAfter = await readFile(dirtyPath, 'utf8');
    assert.equal(dirtyAfter, dirtyContent, 'dirty file content must survive a FAIL verdict');
  });
});
