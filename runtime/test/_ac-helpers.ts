/**
 * AC 集成测试共享辅助 — AC-01~AC-10 通用 fixture
 *
 * 提供隔离 DB、Mission/Envelope/WorkPackage 播种、AgentProfileV2/InstanceV2
 * 构造器、Mock ArtifactBuilder/SbomPort、Stage 顺利完成、门禁回执播种等工具。
 *
 * 设计原则：
 *   - 每个测试文件在 before() 中调用 setupIsolatedTestDb()，after() 中调用
 *     cleanupIsolatedTestDb()，确保 AC 测试间 DB 完全隔离。
 *   - 所有 ID 通过 createAwknId() 生成，符合契约前缀格式。
 *   - 不写入生产 data/awkn-engine.db：AWKN_DB_PATH 指向临时目录。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, queryRun } from '../src/store/db.js';
import { createAwknId } from '../src/contracts/ids.js';
import { receiptPayloadHash } from '../src/contracts/receipts.js';
import { completeStage, initializeStages, startStage } from '../src/workflow/stage-orchestrator.js';
import type {
  AgentInstanceV2,
  AgentProfileV2,
  WorkflowStageRun,
  WorkflowStageType,
} from '../src/contracts/workflow-v2.js';
import type { AgentRole } from '../src/contracts/workflow.js';
import type {
  ArtifactBuilderPort,
  ArtifactBuildInput,
  ArtifactBuildResult,
} from '../src/release/artifact-builder-port.js';
import type { SbomPort, SbomInput, SbomResult } from '../src/release/sbom-port.js';

// ─── 共享常量 ─────────────────────────────────────────────

export const SHA256_HEX = 'a'.repeat(64);
export const SOURCE_SHA = 'b'.repeat(40);
export const ARTIFACT_DIGEST = 'd'.repeat(64);
export const NOW = '2026-08-02T00:00:00.000Z';
export const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── DB 隔离 ─────────────────────────────────────────────

let tempDir: string | undefined;

/**
 * 创建隔离的临时 SQLite DB。设置 AWKN_DB_PATH 后重新打开连接。
 * 多次调用会先清理上一个临时目录。
 */
export async function setupIsolatedTestDb(prefix = 'wf-ac-'): Promise<void> {
  await cleanupIsolatedTestDb();
  tempDir = await mkdtemp(join(tmpdir(), prefix));
  process.env.AWKN_DB_PATH = join(tempDir, `${randomUUID()}.db`);
  closeDb();
  getDb();
}

/**
 * 关闭 DB 并删除临时目录。幂等。
 */
export async function cleanupIsolatedTestDb(): Promise<void> {
  closeDb();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
}

// ─── 基础播种 ─────────────────────────────────────────────

/** 播种 goals 行（mission 父表）。幂等。 */
export function seedMission(missionId: string, title?: string): void {
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO goals (id, title, description, created_at, updated_at)
     VALUES (?, ?, '', ?, ?)`,
    [missionId, title ?? `Mission ${missionId}`, now, now],
  );
}

/** 生成合法 mission ID（goal_ 前缀 + 32 hex）。 */
export function makeMissionId(): string {
  return `goal_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
}

/** 生成合法 envelope ID。 */
export function makeEnvelopeId(): string {
  return `env_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
}

/** 生成合法 work package ID。 */
export function makeWorkPackageId(): string {
  return `wp_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
}

export interface EnvelopeOptions {
  allowGitCommit?: boolean;
  allowGitPush?: boolean;
  allowDeploy?: boolean;
  deployEnvironments?: string[];
  scopeTools?: string[];
  status?: string;
  expiresAt?: string;
}

/**
 * 播种授权信封。默认 allow_* 为 false、status=ACTIVE、scopeTools=[]。
 */
export function seedAuthorizationEnvelope(
  envelopeId: string,
  missionId: string,
  opts: EnvelopeOptions = {},
): void {
  seedMission(missionId);
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO authorization_envelope
       (id, mission_id, user_signature, scope_directories, scope_tools,
        allow_git_commit, allow_git_push, allow_deploy, deploy_environments,
        created_at, expires_at, status)
     VALUES (?, ?, 'sig', '[]', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      envelopeId,
      missionId,
      JSON.stringify(opts.scopeTools ?? []),
      opts.allowGitCommit ? 1 : 0,
      opts.allowGitPush ? 1 : 0,
      opts.allowDeploy ? 1 : 0,
      opts.deployEnvironments ? JSON.stringify(opts.deployEnvironments) : null,
      now,
      opts.expiresAt ?? null,
      opts.status ?? 'ACTIVE',
    ],
  );
}

/**
 * 播种完整工作项链（goal → component → module → work_package）并返回 work package ID。
 * 若 workPackageId 未提供则生成新的合法 ID。
 */
export function seedWorkPackage(
  missionId: string,
  workPackageId?: string,
  opts: { componentName?: string; moduleName?: string; wpName?: string } = {},
): string {
  const now = new Date().toISOString();
  const componentId = `comp_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  const moduleId = `mod_${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  const wpId = workPackageId ?? makeWorkPackageId();

  seedMission(missionId);
  queryRun(
    `INSERT OR IGNORE INTO workflow_component
       (id, mission_id, name, status, acceptance_criteria, created_at, updated_at)
     VALUES (?, ?, ?, 'DRAFT', '[]', ?, ?)`,
    [componentId, missionId, opts.componentName ?? `comp-${wpId.slice(0, 12)}`, now, now],
  );
  queryRun(
    `INSERT OR IGNORE INTO workflow_module
       (id, component_id, name, status, boundary, acceptance_criteria, created_at, updated_at)
     VALUES (?, ?, ?, 'DRAFT', 'module-boundary', '[]', ?, ?)`,
    [moduleId, componentId, opts.moduleName ?? `mod-${wpId.slice(0, 12)}`, now, now],
  );
  queryRun(
    `INSERT OR IGNORE INTO workflow_work_package
       (id, module_id, name, status, scope, acceptance_criteria, dependencies,
        created_at, updated_at)
     VALUES (?, ?, ?, 'DRAFT', 'wp-scope', '[]', '[]', ?, ?)`,
    [wpId, moduleId, opts.wpName ?? `wp-${wpId.slice(0, 12)}`, now, now],
  );
  return wpId;
}

// ─── AgentProfileV2 / AgentInstanceV2 构造 ───────────────

export function makeProfileV2(
  role: AgentRole,
  specialty: WorkflowStageType,
  profileId?: string,
  overrides?: Partial<AgentProfileV2>,
): AgentProfileV2 {
  return {
    schema: 'awkn-agent-profile/v2',
    profileId: profileId ?? `prof_${role.toLowerCase()}_${randomUUID().slice(0, 8)}`,
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

export function makeInstanceV2(
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

// ─── Mock ArtifactBuilder / SbomPort ─────────────────────

export function makeMockArtifactBuilder(
  overrides?: Partial<ArtifactBuildResult>,
): ArtifactBuilderPort {
  const result: ArtifactBuildResult = {
    artifactDigest: ARTIFACT_DIGEST,
    artifacts: [
      {
        artifactType: 'tarball',
        artifactPath: '/tmp/artifact.tar.gz',
        artifactDigest: ARTIFACT_DIGEST,
        artifactSizeBytes: 1024,
      },
    ],
    ...overrides,
  };
  return {
    builderId: 'mock-artifact-builder',
    build: async (_input: ArtifactBuildInput) => result,
  };
}

export function makeMockSbomPort(overrides?: Partial<SbomResult>): SbomPort {
  const result: SbomResult = {
    sbomDigest: SHA256_HEX,
    sbomContent: '{"sbom":"mock"}',
    ...overrides,
  };
  return {
    generatorId: 'mock-sbom-generator',
    generate: async (_input: SbomInput) => result,
  };
}

// ─── Receipt / Stage 辅助 ────────────────────────────────

/**
 * 播种一条 WORKER_RESULT receipt，verdict=PASS、status=SUCCESS。
 * 用于 stage-governor 校验通过所需 trigger receipt。
 */
export function seedWorkerResultReceipt(
  receiptId: string,
  stageRunId: string,
  missionId: string,
  envelopeId: string,
): void {
  const now = new Date().toISOString();
  const execId = createAwknId('execution');
  const traceId = createAwknId('trace');
  const producer = {
    schema: 'awkn-actor-ref/v1',
    actorId: 'actor-test',
    actorType: 'assistant' as const,
  };

  queryRun(
    `INSERT OR IGNORE INTO executions
       (id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
        input_ref_json, feature_flags_ref_json, state, created_at, updated_at)
     VALUES (?, ?, 0, ?, 'awkn-actor-ref/v1', '{}', 'awkn-execution-scope/v1',
             '{}', '{}', 'DELIVERED', ?, ?)`,
    [execId, traceId, JSON.stringify(producer), now, now],
  );

  const payload = {
    schema: 'awkn-worker-result/v1',
    missionId,
    envelopeId,
    frozenTargetHash: SHA256_HEX,
    verdict: 'PASS',
    toolsUsed: ['tool-1'],
    evidenceRefs: [`ev_${stageRunId.slice(0, 16)}`],
  };
  const payloadSchema = 'awkn-worker-result/v1';
  const payloadHash = receiptPayloadHash(payloadSchema, payload);

  queryRun(
    `INSERT INTO receipts
       (id, receipt_type, payload_schema, execution_id, trace_id,
        aggregate_type, aggregate_id, producer_json, status,
        payload_json, payload_hash, artifact_refs_json, created_at)
     VALUES (?, 'WORKER_RESULT', ?, ?, ?, 'stage_run', ?, ?, 'SUCCESS', ?, ?, '[]', ?)`,
    [
      receiptId,
      payloadSchema,
      execId,
      traceId,
      stageRunId,
      JSON.stringify(producer),
      JSON.stringify(payload),
      payloadHash,
      now,
    ],
  );
}

/**
 * 播种一条泛型 gate receipt（status=SUCCESS, verdict=PASS）。
 * 用于 release-coordinator 的 build/test/review/security 门禁校验。
 */
export function seedGateReceipt(
  receiptId: string,
  receiptType: 'TEST' | 'SECURITY_REVIEW' | 'REVIEW' | 'WORKER_RESULT',
  aggregateId: string,
): void {
  const now = new Date().toISOString();
  const execId = createAwknId('execution');
  const traceId = createAwknId('trace');
  const producer = {
    schema: 'awkn-actor-ref/v1',
    actorId: 'actor-gate',
    actorType: 'assistant' as const,
  };

  queryRun(
    `INSERT OR IGNORE INTO executions
       (id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
        input_ref_json, feature_flags_ref_json, state, created_at, updated_at)
     VALUES (?, ?, 0, ?, 'awkn-actor-ref/v1', '{}', 'awkn-execution-scope/v1',
             '{}', '{}', 'DELIVERED', ?, ?)`,
    [execId, traceId, JSON.stringify(producer), now, now],
  );

  const payload = { verdict: 'PASS', evidenceRefs: [] };
  const payloadSchema = 'awkn-gate-receipt/v1';
  const payloadHash = receiptPayloadHash(payloadSchema, payload);

  queryRun(
    `INSERT INTO receipts
       (id, receipt_type, payload_schema, execution_id, trace_id,
        aggregate_type, aggregate_id, producer_json, status,
        payload_json, payload_hash, artifact_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'gate', ?, ?, 'SUCCESS', ?, ?, '[]', ?)`,
    [
      receiptId,
      receiptType,
      payloadSchema,
      execId,
      traceId,
      aggregateId,
      JSON.stringify(producer),
      JSON.stringify(payload),
      payloadHash,
      now,
    ],
  );
}

/**
 * 播种 4 条门禁回执（build/test/review/security），全部 SUCCESS+PASS。
 * 返回 { buildReceiptId, testReceiptId, reviewReceiptId, securityReceiptId }。
 */
export function seedGateReceipts(aggregateId: string): {
  buildReceiptId: string;
  testReceiptId: string;
  reviewReceiptId: string;
  securityReceiptId: string;
} {
  const buildReceiptId = createAwknId('receipt');
  const testReceiptId = createAwknId('receipt');
  const reviewReceiptId = createAwknId('receipt');
  const securityReceiptId = createAwknId('receipt');
  seedGateReceipt(buildReceiptId, 'WORKER_RESULT', aggregateId);
  seedGateReceipt(testReceiptId, 'TEST', aggregateId);
  seedGateReceipt(reviewReceiptId, 'REVIEW', aggregateId);
  seedGateReceipt(securityReceiptId, 'SECURITY_REVIEW', aggregateId);
  return { buildReceiptId, testReceiptId, reviewReceiptId, securityReceiptId };
}

/**
 * 播种一条已完成的 StageRun（PASSED + output receipt）。
 * 用于 retrospective 等需要"已完成工作项"的场景。
 */
export function seedCompletedStage(
  missionId: string,
  workItemId: string,
  stageType: WorkflowStageType,
  envelopeId: string,
  workItemType: 'workpackage' | 'module' | 'component' | 'mission' = 'workpackage',
): { stageRunId: string; receiptId: string } {
  const now = new Date().toISOString();
  const stageRunId = createAwknId('stageRun');
  const receiptId = createAwknId('receipt');

  queryRun(
    `INSERT INTO workflow_stage_run
       (stage_run_id, mission_id, work_item_type, work_item_id, stage_type, state,
        required_profile_id, frozen_input_hash, authorization_envelope_id,
        output_receipt_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'PASSED', 'prof-seed', ?, ?, ?, ?, ?, ?)`,
    [stageRunId, missionId, workItemType, workItemId, stageType, SHA256_HEX, envelopeId, receiptId, `seed-${stageRunId}`, now, now],
  );

  seedWorkerResultReceipt(receiptId, stageRunId, missionId, envelopeId);
  return { stageRunId, receiptId };
}

// ─── Stage 顺利完成 ──────────────────────────────────────

/**
 * 将 stageRun 从 READY → RUNNING → PASSED，并产出 trigger receipt。
 * 返回 { receiptId, idempotencyKey }。
 *
 * priorInstances/priorProfiles 为分离策略前置上下文（默认空数组）。
 */
export function completeStageSuccessfully(
  stageRun: WorkflowStageRun,
  actorInstance: AgentInstanceV2,
  actorProfile: AgentProfileV2,
  envelopeId: string,
  priorInstances: AgentInstanceV2[] = [],
  priorProfiles: AgentProfileV2[] = [],
): { success: boolean; receiptId: string; idempotencyKey: string; reason?: string } {
  startStage(stageRun.stageRunId, actorInstance.actorId, FUTURE);
  const receiptId = createAwknId('receipt');
  seedWorkerResultReceipt(receiptId, stageRun.stageRunId, stageRun.missionId, envelopeId);
  const idempotencyKey = createAwknId('event');
  const result = completeStage(
    stageRun.stageRunId,
    actorInstance,
    actorProfile,
    receiptId,
    priorInstances,
    priorProfiles,
    receiptId,
    idempotencyKey,
  );
  return {
    success: result.success,
    receiptId,
    idempotencyKey,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  };
}

/**
 * 便捷：初始化工作包阶段并返回入口 stage（IMPLEMENT）。
 */
export function initWorkPackageStages(
  missionId: string,
  workItemId: string,
  envelopeId: string,
  requiredProfileId = 'prof-test',
): WorkflowStageRun[] {
  return initializeStages({
    missionId,
    workItemType: 'workpackage',
    workItemId,
    requiredProfileId,
    authorizationEnvelopeId: envelopeId,
    frozenInputHash: SHA256_HEX,
  });
}
