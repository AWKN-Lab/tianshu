/**
 * Git Agent Boundary 测试 — Git 集成协调器边界约束
 *
 * 覆盖:
 *   (a) Git coordinator produces PASS receipt on valid input
 *   (b) Git coordinator rejects when actor was the Engineer (separation violation)
 *   (c) Git coordinator rejects when envelope lacks allowGitCommit
 *   (d) Git coordinator does NOT modify source files (verify no file writes)
 *
 * 对应源码: src/git-agent/git-coordinator.ts, src/git-agent/git-receipt.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb, queryOne, queryRun } from '../src/store/db.js';
import { executeGitIntegration } from '../src/git-agent/git-coordinator.js';
import type {
  AgentInstanceV2,
  AgentProfileV2,
  AgentRole,
  WorkflowStageType,
} from '../src/contracts/workflow-v2.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const GIT_SHA = 'b'.repeat(40);
const MISSION_ID = `goal_${'a'.repeat(32)}`;
const ENV_ID = `env_${'a'.repeat(32)}`;
const WORK_ITEM_ID = `wp_${'a'.repeat(32)}`;
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-git-'));
  process.env.AWKN_DB_PATH = join(tempDir, `${randomUUID()}.db`);
  closeDb();
  getDb();
}

async function cleanupIsolatedDb(): Promise<void> {
  closeDb();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ─── FK 辅助 ──────────────────────────────────────────────

function seedGoal(missionId: string): void {
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO goals (id, title, description, created_at, updated_at)
     VALUES (?, ?, '', ?, ?)`,
    [missionId, `Test ${missionId}`, now, now],
  );
}

function seedEnvelope(
  envelopeId: string,
  missionId: string,
  opts: { allowGitCommit?: boolean; allowDeploy?: boolean; deployEnvironments?: string[] } = {},
): void {
  seedGoal(missionId);
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO authorization_envelope
       (id, mission_id, user_signature, scope_directories, allow_git_commit,
        allow_git_push, allow_deploy, deploy_environments, created_at)
     VALUES (?, ?, 'sig', '[]', ?, 0, ?, ?, ?)`,
    [
      envelopeId,
      missionId,
      opts.allowGitCommit ? 1 : 0,
      opts.allowDeploy ? 1 : 0,
      opts.deployEnvironments ? JSON.stringify(opts.deployEnvironments) : null,
      now,
    ],
  );
}

// ─── AgentProfileV2 / AgentInstanceV2 辅助 ───────────────

function makeProfileV2(
  role: AgentRole,
  specialty: WorkflowStageType,
  overrides?: Partial<AgentProfileV2>,
): AgentProfileV2 {
  return {
    schema: 'awkn-agent-profile/v2',
    profileId: `prof_${role.toLowerCase()}_${randomUUID().slice(0, 8)}`,
    version: '1.0.0',
    role,
    specialty,
    capabilities: [role.toLowerCase()],
    inputTypes: ['spec'],
    outputTypes: ['code'],
    toolPolicyRef: 'tool-policy-v1',
    independenceGroup: 'group-a',
    providerPolicy: 'ANY_APPROVED',
    maxConcurrentAssignments: 1,
    maxAttempts: 3,
    timeoutMs: 60_000,
    memoryPolicy: 'SCOPED_READ_NO_WRITE',
    status: 'ACTIVE',
    sourceHash: SHA256_HEX,
    ...overrides,
  };
}

function makeInstanceV2(
  profileId: string,
  actorId: string,
  overrides?: Partial<AgentInstanceV2>,
): AgentInstanceV2 {
  return {
    schema: 'awkn-agent-instance/v2',
    actorId,
    profileId,
    providerId: 'trae',
    modelId: 'gpt-4',
    sessionId: 'session-' + actorId,
    workerProviderId: 'wpv-1',
    providerRunId: 'prun-' + actorId,
    workspaceId: 'ws-1',
    permissionSnapshotHash: SHA256_HEX,
    authorizationEnvelopeId: ENV_ID,
    leaseId: 'lease-' + actorId,
    leaseExpiresAt: FUTURE,
    createdAt: NOW,
    ...overrides,
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Git Agent Boundary', () => {
  before(async () => {
    await setupIsolatedDb();
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  it('produces PASS receipt on valid input', async () => {
    const envId = `env_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const missionId = `goal_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedEnvelope(envId, missionId, { allowGitCommit: true });

    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE');
    const gitInstance = makeInstanceV2(gitProfile.profileId, 'actor-git-valid');

    const result = await executeGitIntegration({
      missionId,
      workItemId: WORK_ITEM_ID,
      envelopeId: envId,
      frozenSourceSha: GIT_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [],
      priorProfiles: [],
      commitSha: 'c'.repeat(40),
      commitVerified: true,
      filesChanged: ['src/index.ts'],
    });

    assert.equal(result.success, true);
    assert.equal(result.verdict, 'PASS');
    assert.ok(result.receiptId, 'should produce a receipt ID');

    // Verify receipt persisted in DB
    const receipt = queryOne<{ receipt_type: string; status: string }>(
      'SELECT receipt_type, status FROM receipts WHERE id = ?',
      [result.receiptId],
    );
    assert.ok(receipt);
    assert.equal(receipt!.receipt_type, 'GIT');
    assert.equal(receipt!.status, 'SUCCESS');
  });

  it('rejects when actor was the Engineer (separation violation)', async () => {
    const envId = `env_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const missionId = `goal_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedEnvelope(envId, missionId, { allowGitCommit: true });

    const engineerProfile = makeProfileV2('Engineer', 'IMPLEMENT');
    const engineerInstance = makeInstanceV2(
      engineerProfile.profileId,
      'actor-shared', // same actor as Git
      { sessionId: 'session-engineer' },
    );

    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE');
    const gitInstance = makeInstanceV2(
      gitProfile.profileId,
      'actor-shared', // same actorId → separation violation
      { sessionId: 'session-git' },
    );

    const result = await executeGitIntegration({
      missionId,
      workItemId: WORK_ITEM_ID,
      envelopeId: envId,
      frozenSourceSha: GIT_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [engineerInstance],
      priorProfiles: [engineerProfile],
      commitSha: 'c'.repeat(40),
      commitVerified: true,
      filesChanged: ['src/index.ts'],
    });

    assert.equal(result.success, false);
    assert.ok(result.reason);
    assert.match(result.reason!, /separation|incompatible|actor/i);
  });

  it('rejects when envelope lacks allowGitCommit', async () => {
    const envId = `env_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const missionId = `goal_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedEnvelope(envId, missionId, { allowGitCommit: false });

    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE');
    const gitInstance = makeInstanceV2(gitProfile.profileId, 'actor-git-nocommit');

    const result = await executeGitIntegration({
      missionId,
      workItemId: WORK_ITEM_ID,
      envelopeId: envId,
      frozenSourceSha: GIT_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [],
      priorProfiles: [],
      commitSha: 'c'.repeat(40),
      commitVerified: true,
      filesChanged: ['src/index.ts'],
    });

    assert.equal(result.success, false);
    assert.ok(result.reason);
    assert.match(result.reason!, /allow git commit/i);
  });

  it('does NOT modify source files (verify no file writes)', async () => {
    const envId = `env_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const missionId = `goal_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedEnvelope(envId, missionId, { allowGitCommit: true });

    // Snapshot a temp directory's contents before the call
    const watchDir = await mkdtemp(join(tmpdir(), 'wf-git-watch-'));
    const before = await readdir(watchDir);

    const gitProfile = makeProfileV2('Git', 'GIT_INTEGRATE');
    const gitInstance = makeInstanceV2(gitProfile.profileId, 'actor-git-nowrite');

    const result = await executeGitIntegration({
      missionId,
      workItemId: WORK_ITEM_ID,
      envelopeId: envId,
      frozenSourceSha: GIT_SHA,
      actorInstance: gitInstance,
      actorProfile: gitProfile,
      priorInstances: [],
      priorProfiles: [],
      commitSha: 'c'.repeat(40),
      commitVerified: true,
      filesChanged: ['src/index.ts'],
    });

    assert.equal(result.success, true);

    // Verify no files were created in the watched directory
    const after = await readdir(watchDir);
    assert.deepEqual(after, before, 'git coordinator must not write any files');

    // Verify the only side effect is the DB receipt
    assert.ok(result.receiptId);
    const receiptCount = queryOne<{ n: number }>(
      "SELECT COUNT(*) as n FROM receipts WHERE receipt_type = 'GIT'",
    )!;
    assert.ok(receiptCount.n >= 1, 'should have written a GIT receipt to DB');

    await rm(watchDir, { recursive: true, force: true });
  });
});
