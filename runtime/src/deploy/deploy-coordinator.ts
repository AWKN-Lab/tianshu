/**
 * Deploy Coordinator — 部署运行协调器
 *
 * Spiral 3: 执行灰度部署。职责：
 *   1. Feature flag 校验（AWKN_DEPLOY_AGENT_V1）
 *   2. 强制 Separation Policy v2（Deploy ↔ Engineer / Release / Review 不相容）
 *   3. 授权信封校验（allowDeploy + deployEnvironments 包含目标环境）
 *   4. 加载 ReleaseBundle（必须存在）
 *   5. 灰度部署 → 健康检查 → UNHEALTHY 自动回滚
 *   6. 持久化到 workflow_deployment_run + workflow_deployment_observation +
 *      workflow_rollback_target（回滚时）
 *   7. 产出 DEPLOY 回执
 *
 * 约束：Deploy Agent 不构建新制品（仅部署已存在的 Release Bundle）。
 *
 * 对应契约: deploy/contracts.ts — DeploymentRunSchema
 */
import { createAwknId } from '../contracts/ids.js';
import { receiptPayloadHash } from '../contracts/receipts.js';
import { queryOne, queryRun } from '../store/db.js';
import { enforceSeparationV2 } from '../governor/separation-policy-v2.js';
import type { AgentInstanceV2, AgentProfileV2 } from '../contracts/workflow-v2.js';
import type { DeployProviderPort } from './deploy-provider-port.js';
import {
  DEPLOY_RECEIPT_PAYLOAD_SCHEMA,
  GrayStageSchema,
  HealthStatusSchema,
  type DeployReceiptPayload,
  type DeploymentRun,
  type GrayStage,
  type HealthStatus,
} from './contracts.js';

// ─── 公共类型 ─────────────────────────────────────────────

export interface ExecuteDeploymentParams {
  readonly releaseBundleId: string;
  readonly targetEnvironment: string;
  readonly envelopeId: string;
  readonly actorInstance: AgentInstanceV2;
  readonly actorProfile: AgentProfileV2;
  readonly priorInstances: readonly AgentInstanceV2[];
  readonly priorProfiles: readonly AgentProfileV2[];
  readonly provider: DeployProviderPort;
}

export interface DeploymentResult {
  readonly success: boolean;
  readonly reason?: string;
  readonly deploymentRun?: DeploymentRun;
  readonly receiptId?: string;
  readonly rolledBack?: boolean;
  readonly rollbackTargetId?: string;
}

// ─── DB Row 类型 ──────────────────────────────────────────

interface AuthorizationEnvelopeRow {
  readonly status: string;
  readonly expires_at: string | null;
  readonly allow_deploy: number;
  readonly deploy_environments: string | null;
}

interface ReleaseBundleRow {
  readonly mission_id: string;
  readonly frozen_source_sha: string;
  readonly artifact_digest: string;
  readonly status: string;
}

interface DeploymentRunRow {
  readonly deployment_run_id: string;
  readonly release_bundle_id: string;
  readonly target_environment: string;
  readonly authorization_envelope_id: string;
  readonly gray_stage: string;
  readonly health_status: string;
  readonly final_verdict: string | null;
  readonly rollback_target_id: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// ─── 内部辅助 ─────────────────────────────────────────────

const ENVELOPE_SELECT_SQL =
  'SELECT status, expires_at, allow_deploy, deploy_environments FROM authorization_envelope WHERE id = ?';
const RELEASE_BUNDLE_SELECT_SQL =
  'SELECT mission_id, frozen_source_sha, artifact_digest, status FROM workflow_release_bundle WHERE release_bundle_id = ?';

function fail(reason: string): DeploymentResult {
  return { success: false, reason };
}

function isFeatureEnabled(flagName: string): boolean {
  const value = process.env[flagName] ?? '0';
  return value === 'shadow' || value === 'enforce';
}

function rowToDeploymentRun(row: DeploymentRunRow): DeploymentRun {
  return {
    schema: 'awkn-deployment-run/v1',
    deploymentRunId: row.deployment_run_id,
    releaseBundleId: row.release_bundle_id,
    targetEnvironment: row.target_environment,
    authorizationEnvelopeId: row.authorization_envelope_id,
    grayStage: GrayStageSchema.parse(row.gray_stage),
    healthStatus: HealthStatusSchema.parse(row.health_status),
    ...(row.final_verdict !== null ? { finalVerdict: row.final_verdict } : {}),
    ...(row.rollback_target_id !== null ? { rollbackTargetId: row.rollback_target_id } : {}),
    startedAt: row.started_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function updateDeploymentRun(
  deploymentRunId: string,
  fields: {
    grayStage?: GrayStage;
    healthStatus?: HealthStatus;
    finalVerdict?: string | null;
    rollbackTargetId?: string | null;
    completedAt?: string | null;
  },
): void {
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];
  if (fields.grayStage !== undefined) {
    sets.push('gray_stage = ?');
    params.push(fields.grayStage);
  }
  if (fields.healthStatus !== undefined) {
    sets.push('health_status = ?');
    params.push(fields.healthStatus);
  }
  if (fields.finalVerdict !== undefined) {
    sets.push('final_verdict = ?');
    params.push(fields.finalVerdict);
  }
  if (fields.rollbackTargetId !== undefined) {
    sets.push('rollback_target_id = ?');
    params.push(fields.rollbackTargetId);
  }
  if (fields.completedAt !== undefined) {
    sets.push('completed_at = ?');
    params.push(fields.completedAt);
  }
  params.push(deploymentRunId);
  queryRun(`UPDATE workflow_deployment_run SET ${sets.join(', ')} WHERE deployment_run_id = ?`, params);
}

function insertObservation(
  deploymentRunId: string,
  checkName: string,
  checkResult: string,
  detail: string,
): void {
  const observationId = createAwknId('event');
  const now = new Date().toISOString();
  queryRun(
    `INSERT INTO workflow_deployment_observation
       (observation_id, deployment_run_id, check_name, check_result, detail_json, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [observationId, deploymentRunId, checkName, checkResult, JSON.stringify({ detail }), now],
  );
}

function persistDeployReceipt(
  payload: DeployReceiptPayload,
  actorInstance: AgentInstanceV2,
  status: 'SUCCESS' | 'FAILURE',
): string {
  const receiptId = createAwknId('receipt');
  const executionId = createAwknId('execution');
  const traceId = createAwknId('trace');
  const now = new Date().toISOString();
  const payloadHash = receiptPayloadHash(DEPLOY_RECEIPT_PAYLOAD_SCHEMA, payload);
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
     VALUES (?, 'DEPLOY', ?, ?, ?, 'deployment_run', ?, ?, ?, ?, ?, '[]', ?)`,
    [
      receiptId,
      DEPLOY_RECEIPT_PAYLOAD_SCHEMA,
      executionId,
      traceId,
      payload.deploymentRunId,
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
 * 执行部署。
 *
 * 步骤：
 *   1. Feature flag 校验
 *   2. actor profile 状态校验
 *   3. Separation Policy v2（Deploy ↔ Engineer / Release / Review 不相容）
 *   4. 授权信封校验（allowDeploy + deployEnvironments 包含目标）
 *   5. 加载 ReleaseBundle
 *   6. 创建 DeploymentRun（PENDING）
 *   7. 灰度部署（CANARY）
 *   8. 健康检查（HEALTH_CHECK）
 *   9. HEALTHY → COMPLETED；UNHEALTHY → 自动回滚（ROLLED_BACK + RollbackTarget）
 *  10. 产出 DEPLOY 回执
 *
 * 不构建新制品：本函数仅读取 ReleaseBundle 并通过 provider 部署。
 */
export async function executeDeployment(
  params: ExecuteDeploymentParams,
): Promise<DeploymentResult> {
  // 1. Feature flag 校验
  if (!isFeatureEnabled('AWKN_DEPLOY_AGENT_V1')) {
    return fail('AWKN_DEPLOY_AGENT_V1 feature flag is disabled (0); cannot execute deployment');
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
    frozenInputHash: params.releaseBundleId,
    stageFrozenHash: params.releaseBundleId,
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
  if (!envelope.allow_deploy) {
    return fail(`authorization envelope ${params.envelopeId} does not allow deploy`);
  }
  let allowedEnvironments: string[] = [];
  if (envelope.deploy_environments) {
    try {
      allowedEnvironments = JSON.parse(envelope.deploy_environments) as string[];
    } catch {
      allowedEnvironments = [];
    }
  }
  if (!allowedEnvironments.includes(params.targetEnvironment)) {
    return fail(
      `target environment ${params.targetEnvironment} is not in deploy environments [${allowedEnvironments.join(', ')}]`,
    );
  }

  // 5. 加载 ReleaseBundle
  const bundle = queryOne<ReleaseBundleRow>(RELEASE_BUNDLE_SELECT_SQL, [params.releaseBundleId]);
  if (!bundle) {
    return fail(`release bundle not found: ${params.releaseBundleId}`);
  }

  // 6. 创建 DeploymentRun（PENDING）
  const deploymentRunId = createAwknId('deployTarget');
  const now = new Date().toISOString();
  queryRun(
    `INSERT INTO workflow_deployment_run
       (deployment_run_id, release_bundle_id, target_environment,
        authorization_envelope_id, gray_stage, health_status, final_verdict,
        rollback_target_id, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PENDING', 'UNKNOWN', NULL, NULL, ?, NULL, ?, ?)`,
    [
      deploymentRunId,
      params.releaseBundleId,
      params.targetEnvironment,
      params.envelopeId,
      now,
      now,
      now,
    ],
  );

  // 7. 灰度部署（CANARY）
  let canaryEndpoint: string;
  try {
    const deployResult = await params.provider.deploy({
      releaseBundleId: params.releaseBundleId,
      targetEnvironment: params.targetEnvironment,
      artifactDigest: bundle.artifact_digest,
    });
    canaryEndpoint = deployResult.canaryEndpoint;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateDeploymentRun(deploymentRunId, {
      grayStage: 'ROLLED_BACK',
      healthStatus: 'UNHEALTHY',
      finalVerdict: 'FAIL',
      completedAt: new Date().toISOString(),
    });
    insertObservation(deploymentRunId, 'canary_deploy', 'FAILURE', message);
    const row = queryOne<DeploymentRunRow>(
      'SELECT * FROM workflow_deployment_run WHERE deployment_run_id = ?',
      [deploymentRunId],
    )!;
    const payload: DeployReceiptPayload = {
      missionId: bundle.mission_id,
      releaseBundleId: params.releaseBundleId,
      deploymentRunId,
      envelopeId: params.envelopeId,
      targetEnvironment: params.targetEnvironment,
      grayStage: 'ROLLED_BACK',
      healthStatus: 'UNHEALTHY',
      verdict: 'FAIL',
    };
    const receiptId = persistDeployReceipt(payload, params.actorInstance, 'FAILURE');
    return {
      success: false,
      reason: `canary deploy failed: ${message}`,
      deploymentRun: rowToDeploymentRun(row),
      receiptId,
      rolledBack: true,
    };
  }

  updateDeploymentRun(deploymentRunId, { grayStage: 'CANARY' });
  insertObservation(deploymentRunId, 'canary_deploy', 'SUCCESS', canaryEndpoint);

  // 8. 健康检查（HEALTH_CHECK）
  const healthResult = await params.provider.healthCheck({
    releaseBundleId: params.releaseBundleId,
    canaryEndpoint,
    targetEnvironment: params.targetEnvironment,
  });
  updateDeploymentRun(deploymentRunId, {
    grayStage: 'HEALTH_CHECK',
    healthStatus: healthResult.status,
  });
  insertObservation(
    deploymentRunId,
    'health_check',
    healthResult.status,
    healthResult.detail,
  );

  // 9. HEALTHY → COMPLETED；UNHEALTHY → 自动回滚
  if (healthResult.status === 'HEALTHY') {
    updateDeploymentRun(deploymentRunId, {
      grayStage: 'COMPLETED',
      finalVerdict: 'PASS',
      completedAt: new Date().toISOString(),
    });
    const row = queryOne<DeploymentRunRow>(
      'SELECT * FROM workflow_deployment_run WHERE deployment_run_id = ?',
      [deploymentRunId],
    )!;
    const payload: DeployReceiptPayload = {
      missionId: bundle.mission_id,
      releaseBundleId: params.releaseBundleId,
      deploymentRunId,
      envelopeId: params.envelopeId,
      targetEnvironment: params.targetEnvironment,
      grayStage: 'COMPLETED',
      healthStatus: 'HEALTHY',
      verdict: 'PASS',
    };
    const receiptId = persistDeployReceipt(payload, params.actorInstance, 'SUCCESS');
    return {
      success: true,
      deploymentRun: rowToDeploymentRun(row),
      receiptId,
    };
  }

  // UNHEALTHY → 自动回滚
  const rollbackResult = await params.provider.rollback({
    releaseBundleId: params.releaseBundleId,
    targetEnvironment: params.targetEnvironment,
    previousSourceSha: bundle.frozen_source_sha,
  });

  // 创建 RollbackTarget
  const rollbackTargetId = createAwknId('deployTarget');
  const rollbackNow = new Date().toISOString();
  queryRun(
    `INSERT INTO workflow_rollback_target
       (rollback_target_id, deployment_run_id, previous_release_bundle_id,
        previous_source_sha, reason, created_at)
     VALUES (?, ?, NULL, ?, ?, ?)`,
    [
      rollbackTargetId,
      deploymentRunId,
      bundle.frozen_source_sha,
      rollbackResult.reason,
      rollbackNow,
    ],
  );

  updateDeploymentRun(deploymentRunId, {
    grayStage: 'ROLLED_BACK',
    finalVerdict: 'FAIL',
    rollbackTargetId,
    completedAt: rollbackNow,
  });

  const row = queryOne<DeploymentRunRow>(
    'SELECT * FROM workflow_deployment_run WHERE deployment_run_id = ?',
    [deploymentRunId],
  )!;
  const payload: DeployReceiptPayload = {
    missionId: bundle.mission_id,
    releaseBundleId: params.releaseBundleId,
    deploymentRunId,
    envelopeId: params.envelopeId,
    targetEnvironment: params.targetEnvironment,
    grayStage: 'ROLLED_BACK',
    healthStatus: 'UNHEALTHY',
    verdict: 'FAIL',
    rollbackTargetId,
  };
  const receiptId = persistDeployReceipt(payload, params.actorInstance, 'FAILURE');
  return {
    success: false,
    reason: `health check UNHEALTHY, auto-rollback performed: ${rollbackResult.reason}`,
    deploymentRun: rowToDeploymentRun(row),
    receiptId,
    rolledBack: true,
    rollbackTargetId,
  };
}
