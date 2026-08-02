/**
 * Release Coordinator — Release Bundle 创建协调器
 *
 * Spiral 3: 创建 Release Bundle。职责：
 *   1. Feature flag 校验（AWKN_RELEASE_AGENT_V1）
 *   2. 校验 4 个门禁回执存在且 verdict=PASS（build/test/review/security）
 *   3. 通过 ArtifactBuilderPort 构建制品，通过 SbomPort 生成 SBOM
 *   4. 绑定 frozenSourceSha + artifactDigest + sbomDigest
 *   5. 强制 Separation Policy v2（Release ↔ Engineer / Deploy 不相容）
 *   6. 持久化到 workflow_release_bundle + workflow_release_artifact
 *   7. 产出 RELEASE 回执
 *
 * 约束：Release Agent 不修改源代码（仅读取 + 创建 release bundle）。
 *
 * 对应契约: release/contracts.ts — ReleaseBundleSchema
 */
import { createAwknId } from '../contracts/ids.js';
import { receiptPayloadHash } from '../contracts/receipts.js';
import { queryOne, queryRun } from '../store/db.js';
import { enforceSeparationV2 } from '../governor/separation-policy-v2.js';
import type { AgentInstanceV2, AgentProfileV2 } from '../contracts/workflow-v2.js';
import type { ArtifactBuilderPort } from './artifact-builder-port.js';
import type { SbomPort } from './sbom-port.js';
import {
  RELEASE_RECEIPT_PAYLOAD_SCHEMA,
  ReleaseBundleSchema,
  type ReleaseBundle,
  type ReleaseBundleStatus,
  type ReleaseReceiptPayload,
} from './contracts.js';

// ─── 公共类型 ─────────────────────────────────────────────

export interface CreateReleaseBundleParams {
  readonly missionId: string;
  readonly workItemId: string;
  readonly envelopeId: string;
  readonly frozenSourceSha: string;
  readonly buildReceiptId: string;
  readonly testReceiptId: string;
  readonly reviewReceiptId: string;
  readonly securityReceiptId: string;
  readonly actorInstance: AgentInstanceV2;
  readonly actorProfile: AgentProfileV2;
  readonly priorInstances: readonly AgentInstanceV2[];
  readonly priorProfiles: readonly AgentProfileV2[];
  readonly artifactBuilder: ArtifactBuilderPort;
  readonly sbomGenerator: SbomPort;
}

export interface ReleaseBundleResult {
  readonly success: boolean;
  readonly reason?: string;
  readonly releaseBundle?: ReleaseBundle;
  readonly receiptId?: string;
}

// ─── DB Row 类型 ──────────────────────────────────────────

interface ReceiptRow {
  readonly status: string;
  readonly payload_json: string;
}

interface AuthorizationEnvelopeRow {
  readonly status: string;
  readonly expires_at: string | null;
}

interface ReleaseBundleRow {
  readonly release_bundle_id: string;
  readonly mission_id: string;
  readonly work_item_id: string;
  readonly frozen_source_sha: string;
  readonly artifact_digest: string;
  readonly sbom_digest: string;
  readonly build_receipt_id: string | null;
  readonly test_receipt_id: string | null;
  readonly review_receipt_id: string | null;
  readonly security_receipt_id: string | null;
  readonly issued_actor_id: string;
  readonly authorization_envelope_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

// ─── 内部辅助 ─────────────────────────────────────────────

const RECEIPT_SELECT_SQL = 'SELECT status, payload_json FROM receipts WHERE id = ?';
const ENVELOPE_SELECT_SQL = 'SELECT status, expires_at FROM authorization_envelope WHERE id = ?';

function fail(reason: string): ReleaseBundleResult {
  return { success: false, reason };
}

/**
 * 读取 Feature Flag 值。默认 '0'（禁用）。
 * 'shadow' 或 'enforce' 表示新路径启用。
 */
function isFeatureEnabled(flagName: string): boolean {
  const value = process.env[flagName] ?? '0';
  return value === 'shadow' || value === 'enforce';
}

function loadGateReceipt(receiptId: string): { status: string; verdict?: string } | undefined {
  const row = queryOne<ReceiptRow>(RECEIPT_SELECT_SQL, [receiptId]);
  if (!row) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return { status: row.status };
  }
  const verdict = (payload as { verdict?: string } | null)?.verdict;
  return { status: row.status, verdict };
}

function rowToReleaseBundle(row: ReleaseBundleRow): ReleaseBundle {
  return ReleaseBundleSchema.parse({
    schema: 'awkn-release-bundle/v1',
    releaseBundleId: row.release_bundle_id,
    missionId: row.mission_id,
    workItemId: row.work_item_id,
    frozenSourceSha: row.frozen_source_sha,
    artifactDigest: row.artifact_digest,
    sbomDigest: row.sbom_digest,
    ...(row.build_receipt_id !== null ? { buildReceiptId: row.build_receipt_id } : {}),
    ...(row.test_receipt_id !== null ? { testReceiptId: row.test_receipt_id } : {}),
    ...(row.review_receipt_id !== null ? { reviewReceiptId: row.review_receipt_id } : {}),
    ...(row.security_receipt_id !== null ? { securityReceiptId: row.security_receipt_id } : {}),
    issuedActorId: row.issued_actor_id,
    authorizationEnvelopeId: row.authorization_envelope_id,
    status: row.status as ReleaseBundleStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function persistReleaseReceipt(
  payload: ReleaseReceiptPayload,
  actorInstance: AgentInstanceV2,
  status: 'SUCCESS' | 'FAILURE',
): string {
  const receiptId = createAwknId('receipt');
  const executionId = createAwknId('execution');
  const traceId = createAwknId('trace');
  const now = new Date().toISOString();
  const payloadHash = receiptPayloadHash(RELEASE_RECEIPT_PAYLOAD_SCHEMA, payload);
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
     VALUES (?, 'RELEASE', ?, ?, ?, 'release_bundle', ?, ?, ?, ?, ?, '[]', ?)`,
    [
      receiptId,
      RELEASE_RECEIPT_PAYLOAD_SCHEMA,
      executionId,
      traceId,
      payload.releaseBundleId,
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
 * 创建 Release Bundle。
 *
 * 步骤：
 *   1. Feature flag 校验
 *   2. actor profile 状态校验
 *   3. Separation Policy v2（Release ↔ Engineer / Deploy 不相容）
 *   4. 授权信封校验
 *   5. 门禁回执校验（build/test/review/security 全部存在 + SUCCESS + verdict=PASS）
 *   6. 构建制品 + 生成 SBOM
 *   7. 持久化 ReleaseBundle（status=VERIFIED）+ 制品清单
 *   8. 产出 RELEASE 回执
 *
 * 不修改源代码：本函数仅读取 DB、调用构建端口并写入 release bundle。
 */
export async function createReleaseBundle(
  params: CreateReleaseBundleParams,
): Promise<ReleaseBundleResult> {
  // 1. Feature flag 校验
  if (!isFeatureEnabled('AWKN_RELEASE_AGENT_V1')) {
    return fail('AWKN_RELEASE_AGENT_V1 feature flag is disabled (0); cannot create release bundle');
  }

  // 2. actor profile 状态校验
  if (params.actorProfile.status !== 'ACTIVE' && params.actorProfile.status !== 'CANARY') {
    return fail(
      `actor profile ${params.actorProfile.profileId} status is ${params.actorProfile.status}, must be ACTIVE or CANARY`,
    );
  }

  // 3. Separation Policy v2
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

  // 4. 授权信封校验
  const envelope = queryOne<AuthorizationEnvelopeRow>(ENVELOPE_SELECT_SQL, [params.envelopeId]);
  if (!envelope) {
    return fail(`authorization envelope not found: ${params.envelopeId}`);
  }
  if (envelope.status !== 'ACTIVE') {
    return fail(`authorization envelope is ${envelope.status}, must be ACTIVE`);
  }
  if (envelope.expires_at && new Date(envelope.expires_at) < new Date()) {
    return fail(`authorization envelope expired at ${envelope.expires_at}`);
  }

  // 5. 门禁回执校验
  const gates: ReadonlyArray<readonly [string, string]> = [
    ['build', params.buildReceiptId],
    ['test', params.testReceiptId],
    ['review', params.reviewReceiptId],
    ['security', params.securityReceiptId],
  ];
  for (const [gateName, receiptId] of gates) {
    const receipt = loadGateReceipt(receiptId);
    if (!receipt) {
      return fail(`${gateName} gate receipt not found: ${receiptId}`);
    }
    if (receipt.status !== 'SUCCESS') {
      return fail(`${gateName} gate receipt status is ${receipt.status}, must be SUCCESS`);
    }
    if (receipt.verdict !== 'PASS') {
      return fail(`${gateName} gate receipt verdict is ${receipt.verdict ?? 'missing'}, must be PASS`);
    }
  }

  // 6. 构建制品 + 生成 SBOM
  const buildResult = await params.artifactBuilder.build({
    sourceSha: params.frozenSourceSha,
    workItemId: params.workItemId,
  });
  const sbomResult = await params.sbomGenerator.generate({
    sourceSha: params.frozenSourceSha,
    artifacts: buildResult.artifacts,
  });

  // 7. 持久化 ReleaseBundle
  const releaseBundleId = createAwknId('releaseBundle');
  const now = new Date().toISOString();
  queryRun(
    `INSERT INTO workflow_release_bundle
       (release_bundle_id, mission_id, work_item_id, frozen_source_sha,
        artifact_digest, sbom_digest, build_receipt_id, test_receipt_id,
        review_receipt_id, security_receipt_id, issued_actor_id,
        authorization_envelope_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?)`,
    [
      releaseBundleId,
      params.missionId,
      params.workItemId,
      params.frozenSourceSha,
      buildResult.artifactDigest,
      sbomResult.sbomDigest,
      params.buildReceiptId,
      params.testReceiptId,
      params.reviewReceiptId,
      params.securityReceiptId,
      params.actorInstance.actorId,
      params.envelopeId,
      now,
      now,
    ],
  );

  // 持久化制品清单
  for (const artifact of buildResult.artifacts) {
    const artifactId = createAwknId('artifact');
    queryRun(
      `INSERT INTO workflow_release_artifact
         (artifact_id, release_bundle_id, artifact_type, artifact_path,
          artifact_digest, artifact_size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        artifactId,
        releaseBundleId,
        artifact.artifactType,
        artifact.artifactPath,
        artifact.artifactDigest,
        artifact.artifactSizeBytes,
        now,
      ],
    );
  }

  // 读取持久化的 bundle 并返回
  const row = queryOne<ReleaseBundleRow>(
    'SELECT * FROM workflow_release_bundle WHERE release_bundle_id = ?',
    [releaseBundleId],
  );
  if (!row) {
    return fail('failed to read persisted release bundle');
  }
  const releaseBundle = rowToReleaseBundle(row);

  // 8. 产出 RELEASE 回执
  const payload: ReleaseReceiptPayload = {
    missionId: params.missionId,
    workItemId: params.workItemId,
    envelopeId: params.envelopeId,
    releaseBundleId,
    frozenSourceSha: params.frozenSourceSha,
    artifactDigest: buildResult.artifactDigest,
    sbomDigest: sbomResult.sbomDigest,
    verdict: 'PASS',
  };
  const receiptId = persistReleaseReceipt(payload, params.actorInstance, 'SUCCESS');

  return { success: true, releaseBundle, receiptId };
}
