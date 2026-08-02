/**
 * Git Coordinator — Git 集成协调器
 *
 * Spiral 3: 执行 Git 集成阶段。职责：
 *   1. 强制 Separation Policy v2（Git 角色不得与 Engineer 同 actor/session）
 *   2. 校验授权信封 allowGitCommit / allowGitPush
 *   3. 产出 GIT 回执并持久化
 *
 * 约束：Git Agent 仅执行 git 操作（commit/push），不修改源代码。
 *
 * 对应契约: contracts/receipts.ts — ReceiptType 'GIT'
 *           git-agent/git-receipt.ts — GitReceiptPayload
 */
import { createAwknId } from '../contracts/ids.js';
import { receiptPayloadHash } from '../contracts/receipts.js';
import { queryOne, queryRun } from '../store/db.js';
import { enforceSeparationV2 } from '../governor/separation-policy-v2.js';
import type { AgentInstanceV2, AgentProfileV2 } from '../contracts/workflow-v2.js';
import {
  GIT_RECEIPT_PAYLOAD_SCHEMA,
  buildGitReceiptPayload,
  type GitReceiptPayload,
} from './git-receipt.js';

// ─── 公共类型 ─────────────────────────────────────────────

export interface GitIntegrationParams {
  readonly missionId: string;
  readonly workItemId: string;
  readonly envelopeId: string;
  readonly frozenSourceSha: string;
  readonly actorInstance: AgentInstanceV2;
  readonly actorProfile: AgentProfileV2;
  readonly priorInstances: readonly AgentInstanceV2[];
  readonly priorProfiles: readonly AgentProfileV2[];
  readonly commitSha: string;
  readonly commitVerified: boolean;
  readonly filesChanged: readonly string[];
}

export interface GitIntegrationResult {
  readonly success: boolean;
  readonly reason?: string;
  readonly receiptId?: string;
  readonly verdict?: GitReceiptPayload['verdict'];
}

// ─── DB Row 类型 ──────────────────────────────────────────

interface AuthorizationEnvelopeRow {
  readonly status: string;
  readonly expires_at: string | null;
  readonly allow_git_commit: number;
  readonly allow_git_push: number;
}

// ─── 内部辅助 ─────────────────────────────────────────────

const ENVELOPE_SELECT_SQL =
  'SELECT status, expires_at, allow_git_commit, allow_git_push FROM authorization_envelope WHERE id = ?';

function fail(reason: string): GitIntegrationResult {
  return { success: false, reason };
}

function loadEnvelope(envelopeId: string): AuthorizationEnvelopeRow | undefined {
  return queryOne<AuthorizationEnvelopeRow>(ENVELOPE_SELECT_SQL, [envelopeId]);
}

/**
 * 持久化 GIT 回执到 receipts 表。
 * 需先确保 execution 行存在（FK 约束）。
 */
function persistGitReceipt(
  payload: GitReceiptPayload,
  workItemId: string,
  actorInstance: AgentInstanceV2,
  status: 'SUCCESS' | 'FAILURE',
): string {
  const receiptId = createAwknId('receipt');
  const executionId = createAwknId('execution');
  const traceId = createAwknId('trace');
  const now = new Date().toISOString();
  const payloadHash = receiptPayloadHash(GIT_RECEIPT_PAYLOAD_SCHEMA, payload);
  const producer = {
    schema: 'awkn-actor-ref/v1' as const,
    actorId: actorInstance.actorId,
    actorType: 'assistant' as const,
  };

  queryRun(
    `INSERT OR IGNORE INTO executions
       (id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
        input_ref_json, feature_flags_ref_json, state, created_at, updated_at)
     VALUES (?, ?, 0, '{}', 'awkn-actor-ref/v1', '{}', 'awkn-execution-scope/v1',
             '{}', '{}', 'RECEIVED', ?, ?)`,
    [executionId, traceId, now, now],
  );

  queryRun(
    `INSERT INTO receipts
       (id, receipt_type, payload_schema, execution_id, trace_id,
        aggregate_type, aggregate_id, producer_json, status,
        payload_json, payload_hash, artifact_refs_json, created_at)
     VALUES (?, 'GIT', ?, ?, ?, 'work_package', ?, ?, ?, ?, ?, '[]', ?)`,
    [
      receiptId,
      GIT_RECEIPT_PAYLOAD_SCHEMA,
      executionId,
      traceId,
      workItemId,
      JSON.stringify(producer),
      status,
      JSON.stringify(payload),
      payloadHash,
      now,
    ],
  );

  return receiptId;
}

// ─── 主入口 ───────────────────────────────────────────────

/**
 * 执行 Git 集成。
 *
 * 步骤：
 *   1. 校验 actor profile 为 ACTIVE/CANARY
 *   2. 强制 Separation Policy v2（Git ↔ Engineer 不相容）
 *   3. 加载授权信封，校验 ACTIVE/未过期 + allowGitCommit
 *   4. 构造 GIT 回执载荷（verdict 由 commitVerified 决定）
 *   5. 持久化回执
 *
 * 不修改源代码：本函数仅读取 DB 并写入回执，不触碰工作区文件。
 */
export async function executeGitIntegration(
  params: GitIntegrationParams,
): Promise<GitIntegrationResult> {
  // 1. actor profile 状态校验
  if (params.actorProfile.status !== 'ACTIVE' && params.actorProfile.status !== 'CANARY') {
    return fail(
      `actor profile ${params.actorProfile.profileId} status is ${params.actorProfile.status}, must be ACTIVE or CANARY`,
    );
  }

  // 2. Separation Policy v2 — Git 角色不得与 Engineer 同 actor/session
  const separation = enforceSeparationV2({
    currentProfile: params.actorProfile,
    currentInstance: params.actorInstance,
    priorInstances: params.priorInstances,
    priorProfiles: params.priorProfiles,
    authorizationEnvelopeId: params.envelopeId,
    workspacePolicy: 'read_write',
    frozenInputHash: params.frozenSourceSha,
    stageFrozenHash: params.frozenSourceSha,
    availableBudget: Number.MAX_SAFE_INTEGER,
    availableConcurrency: 1,
  });
  if (!separation.allowed) {
    return fail(
      separation.reason ??
        `separation policy v2 denied at step ${separation.step ?? '?'}`,
    );
  }

  // 3. 授权信封校验
  const envelope = loadEnvelope(params.envelopeId);
  if (!envelope) {
    return fail(`authorization envelope not found: ${params.envelopeId}`);
  }
  if (envelope.status !== 'ACTIVE') {
    return fail(`authorization envelope is ${envelope.status}, must be ACTIVE`);
  }
  if (envelope.expires_at && new Date(envelope.expires_at) < new Date()) {
    return fail(`authorization envelope expired at ${envelope.expires_at}`);
  }
  if (!envelope.allow_git_commit) {
    return fail(`authorization envelope ${params.envelopeId} does not allow git commit`);
  }

  // 4. 构造回执载荷 — verdict 由 commitVerified 决定
  const verdict: GitReceiptPayload['verdict'] = params.commitVerified ? 'PASS' : 'FAIL';
  const payload = buildGitReceiptPayload({
    missionId: params.missionId,
    workPackageId: params.workItemId,
    envelopeId: params.envelopeId,
    frozenSourceSha: params.frozenSourceSha,
    commitSha: params.commitSha,
    commitVerified: params.commitVerified,
    filesChanged: params.filesChanged,
    verdict,
  });

  // 5. 持久化回执
  const receiptStatus = verdict === 'PASS' ? 'SUCCESS' : 'FAILURE';
  const receiptId = persistGitReceipt(
    payload,
    params.workItemId,
    params.actorInstance,
    receiptStatus,
  );

  return { success: verdict === 'PASS', receiptId, verdict };
}
