/**
 * StageRun 持久化
 *
 * WorkflowStageRun 的 SQLite CRUD：创建、查询、状态更新、分配。
 * 表由 Migration v18 (agent-os-migration-registry) 创建。
 *
 * 对应契约: contracts/workflow-v2.ts — WorkflowStageRunSchema
 * 遵循模式: src/hierarchy/repository.ts
 */
import { createAwknId } from '../contracts/ids.js';
import type {
  StageRunState,
  StageWorkItemType,
  WorkflowStageRun,
  WorkflowStageType,
} from '../contracts/workflow-v2.js';
import { queryAll, queryOne, queryRun } from '../store/db.js';

// ─── Row 类型 ─────────────────────────────────────────────

interface StageRunRow {
  stage_run_id: string;
  mission_id: string;
  work_item_type: string;
  work_item_id: string;
  stage_type: string;
  state: string;
  required_profile_id: string;
  actor_id: string | null;
  frozen_input_hash: string;
  frozen_source_sha: string | null;
  frozen_artifact_digest: string | null;
  authorization_envelope_id: string;
  input_receipt_ids_json: string;
  output_receipt_id: string | null;
  attempt: number;
  idempotency_key: string;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── 转换函数 ─────────────────────────────────────────────

function rowToStageRun(row: StageRunRow): WorkflowStageRun {
  return {
    schema: 'awkn-workflow-stage-run/v1',
    stageRunId: row.stage_run_id,
    missionId: row.mission_id,
    workItemType: row.work_item_type as StageWorkItemType,
    workItemId: row.work_item_id,
    stageType: row.stage_type as WorkflowStageType,
    state: row.state as StageRunState,
    requiredProfileId: row.required_profile_id,
    actorId: row.actor_id ?? undefined,
    frozenInputHash: row.frozen_input_hash,
    frozenSourceSha: row.frozen_source_sha ?? undefined,
    frozenArtifactDigest: row.frozen_artifact_digest ?? undefined,
    authorizationEnvelopeId: row.authorization_envelope_id,
    inputReceiptIds: JSON.parse(row.input_receipt_ids_json) as string[],
    outputReceiptId: row.output_receipt_id ?? undefined,
    attempt: row.attempt,
    idempotencyKey: row.idempotency_key,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── CRUD ─────────────────────────────────────────────────

/**
 * 创建 StageRun，初始状态为 READY。
 *
 * idempotency_key 具有唯一约束：重复插入会抛出 SQLite UNIQUE 错误。
 * 调用方可通过 idempotency_key 实现幂等控制。
 */
export function createStageRun(
  missionId: string,
  workItemType: StageWorkItemType,
  workItemId: string,
  stageType: WorkflowStageType,
  requiredProfileId: string,
  frozenInputHash: string,
  authorizationEnvelopeId: string,
  inputReceiptIds: string[],
  idempotencyKey: string,
): WorkflowStageRun {
  const stageRunId = createAwknId('stageRun');
  const now = new Date().toISOString();
  queryRun(
    `INSERT INTO workflow_stage_run
       (stage_run_id, mission_id, work_item_type, work_item_id, stage_type, state,
        required_profile_id, frozen_input_hash, authorization_envelope_id,
        input_receipt_ids_json, attempt, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      stageRunId,
      missionId,
      workItemType,
      workItemId,
      stageType,
      requiredProfileId,
      frozenInputHash,
      authorizationEnvelopeId,
      JSON.stringify(inputReceiptIds),
      idempotencyKey,
      now,
      now,
    ],
  );
  return {
    schema: 'awkn-workflow-stage-run/v1',
    stageRunId,
    missionId,
    workItemType,
    workItemId,
    stageType,
    state: 'READY',
    requiredProfileId,
    frozenInputHash,
    authorizationEnvelopeId,
    inputReceiptIds,
    attempt: 0,
    idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
}

/** 按 ID 查询单个 StageRun。 */
export function getStageRun(stageRunId: string): WorkflowStageRun | undefined {
  const row = queryOne<StageRunRow>(
    'SELECT * FROM workflow_stage_run WHERE stage_run_id = ?',
    [stageRunId],
  );
  return row ? rowToStageRun(row) : undefined;
}

/** 查询某个工作项下的所有 StageRun。 */
export function getStageRunsByWorkItem(
  workItemType: StageWorkItemType,
  workItemId: string,
): WorkflowStageRun[] {
  return queryAll<StageRunRow>(
    'SELECT * FROM workflow_stage_run WHERE work_item_type = ? AND work_item_id = ? ORDER BY created_at',
    [workItemType, workItemId],
  ).map(rowToStageRun);
}

/** 查询某个 Mission 下的所有 StageRun。 */
export function getStageRunsByMission(missionId: string): WorkflowStageRun[] {
  return queryAll<StageRunRow>(
    'SELECT * FROM workflow_stage_run WHERE mission_id = ? ORDER BY created_at',
    [missionId],
  ).map(rowToStageRun);
}

/**
 * 更新 StageRun 状态。
 *
 * actorId 与 outputReceiptId 为可选参数：提供时覆盖现有值（COALESCE），
 * 未提供时保持原值不变。
 */
export function updateStageRunState(
  stageRunId: string,
  newState: StageRunState,
  actorId?: string,
  outputReceiptId?: string,
): void {
  const now = new Date().toISOString();
  queryRun(
    `UPDATE workflow_stage_run
     SET state = ?, actor_id = COALESCE(?, actor_id),
         output_receipt_id = COALESCE(?, output_receipt_id), updated_at = ?
     WHERE stage_run_id = ?`,
    [newState, actorId ?? null, outputReceiptId ?? null, now, stageRunId],
  );
}

/**
 * 分配 StageRun 给指定 actor。
 *
 * 将状态设为 ASSIGNED，记录 actor 与租约过期时间。
 */
export function assignStageRun(
  stageRunId: string,
  actorId: string,
  leaseExpiresAt: string,
): void {
  const now = new Date().toISOString();
  queryRun(
    `UPDATE workflow_stage_run
     SET state = 'ASSIGNED', actor_id = ?, lease_expires_at = ?, updated_at = ?
     WHERE stage_run_id = ?`,
    [actorId, leaseExpiresAt, now, stageRunId],
  );
}

/** 查询某个 actor 名下处于活跃状态（RUNNING / ASSIGNED）的 StageRun。 */
export function getActiveStageRunsByActor(actorId: string): WorkflowStageRun[] {
  return queryAll<StageRunRow>(
    `SELECT * FROM workflow_stage_run
     WHERE actor_id = ? AND state IN ('RUNNING', 'ASSIGNED')
     ORDER BY updated_at`,
    [actorId],
  ).map(rowToStageRun);
}

/** 查询某个 Mission 下处于 BLOCKED 状态的 StageRun。 */
export function getBlockedStageRuns(missionId: string): WorkflowStageRun[] {
  return queryAll<StageRunRow>(
    `SELECT * FROM workflow_stage_run
     WHERE mission_id = ? AND state = 'BLOCKED'
     ORDER BY updated_at`,
    [missionId],
  ).map(rowToStageRun);
}
