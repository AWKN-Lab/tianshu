/**
 * Release Bundle 测试 — Release Bundle 创建协调器
 *
 * 覆盖:
 *   (a) createReleaseBundle succeeds when all gate receipts are PASS
 *   (b) rejects when test receipt is FAIL
 *   (c) rejects when review receipt missing
 *   (d) rejects when actor was Engineer (separation)
 *   (e) release bundle binds correct frozenSourceSha + artifactDigest + sbomDigest
 *
 * 对应源码: src/release/release-coordinator.ts, src/release/contracts.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb, queryOne, queryRun } from '../src/store/db.js';
import { createReleaseBundle } from '../src/release/release-coordinator.js';
import { receiptPayloadHash } from '../src/contracts/receipts.js';
import type { ArtifactBuilderPort } from '../src/release/artifact-builder-port.js';
import type { SbomPort } from '../src/release/sbom-port.js';
import type {
  AgentInstanceV2,
  AgentProfileV2,
  AgentRole,
  WorkflowStageType,
} from '../src/contracts/workflow-v2.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const ARTIFACT_DIGEST = 'd'.repeat(64);
const SBOM_DIGEST = 'f'.repeat(64);
const SOURCE_SHA = 'b'.repeat(40);
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-release-'));
  process.env.AWKN_DB_PATH = join(tempDir, `${randomUUID()}.db`);
  process.env.AWKN_RELEASE_AGENT_V1 = 'enforce';
  closeDb();
  getDb();
}

async function cleanupIsolatedDb(): Promise<void> {
  closeDb();
  delete process.env.AWKN_RELEASE_AGENT_V1;
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

function seedEnvelope(envelopeId: string, missionId: string): void {
  seedGoal(missionId);
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO authorization_envelope
       (id, mission_id, user_signature, scope_directories, created_at)
     VALUES (?, ?, 'sig', '[]', ?)`,
    [envelopeId, missionId, now],
  );
}

function seedGateReceipt(
  receiptId: string,
  missionId: string,
  envelopeId: string,
  verdict: string,
  status: string = 'SUCCESS',
): void {
  const executionId = `exec_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  const traceId = `tr_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO executions
       (id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
        input_ref_json, feature_flags_ref_json, state, created_at, updated_at)
     VALUES (?, ?, 0, '{}', 'awkn-actor-ref/v1', '{}', 'awkn-execution-scope/v1',
             '{}', '{}', 'RECEIVED', ?, ?)`,
    [executionId, traceId, now, now],
  );
  const payload = {
    missionId,
    envelopeId,
    frozenTargetHash: SHA256_HEX,
    verdict,
    toolsUsed: ['tool-1'],
    evidenceRefs: ['ev-1'],
  };
  const payloadSchema = 'awkn-workflow-receipt/v1';
  const payloadHash = receiptPayloadHash(payloadSchema, payload);
  const producer = { schema: 'awkn-actor-ref/v1', actorId: 'actor-gate', actorType: 'assistant' as const };
  queryRun(
    `INSERT INTO receipts
       (id, receipt_type, payload_schema, execution_id, trace_id,
        aggregate_type, aggregate_id, producer_json, status,
        payload_json, payload_hash, artifact_refs_json, created_at)
     VALUES (?, 'GATE', ?, ?, ?, 'gate', ?, ?, ?, ?, ?, '[]', ?)`,
    [
      receiptId,
      payloadSchema,
      executionId,
      traceId,
      receiptId,
      JSON.stringify(producer),
      status,
      JSON.stringify(payload),
      payloadHash,
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
    outputTypes: ['release'],
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
  envelopeId: string,
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
    authorizationEnvelopeId: envelopeId,
    leaseId: 'lease-' + actorId,
    leaseExpiresAt: FUTURE,
    createdAt: NOW,
    ...overrides,
  };
}

// ─── Mock Ports ───────────────────────────────────────────

function makeMockArtifactBuilder(digest: string = ARTIFACT_DIGEST): ArtifactBuilderPort {
  return {
    builderId: 'mock-builder',
    async build() {
      return {
        artifactDigest: digest,
        artifacts: [
          {
            artifactType: 'binary',
            artifactPath: '/dist/app.js',
            artifactDigest: 'e'.repeat(64),
            artifactSizeBytes: 1024,
          },
        ],
      };
    },
  };
}

function makeMockSbom(digest: string = SBOM_DIGEST): SbomPort {
  return {
    generatorId: 'mock-sbom',
    async generate() {
      return { sbomDigest: digest, sbomContent: '{"bomFormat":"CycloneDX"}' };
    },
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Release Bundle', () => {
  let missionId: string;
  let envelopeId: string;

  before(async () => {
    await setupIsolatedDb();
    missionId = `goal_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    envelopeId = `env_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedEnvelope(envelopeId, missionId);
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  it('succeeds when all gate receipts are PASS', async () => {
    const buildRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const testRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const reviewRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const securityRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    for (const r of [buildRcpt, testRcpt, reviewRcpt, securityRcpt]) {
      seedGateReceipt(r, missionId, envelopeId, 'PASS');
    }

    const releaseProfile = makeProfileV2('Release', 'RELEASE_BUILD');
    const releaseInstance = makeInstanceV2(releaseProfile.profileId, 'actor-release-ok', envelopeId);

    const result = await createReleaseBundle({
      missionId,
      workItemId: `wp_${'a'.repeat(32)}`,
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      buildReceiptId: buildRcpt,
      testReceiptId: testRcpt,
      reviewReceiptId: reviewRcpt,
      securityReceiptId: securityRcpt,
      actorInstance: releaseInstance,
      actorProfile: releaseProfile,
      priorInstances: [],
      priorProfiles: [],
      artifactBuilder: makeMockArtifactBuilder(),
      sbomGenerator: makeMockSbom(),
    });

    assert.equal(result.success, true, result.reason);
    assert.ok(result.releaseBundle);
    assert.equal(result.releaseBundle!.status, 'VERIFIED');
    assert.ok(result.receiptId);
  });

  it('rejects when test receipt is FAIL', async () => {
    const buildRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const testRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const reviewRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const securityRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedGateReceipt(buildRcpt, missionId, envelopeId, 'PASS');
    seedGateReceipt(testRcpt, missionId, envelopeId, 'FAIL');
    seedGateReceipt(reviewRcpt, missionId, envelopeId, 'PASS');
    seedGateReceipt(securityRcpt, missionId, envelopeId, 'PASS');

    const releaseProfile = makeProfileV2('Release', 'RELEASE_BUILD');
    const releaseInstance = makeInstanceV2(releaseProfile.profileId, 'actor-release-fail', envelopeId);

    const result = await createReleaseBundle({
      missionId,
      workItemId: `wp_${'b'.repeat(32)}`,
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      buildReceiptId: buildRcpt,
      testReceiptId: testRcpt,
      reviewReceiptId: reviewRcpt,
      securityReceiptId: securityRcpt,
      actorInstance: releaseInstance,
      actorProfile: releaseProfile,
      priorInstances: [],
      priorProfiles: [],
      artifactBuilder: makeMockArtifactBuilder(),
      sbomGenerator: makeMockSbom(),
    });

    assert.equal(result.success, false);
    assert.ok(result.reason);
    assert.match(result.reason!, /test gate receipt verdict is FAIL/);
  });

  it('rejects when review receipt missing', async () => {
    const buildRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const testRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    // review receipt NOT seeded
    const reviewRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const securityRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    seedGateReceipt(buildRcpt, missionId, envelopeId, 'PASS');
    seedGateReceipt(testRcpt, missionId, envelopeId, 'PASS');
    seedGateReceipt(securityRcpt, missionId, envelopeId, 'PASS');

    const releaseProfile = makeProfileV2('Release', 'RELEASE_BUILD');
    const releaseInstance = makeInstanceV2(releaseProfile.profileId, 'actor-release-missing', envelopeId);

    const result = await createReleaseBundle({
      missionId,
      workItemId: `wp_${'c'.repeat(32)}`,
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      buildReceiptId: buildRcpt,
      testReceiptId: testRcpt,
      reviewReceiptId: reviewRcpt,
      securityReceiptId: securityRcpt,
      actorInstance: releaseInstance,
      actorProfile: releaseProfile,
      priorInstances: [],
      priorProfiles: [],
      artifactBuilder: makeMockArtifactBuilder(),
      sbomGenerator: makeMockSbom(),
    });

    assert.equal(result.success, false);
    assert.ok(result.reason);
    assert.match(result.reason!, /review gate receipt not found/);
  });

  it('rejects when actor was Engineer (separation)', async () => {
    const buildRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const testRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const reviewRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const securityRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    for (const r of [buildRcpt, testRcpt, reviewRcpt, securityRcpt]) {
      seedGateReceipt(r, missionId, envelopeId, 'PASS');
    }

    const engineerProfile = makeProfileV2('Engineer', 'IMPLEMENT');
    const engineerInstance = makeInstanceV2(
      engineerProfile.profileId,
      'actor-shared-sep',
      envelopeId,
      { sessionId: 'session-engineer-sep' },
    );

    const releaseProfile = makeProfileV2('Release', 'RELEASE_BUILD');
    const releaseInstance = makeInstanceV2(
      releaseProfile.profileId,
      'actor-shared-sep', // same actorId → separation violation
      envelopeId,
      { sessionId: 'session-release-sep' },
    );

    const result = await createReleaseBundle({
      missionId,
      workItemId: `wp_${'d'.repeat(32)}`,
      envelopeId,
      frozenSourceSha: SOURCE_SHA,
      buildReceiptId: buildRcpt,
      testReceiptId: testRcpt,
      reviewReceiptId: reviewRcpt,
      securityReceiptId: securityRcpt,
      actorInstance: releaseInstance,
      actorProfile: releaseProfile,
      priorInstances: [engineerInstance],
      priorProfiles: [engineerProfile],
      artifactBuilder: makeMockArtifactBuilder(),
      sbomGenerator: makeMockSbom(),
    });

    assert.equal(result.success, false);
    assert.ok(result.reason);
    assert.match(result.reason!, /separation|incompatible|actor/i);
  });

  it('release bundle binds correct frozenSourceSha + artifactDigest + sbomDigest', async () => {
    const buildRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const testRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const reviewRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    const securityRcpt = `rcpt_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    for (const r of [buildRcpt, testRcpt, reviewRcpt, securityRcpt]) {
      seedGateReceipt(r, missionId, envelopeId, 'PASS');
    }

    const customArtifactDigest = '1'.repeat(64);
    const customSbomDigest = '2'.repeat(64);
    const customSourceSha = '3'.repeat(40);

    const releaseProfile = makeProfileV2('Release', 'RELEASE_BUILD');
    const releaseInstance = makeInstanceV2(releaseProfile.profileId, 'actor-release-bind', envelopeId);

    const result = await createReleaseBundle({
      missionId,
      workItemId: `wp_${'e'.repeat(32)}`,
      envelopeId,
      frozenSourceSha: customSourceSha,
      buildReceiptId: buildRcpt,
      testReceiptId: testRcpt,
      reviewReceiptId: reviewRcpt,
      securityReceiptId: securityRcpt,
      actorInstance: releaseInstance,
      actorProfile: releaseProfile,
      priorInstances: [],
      priorProfiles: [],
      artifactBuilder: makeMockArtifactBuilder(customArtifactDigest),
      sbomGenerator: makeMockSbom(customSbomDigest),
    });

    assert.equal(result.success, true, result.reason);
    assert.ok(result.releaseBundle);
    assert.equal(result.releaseBundle!.frozenSourceSha, customSourceSha);
    assert.equal(result.releaseBundle!.artifactDigest, customArtifactDigest);
    assert.equal(result.releaseBundle!.sbomDigest, customSbomDigest);

    // Verify persisted in DB
    const row = queryOne<{ frozen_source_sha: string; artifact_digest: string; sbom_digest: string }>(
      'SELECT frozen_source_sha, artifact_digest, sbom_digest FROM workflow_release_bundle WHERE release_bundle_id = ?',
      [result.releaseBundle!.releaseBundleId],
    );
    assert.ok(row);
    assert.equal(row!.frozen_source_sha, customSourceSha);
    assert.equal(row!.artifact_digest, customArtifactDigest);
    assert.equal(row!.sbom_digest, customSbomDigest);
  });
});
