/**
 * Retrospective Coordinator — Spiral 4
 *
 * 对已完成工作项执行复盘，生成 DRAFT 候选并产出 RETROSPECTIVE receipt。
 *
 * 约束（CRITICAL）：
 * - 只能生成 DRAFT 候选，不得 promote/activate/quarantine
 * - 不得签署 quality 或 release PASS
 * - Retrospective actor 必须与前置 Evolution actor 分离（enforceSeparationV2）
 *
 * 对应契约: contracts/workflow-v2.ts — INCOMPATIBLE_PAIRS_V2 ['Retrospective','Evolution']
 *           contracts/receipts.ts — ReceiptType 'RETROSPECTIVE'
 */
import type Database from 'better-sqlite3';
import { createAwknId } from '../contracts/ids.js';
import { stableHash } from '../contracts/canonical-json.js';
import { enforceSeparationV2, type SeparationCheckParams } from '../governor/separation-policy-v2.js';
import type { AgentInstanceV2, AgentProfileV2 } from '../contracts/workflow-v2.js';
import { getDb, queryAll, queryOne, queryRun, transaction } from '../store/db.js';
import {
  RetrospectiveCandidateSchema,
  RetrospectiveLayerSchema,
  RetrospectiveReceiptPayloadSchema,
  type RetrospectiveCandidate,
  type RetrospectiveCandidateRow,
  type RetrospectiveLayer,
  type RetrospectiveReceiptPayload,
} from './contracts.js';
import {
  deduplicateCandidates,
  normalizeRetrospectiveInput,
  rankCandidatesBySeverity,
  toRetrospectiveCandidate,
  type NormalizedCandidateInput,
  type RetrospectiveRawInput,
} from './candidate-normalizer.js';

// ─── 层级映射 ─────────────────────────────────────────────

const LAYER_TO_WORK_ITEM_TYPE: Record<RetrospectiveLayer, string> = {
  WORKPACKAGE: 'workpackage',
  MODULE: 'module',
  COMPONENT: 'component',
  MISSION: 'mission',
};

// ─── 行转换 ───────────────────────────────────────────────

function rowToCandidate(row: RetrospectiveCandidateRow): RetrospectiveCandidate {
  const candidate: RetrospectiveCandidate = {
    schema: 'awkn-retrospective-candidate/v1',
    candidateId: row.candidate_id,
    missionId: row.mission_id,
    layer: RetrospectiveLayerSchema.parse(row.layer),
    workItemId: row.work_item_id,
    workItemType: row.work_item_type,
    summary: row.summary,
    lessons: JSON.parse(row.lessons_json) as string[],
    evidenceReceiptIds: JSON.parse(row.evidence_receipt_ids_json) as string[],
    proposedAction: row.proposed_action as RetrospectiveCandidate['proposedAction'],
    severity: row.severity as RetrospectiveCandidate['severity'],
    generatedByActorId: row.generated_by_actor_id,
    generatedAt: row.generated_at,
  };
  return RetrospectiveCandidateSchema.parse(candidate);
}

// ─── 查询已完成工作项数据 ─────────────────────────────────

interface StageReceiptInfo {
  receiptId: string;
  receiptType: string;
  verdict: string;
  evidenceRefs: string[];
}

interface CompletedStageInfo {
  stageRunId: string;
  stageType: string;
  state: string;
  outputReceiptId: string | null;
}

function queryCompletedStages(
  db: Database.Database,
  missionId: string,
  workItemType: string,
  workItemId: string,
): CompletedStageInfo[] {
  return db.prepare(
    `SELECT stage_run_id, stage_type, state, output_receipt_id
     FROM workflow_stage_run
     WHERE mission_id = ? AND work_item_type = ? AND work_item_id = ?
     ORDER BY created_at`,
  ).all(missionId, workItemType, workItemId) as CompletedStageInfo[];
}

function queryReceiptInfo(
  db: Database.Database,
  receiptId: string,
): StageReceiptInfo | null {
  const row = db.prepare(
    `SELECT id, receipt_type, status, payload_json
     FROM receipts WHERE id = ?`,
  ).get(receiptId) as
    | { id: string; receipt_type: string; status: string; payload_json: string }
    | undefined;
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const verdict = typeof payload.verdict === 'string' ? payload.verdict : row.status;
  const evidenceRefs = Array.isArray(payload.evidenceRefs)
    ? (payload.evidenceRefs as string[]).filter((r) => typeof r === 'string')
    : [];
  return {
    receiptId: row.id,
    receiptType: row.receipt_type,
    verdict,
    evidenceRefs,
  };
}

// ─── 参数与结果类型 ───────────────────────────────────────

export interface RunRetrospectiveParams {
  missionId: string;
  layer: RetrospectiveLayer;
  workItemId: string;
  actorInstance: AgentInstanceV2;
  actorProfile: AgentProfileV2;
  priorInstances: AgentInstanceV2[];
  priorProfiles: AgentProfileV2[];
  authorizationEnvelopeId: string;
}

export interface RunRetrospectiveResult {
  success: boolean;
  reason?: string;
  candidates: RetrospectiveCandidate[];
  receiptId?: string;
  receiptPayload?: RetrospectiveReceiptPayload;
}

// ─── 主入口 ───────────────────────────────────────────────

/**
 * 执行复盘：对已完成工作项生成 DRAFT 候选 + RETROSPECTIVE receipt。
 *
 * 步骤：
 * 1. 强制分离策略（Retrospective ≠ Evolution actor）
 * 2. 查询已完成工作项的 stages + receipts
 * 3. 通过 candidate-normalizer 归一化、去重、排序
 * 4. 持久化候选（evolution_status = 'DRAFT'）
 * 5. 产出 RETROSPECTIVE receipt（verdict PASS/PARTIAL/BLOCKED）
 *
 * 约束：
 * - 候选始终为 DRAFT，不执行任何状态迁移
 * - 不签署 quality/release PASS
 */
export function runRetrospective(params: RunRetrospectiveParams): RunRetrospectiveResult {
  const db = getDb();
  const workItemType = LAYER_TO_WORK_ITEM_TYPE[params.layer];

  // 1. 强制分离策略
  const separationParams: SeparationCheckParams = {
    currentProfile: params.actorProfile,
    currentInstance: params.actorInstance,
    priorInstances: params.priorInstances,
    priorProfiles: params.priorProfiles,
    authorizationEnvelopeId: params.authorizationEnvelopeId,
    workspacePolicy: 'read_write',
    frozenInputHash: params.actorInstance.permissionSnapshotHash,
    stageFrozenHash: params.actorInstance.permissionSnapshotHash,
    availableBudget: 1000,
    availableConcurrency: 1,
  };
  const separation = enforceSeparationV2(separationParams);
  if (!separation.allowed) {
    return {
      success: false,
      reason: `separation policy denied: ${separation.reason ?? 'unknown'}`,
      candidates: [],
    };
  }

  // 2. 查询已完成工作项数据
  const stages = queryCompletedStages(db, params.missionId, workItemType, params.workItemId);
  if (stages.length === 0) {
    return {
      success: false,
      reason: `no completed stages found for ${params.layer} ${params.workItemId}`,
      candidates: [],
    };
  }

  const receipts: StageReceiptInfo[] = [];
  const failures: Array<{ stageType: string; reason: string; severity: 'INFO' | 'WARN' | 'ERROR' }> = [];
  for (const stage of stages) {
    if (stage.outputReceiptId) {
      const info = queryReceiptInfo(db, stage.outputReceiptId);
      if (info) receipts.push(info);
    }
    if (stage.state === 'FAILED' || stage.state === 'ROLLED_BACK' || stage.state === 'QUARANTINED') {
      failures.push({
        stageType: stage.stageType,
        reason: `stage ${stage.stageType} ended in ${stage.state}`,
        severity: stage.state === 'FAILED' ? 'ERROR' : 'WARN',
      });
    }
  }

  // 3. 归一化、去重、排序
  const rawInput: RetrospectiveRawInput = {
    missionId: params.missionId,
    layer: params.layer,
    workItemId: params.workItemId,
    workItemType,
    receipts,
    failures,
    generatedByActorId: params.actorInstance.actorId,
  };
  let normalized = normalizeRetrospectiveInput(rawInput);
  normalized = deduplicateCandidates(normalized);
  normalized = rankCandidatesBySeverity(normalized);

  if (normalized.length === 0) {
    return {
      success: false,
      reason: 'no candidates generated after normalization',
      candidates: [],
    };
  }

  // 4. 持久化候选（DRAFT）
  const candidates = persistCandidates(db, normalized);

  // 5. 产出 RETROSPECTIVE receipt
  const hasFailures = failures.length > 0;
  const verdict: RetrospectiveReceiptPayload['verdict'] = hasFailures
    ? (failures.some((f) => f.severity === 'ERROR') ? 'BLOCKED' : 'PARTIAL')
    : 'PASS';

  const receiptPayload: RetrospectiveReceiptPayload = {
    schema: 'awkn-retrospective-receipt/v1',
    missionId: params.missionId,
    layer: params.layer,
    workItemId: params.workItemId,
    candidateIds: candidates.map((c) => c.candidateId),
    verdict,
    summary: `retrospective for ${params.layer} ${params.workItemId}: ${candidates.length} candidate(s)`,
  };
  RetrospectiveReceiptPayloadSchema.parse(receiptPayload);
  const receiptId = persistRetrospectiveReceipt(db, params, receiptPayload);

  return {
    success: true,
    candidates,
    receiptId,
    receiptPayload,
  };
}

// ─── 持久化 ───────────────────────────────────────────────

function persistCandidates(
  db: Database.Database,
  inputs: NormalizedCandidateInput[],
): RetrospectiveCandidate[] {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO workflow_retrospective_candidate
       (candidate_id, mission_id, layer, work_item_id, work_item_type, summary,
        lessons_json, evidence_receipt_ids_json, proposed_action, severity,
        generated_by_actor_id, generated_at, evolution_status,
        previous_active_candidate_id, linked_evolution_candidate_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', NULL, NULL, ?, ?)`,
  );
  return transaction((): RetrospectiveCandidate[] => {
    const result: RetrospectiveCandidate[] = [];
    for (const input of inputs) {
      insert.run(
        input.candidateId,
        input.missionId,
        input.layer,
        input.workItemId,
        input.workItemType,
        input.summary,
        JSON.stringify(input.lessons),
        JSON.stringify(input.evidenceReceiptIds),
        input.proposedAction,
        input.severity,
        input.generatedByActorId,
        input.generatedAt,
        now,
        now,
      );
      result.push(toRetrospectiveCandidate(input));
    }
    return result;
  });
}

function persistRetrospectiveReceipt(
  db: Database.Database,
  params: RunRetrospectiveParams,
  payload: RetrospectiveReceiptPayload,
): string {
  const receiptId = createAwknId('receipt');
  const now = new Date().toISOString();
  const execId = createAwknId('execution');
  const traceId = createAwknId('trace');
  const payloadSchema = 'awkn-retrospective-receipt/v1';
  const payloadHash = stableHash(payloadSchema, payload);
  const producer = {
    schema: 'awkn-actor-ref/v1',
    actorId: params.actorInstance.actorId,
    actorType: 'assistant' as const,
  };

  // 确保 execution 存在（幂等）
  db.prepare(
    `INSERT OR IGNORE INTO executions
       (id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
        input_ref_json, feature_flags_ref_json, state, created_at, updated_at)
     VALUES (?, ?, 0, ?, 'awkn-actor-ref/v1', '{}', 'awkn-execution-scope/v1',
             '{}', '{}', 'RECEIVED', ?, ?)`,
  ).run(execId, traceId, JSON.stringify(producer), now, now);

  db.prepare(
    `INSERT INTO receipts
       (id, receipt_type, payload_schema, execution_id, trace_id,
        aggregate_type, aggregate_id, producer_json, status,
        payload_json, payload_hash, artifact_refs_json, created_at)
     VALUES (?, 'RETROSPECTIVE', ?, ?, ?, 'retrospective', ?, ?, 'SUCCESS', ?, ?, '[]', ?)`,
  ).run(
    receiptId,
    payloadSchema,
    execId,
    traceId,
    payload.workItemId,
    JSON.stringify(producer),
    JSON.stringify(payload),
    payloadHash,
    now,
  );

  return receiptId;
}

// ─── 查询 ─────────────────────────────────────────────────

/**
 * 查询已持久化的复盘候选。
 * 可选按 layer 过滤；返回候选按 created_at 升序。
 */
export function getRetrospectiveCandidates(
  missionId: string,
  layer?: RetrospectiveLayer,
): RetrospectiveCandidate[] {
  const rows = layer
    ? queryAll<RetrospectiveCandidateRow>(
        `SELECT * FROM workflow_retrospective_candidate
         WHERE mission_id = ? AND layer = ?
         ORDER BY created_at, rowid`,
        [missionId, layer],
      )
    : queryAll<RetrospectiveCandidateRow>(
        `SELECT * FROM workflow_retrospective_candidate
         WHERE mission_id = ?
         ORDER BY created_at, rowid`,
        [missionId],
      );
  return rows.map(rowToCandidate);
}

/**
 * 按 candidateId 读取单个复盘候选（含 evolution_status 等持久化字段）。
 */
export function getRetrospectiveCandidateById(
  candidateId: string,
): RetrospectiveCandidateRow | null {
  const row = queryOne<RetrospectiveCandidateRow>(
    `SELECT * FROM workflow_retrospective_candidate WHERE candidate_id = ?`,
    [candidateId],
  );
  return row ?? null;
}

/**
 * 更新复盘候选的 evolution_status（仅供 retrospective-bridge 调用）。
 */
export function updateRetrospectiveCandidateStatus(
  candidateId: string,
  newStatus: string,
  linkedEvolutionCandidateId?: string,
  previousActiveCandidateId?: string | null,
): void {
  const now = new Date().toISOString();
  const sets: string[] = ['evolution_status = ?', 'updated_at = ?'];
  const values: unknown[] = [newStatus, now];
  if (linkedEvolutionCandidateId !== undefined) {
    sets.push('linked_evolution_candidate_id = ?');
    values.push(linkedEvolutionCandidateId);
  }
  if (previousActiveCandidateId !== undefined) {
    sets.push('previous_active_candidate_id = ?');
    values.push(previousActiveCandidateId);
  }
  values.push(candidateId);
  queryRun(
    `UPDATE workflow_retrospective_candidate SET ${sets.join(', ')} WHERE candidate_id = ?`,
    values,
  );
}
