/**
 * Recovery Coordinator — 恢复协调器
 *
 * Spiral 3: 执行恢复动作。职责：
 *   1. Feature flag 校验（AWKN_RECOVERY_AGENT_V1）
 *   2. 分类失败（classifyFailure）
 *   3. 检查 attempt < maxAttempts（超限则 QUARANTINED）
 *   4. 执行恢复动作（RETRY/REASSIGN/ROLLBACK/QUARANTINE/ESCALATE）
 *   5. 持久化到 workflow_recovery_attempt
 *   6. 产出 RECOVERY 回执
 *
 * 约束：Recovery Agent 不签署质量或发布 PASS（仅恢复动作）。
 *
 * 对应契约: recovery/contracts.ts — RecoveryAttemptSchema
 */
import { createAwknId } from '../contracts/ids.js';
import { receiptPayloadHash } from '../contracts/receipts.js';
import { queryOne, queryRun } from '../store/db.js';
import type { AgentInstanceV2, AgentProfileV2 } from '../contracts/workflow-v2.js';
import { classifyFailure, type FailureInput } from './classifier.js';
import {
  RECOVERY_RECEIPT_PAYLOAD_SCHEMA,
  type RecoveryAction,
  type RecoveryAttempt,
  type RecoveryReceiptPayload,
  type RecoveryStatus,
} from './contracts.js';

// ─── 公共类型 ─────────────────────────────────────────────

export interface AttemptRecoveryParams {
  readonly missionId: string;
  readonly envelopeId: string;
  readonly stageRunId?: string;
  readonly deploymentRunId?: string;
  readonly failureInfo: FailureInput;
  readonly actorInstance: AgentInstanceV2;
  readonly actorProfile: AgentProfileV2;
  readonly priorInstances: readonly AgentInstanceV2[];
  readonly priorProfiles: readonly AgentProfileV2[];
  readonly attempt: number;
  readonly maxAttempts?: number;
}

export interface RecoveryResult {
  readonly success: boolean;
  readonly reason?: string;
  readonly recoveryAttempt?: RecoveryAttempt;
  readonly receiptId?: string;
  readonly rollbackTargetId?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

// ─── 内部辅助 ─────────────────────────────────────────────

function isFeatureEnabled(flagName: string): boolean {
  const value = process.env[flagName] ?? '0';
  return value === 'shadow' || value === 'enforce';
}

/**
 * 质量与发布 PASS 守卫。
 *
 * Recovery Agent 不得签署质量（quality）或发布（release）PASS。
 * 调用此函数时若 verdict 为 PASS，立即抛出错误。
 *
 * 这是硬约束：Recovery Agent 的回执仅反映恢复动作的成功与否，
 * 绝不代表质量门禁或发布门禁通过。
 */
export function assertNotSigningQualityOrReleasePass(
  context: 'quality' | 'release',
  verdict: string,
): void {
  if (verdict === 'PASS') {
    throw new Error(
      `Recovery Agent MUST NOT sign ${context} PASS; recovery actions only`,
    );
  }
}

function persistRecoveryReceipt(
  payload: RecoveryReceiptPayload,
  actorInstance: AgentInstanceV2,
  status: 'SUCCESS' | 'FAILURE',
): string {
  const receiptId = createAwknId('receipt');
  const executionId = createAwknId('execution');
  const traceId = createAwknId('trace');
  const now = new Date().toISOString();
  const payloadHash = receiptPayloadHash(RECOVERY_RECEIPT_PAYLOAD_SCHEMA, payload);
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
     VALUES (?, 'RECOVERY', ?, ?, ?, 'recovery_attempt', ?, ?, ?, ?, ?, '[]', ?)`,
    [
      receiptId,
      RECOVERY_RECEIPT_PAYLOAD_SCHEMA,
      executionId,
      traceId,
      payload.deploymentRunId ?? payload.stageRunId ?? actorInstance.actorId,
      JSON.stringify(producer),
      status,
      JSON.stringify(payload),
      payloadHash,
      now,
    ],
  );

  return receiptId;
}

function readRecoveryAttempt(recoveryAttemptId: string): RecoveryAttempt | undefined {
  const row = queryOne<{
    recovery_attempt_id: string;
    stage_run_id: string | null;
    deployment_run_id: string | null;
    failure_class: string;
    recovery_action: string;
    attempt: number;
    max_attempts: number;
    status: string;
    result_detail_json: string;
    created_at: string;
    updated_at: string;
  }>(
    'SELECT * FROM workflow_recovery_attempt WHERE recovery_attempt_id = ?',
    [recoveryAttemptId],
  );
  if (!row) return undefined;
  return {
    schema: 'awkn-recovery-attempt/v1',
    recoveryAttemptId: row.recovery_attempt_id,
    ...(row.stage_run_id !== null ? { stageRunId: row.stage_run_id } : {}),
    ...(row.deployment_run_id !== null ? { deploymentRunId: row.deployment_run_id } : {}),
    failureClass: row.failure_class as RecoveryAttempt['failureClass'],
    recoveryAction: row.recovery_action as RecoveryAction,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    status: row.status as RecoveryStatus,
    resultDetail: row.result_detail_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── 主入口 ───────────────────────────────────────────────

/**
 * 执行恢复。
 *
 * 步骤：
 *   1. Feature flag 校验
 *   2. 分类失败
 *   3. 判定 attempt 是否超限（超限 → QUARANTINE）
 *   4. 执行恢复动作
 *   5. 持久化恢复尝试
 *   6. 产出 RECOVERY 回执
 *
 * 不签署质量或发布 PASS：恢复回执的 verdict 反映恢复动作成功与否，
 * 不代表质量门禁或发布门禁通过。
 */
export async function attemptRecovery(
  params: AttemptRecoveryParams,
): Promise<RecoveryResult> {
  // 1. Feature flag 校验
  if (!isFeatureEnabled('AWKN_RECOVERY_AGENT_V1')) {
    return { success: false, reason: 'AWKN_RECOVERY_AGENT_V1 feature flag is disabled (0); cannot attempt recovery' };
  }

  // 2. 分类失败
  const classification = classifyFailure(params.failureInfo);
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // 3. 判定 attempt 是否超限
  let action: RecoveryAction = classification.recommendedAction;
  let status: RecoveryStatus = 'IN_PROGRESS';
  let resultDetail = classification.reason;
  let verdict: 'PASS' | 'FAIL' | 'BLOCKED' = 'FAIL';

  if (params.attempt >= maxAttempts) {
    // 超限 → 强制 QUARANTINE
    action = 'QUARANTINE';
    status = 'QUARANTINED';
    resultDetail = `attempt ${params.attempt} >= maxAttempts ${maxAttempts}; quarantined`;
    verdict = 'BLOCKED';
    // 将 stage_run 状态迁移到 QUARANTINED，使隔离动作对外可见
    if (params.stageRunId) {
      queryRun(
        `UPDATE workflow_stage_run SET state = 'QUARANTINED', updated_at = ?
         WHERE stage_run_id = ?`,
        [new Date().toISOString(), params.stageRunId],
      );
    }
  } else {
    // 4. 执行恢复动作
    switch (action) {
      case 'RETRY': {
        if (params.stageRunId) {
          queryRun(
            `UPDATE workflow_stage_run SET state = 'READY', lease_expires_at = NULL, updated_at = ?
             WHERE stage_run_id = ?`,
            [new Date().toISOString(), params.stageRunId],
          );
        }
        status = 'SUCCEEDED';
        verdict = 'PASS';
        resultDetail = `retry: stage ${params.stageRunId ?? 'n/a'} reset to READY`;
        break;
      }
      case 'REASSIGN': {
        if (params.stageRunId) {
          queryRun(
            `UPDATE workflow_stage_run SET state = 'READY', actor_id = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE stage_run_id = ?`,
            [new Date().toISOString(), params.stageRunId],
          );
        }
        status = 'SUCCEEDED';
        verdict = 'PASS';
        resultDetail = `reassign: stage ${params.stageRunId ?? 'n/a'} actor cleared, reset to READY`;
        break;
      }
      case 'ROLLBACK': {
        let rollbackTargetId: string | undefined;
        if (params.stageRunId) {
          queryRun(
            `UPDATE workflow_stage_run SET state = 'ROLLED_BACK', updated_at = ?
             WHERE stage_run_id = ?`,
            [new Date().toISOString(), params.stageRunId],
          );
        }
        if (params.deploymentRunId) {
          rollbackTargetId = createAwknId('deployTarget');
          const now = new Date().toISOString();
          queryRun(
            `INSERT INTO workflow_rollback_target
               (rollback_target_id, deployment_run_id, previous_release_bundle_id,
                previous_source_sha, reason, created_at)
             VALUES (?, ?, NULL, ?, ?, ?)`,
            [
              rollbackTargetId,
              params.deploymentRunId,
              'unknown',
              `recovery rollback: ${classification.reason}`,
              now,
            ],
          );
          queryRun(
            `UPDATE workflow_deployment_run SET gray_stage = 'ROLLED_BACK', final_verdict = 'FAIL',
             completed_at = ?, updated_at = ? WHERE deployment_run_id = ?`,
            [now, now, params.deploymentRunId],
          );
        }
        status = 'SUCCEEDED';
        verdict = 'PASS';
        resultDetail = `rollback: ${params.stageRunId ? `stage ${params.stageRunId} ` : ''}${params.deploymentRunId ? `deployment ${params.deploymentRunId}` : ''} rolled back`;
        if (rollbackTargetId) {
          resultDetail += `; rollbackTargetId=${rollbackTargetId}`;
        }
        break;
      }
      case 'QUARANTINE': {
        if (params.stageRunId) {
          queryRun(
            `UPDATE workflow_stage_run SET state = 'QUARANTINED', updated_at = ?
             WHERE stage_run_id = ?`,
            [new Date().toISOString(), params.stageRunId],
          );
        }
        status = 'QUARANTINED';
        verdict = 'BLOCKED';
        resultDetail = `quarantine: stage ${params.stageRunId ?? 'n/a'} quarantined`;
        break;
      }
      case 'ESCALATE': {
        status = 'FAILED';
        verdict = 'FAIL';
        resultDetail = `escalate: ${classification.reason}; requires human intervention`;
        break;
      }
    }
  }

  // 5. 持久化恢复尝试
  const recoveryAttemptId = createAwknId('run');
  const now = new Date().toISOString();
  queryRun(
    `INSERT INTO workflow_recovery_attempt
       (recovery_attempt_id, stage_run_id, deployment_run_id, failure_class,
        recovery_action, attempt, max_attempts, status, result_detail_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      recoveryAttemptId,
      params.stageRunId ?? null,
      params.deploymentRunId ?? null,
      classification.failureClass,
      action,
      params.attempt,
      maxAttempts,
      status,
      JSON.stringify({ detail: resultDetail }),
      now,
      now,
    ],
  );

  const recoveryAttempt = readRecoveryAttempt(recoveryAttemptId);

  // 6. 产出 RECOVERY 回执
  //    守卫：Recovery Agent 不签署质量或发布 PASS。
  //    此处的 verdict 仅反映恢复动作的结果，不涉及质量/发布门禁。
  const payload: RecoveryReceiptPayload = {
    missionId: params.missionId,
    envelopeId: params.envelopeId,
    ...(params.stageRunId !== undefined ? { stageRunId: params.stageRunId } : {}),
    ...(params.deploymentRunId !== undefined ? { deploymentRunId: params.deploymentRunId } : {}),
    failureClass: classification.failureClass,
    recoveryAction: action,
    attempt: params.attempt,
    verdict,
  };
  const receiptStatus = verdict === 'PASS' ? 'SUCCESS' : 'FAILURE';
  const receiptId = persistRecoveryReceipt(payload, params.actorInstance, receiptStatus);

  return {
    success: verdict === 'PASS',
    reason: resultDetail,
    recoveryAttempt,
    receiptId,
  };
}
