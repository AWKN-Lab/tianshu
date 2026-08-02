/**
 * Stage 级状态迁移门卫 — 唯一可将 StageRun 迁移到终态的实体
 *
 * 终态: PASSED, FAILED, ROLLED_BACK, QUARANTINED (STAGE_TERMINAL_STATES)
 *
 * 验证项:
 *   1. toState 是合法 StageRunState
 *   2. StageRun 存在且不在终态
 *   3. 幂等性 — idempotency_key 唯一
 *   4. actor profile 为 ACTIVE 或 CANARY
 *   5. Separation Policy v2 通过
 *   6. PASSED: trigger receipt 存在、SUCCESS、在 lease 内新鲜
 *   7. FAILED: attempt < maxAttempts（否则应 ROLLED_BACK）
 *   8. Frozen target hash 一致性（若 stageRun 有 frozenSourceSha，receipt 须引用同一 frozen target）
 *
 * 仅在全部校验通过后通过 updateStageRunState 写入终态。
 *
 * 表: state_transition_log (Migration v18), workflow_stage_run (Migration v19)
 */
import { createAwknId } from '../contracts/ids.js';
import {
  StoredReceiptEnvelopeSchema,
  validateReceiptPayloadHash,
  type StoredReceiptEnvelope,
} from '../contracts/receipts.js';
import {
  AgentInstanceV2Schema,
  AgentProfileV2Schema,
  STAGE_TERMINAL_STATES,
  StageRunStateSchema,
  type AgentInstanceV2,
  type AgentProfileV2,
  type StageRunState,
} from '../contracts/workflow-v2.js';
import {
  WorkflowReceiptPayloadSchema,
  type WorkflowReceiptPayload,
} from '../contracts/workflow.js';
import { queryOne, queryRun, transaction } from '../store/db.js';
import { enforceSeparationV2, type SeparationCheckParams } from './separation-policy-v2.js';
import { getStageRun, updateStageRunState } from '../workflow/stage-store.js';

// ─── 公共类型 ─────────────────────────────────────────────

export interface StageTransitionParams {
  readonly stageRunId: string;
  readonly toState: StageRunState;
  readonly actorInstance: AgentInstanceV2;
  readonly actorProfile: AgentProfileV2;
  readonly triggerReceiptId: string;
  readonly priorInstances: readonly AgentInstanceV2[];
  readonly priorProfiles: readonly AgentProfileV2[];
  readonly outputReceiptId?: string;
  readonly idempotencyKey: string;
}

export interface StageTransitionResult {
  readonly success: boolean;
  readonly reason?: string;
  readonly newState?: StageRunState;
}

// ─── DB Row 类型 ──────────────────────────────────────────

interface ReceiptRow {
  readonly id: string;
  readonly receipt_type: string;
  readonly payload_schema: string;
  readonly execution_id: string;
  readonly trace_id: string;
  readonly run_id: string | null;
  readonly step_id: string | null;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly producer_json: string;
  readonly status: string;
  readonly payload_json: string;
  readonly payload_hash: string;
  readonly artifact_refs_json: string;
  readonly created_at: string;
}

interface ExistingTransitionRow {
  readonly id: string;
  readonly to_state: string;
}

// ─── SQL 常量 ─────────────────────────────────────────────

const RECEIPT_SELECT_SQL = `
  SELECT id, receipt_type, payload_schema, execution_id, trace_id,
         run_id, step_id, aggregate_type, aggregate_id,
         producer_json, status, payload_json, payload_hash,
         artifact_refs_json, created_at
  FROM receipts WHERE id = ?
`;

const TRANSITION_DEDUP_SQL =
  'SELECT id, to_state FROM state_transition_log WHERE idempotency_key = ?';

const TRANSITION_INSERT_SQL = `
  INSERT INTO state_transition_log
    (id, work_item_id, item_type, from_state, to_state, actor_id,
     trigger_receipt_id, input_hash, idempotency_key, transitioned_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// ─── 内部辅助 ─────────────────────────────────────────────

function deny(reason: string): StageTransitionResult {
  return { success: false, reason };
}

function loadReceiptRow(receiptId: string): ReceiptRow | undefined {
  return queryOne<ReceiptRow>(RECEIPT_SELECT_SQL, [receiptId]);
}

function parseReceipt(row: ReceiptRow): StoredReceiptEnvelope | undefined {
  let producer: unknown;
  let payload: unknown;
  let artifactRefs: unknown;
  try {
    producer = JSON.parse(row.producer_json);
    payload = JSON.parse(row.payload_json);
    artifactRefs = JSON.parse(row.artifact_refs_json);
  } catch {
    return undefined;
  }
  const result = StoredReceiptEnvelopeSchema.safeParse({
    schema: 'awkn-receipt-envelope/v1',
    receiptId: row.id,
    receiptType: row.receipt_type,
    payloadSchema: row.payload_schema,
    executionId: row.execution_id,
    traceId: row.trace_id,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.step_id !== null ? { stepId: row.step_id } : {}),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    producer,
    status: row.status,
    payload,
    payloadHash: row.payload_hash,
    artifactRefs,
    createdAt: row.created_at,
  });
  return result.success ? result.data : undefined;
}

function extractWorkflowPayload(
  receipt: StoredReceiptEnvelope,
): WorkflowReceiptPayload | undefined {
  const result = WorkflowReceiptPayloadSchema.safeParse(receipt.payload);
  return result.success ? result.data : undefined;
}

// ─── 主入口 ───────────────────────────────────────────────

export function transitionStageState(params: StageTransitionParams): StageTransitionResult {
  // 1. toState 必须是合法 StageRunState
  const stateParse = StageRunStateSchema.safeParse(params.toState);
  if (!stateParse.success) {
    return deny(`toState ${params.toState} is not a valid StageRunState`);
  }

  // 4. actor profile 必须是 ACTIVE 或 CANARY（提前校验，避免无谓 DB 访问）
  if (params.actorProfile.status !== 'ACTIVE' && params.actorProfile.status !== 'CANARY') {
    return deny(
      `actor profile ${params.actorProfile.profileId} status is ${params.actorProfile.status}, must be ACTIVE or CANARY`,
    );
  }

  // actor 实例/profile 结构校验
  const instanceParse = AgentInstanceV2Schema.safeParse(params.actorInstance);
  if (!instanceParse.success) {
    return deny(`invalid actor instance: ${instanceParse.error.message}`);
  }
  const profileParse = AgentProfileV2Schema.safeParse(params.actorProfile);
  if (!profileParse.success) {
    return deny(`invalid actor profile: ${profileParse.error.message}`);
  }

  // 2-8. 事务内完成所有 DB 校验 + 记录（原子性）
  return transaction((): StageTransitionResult => {
    // 2. StageRun 存在且不在终态
    const stageRun = getStageRun(params.stageRunId);
    if (!stageRun) {
      return deny(`stage run not found: ${params.stageRunId}`);
    }
    if (STAGE_TERMINAL_STATES.has(stageRun.state)) {
      return deny(
        `stage run ${params.stageRunId} is already in terminal state ${stageRun.state}`,
      );
    }

    // 3. 幂等性 — 相同 idempotency_key 视为重复请求
    const existing = queryOne<ExistingTransitionRow>(TRANSITION_DEDUP_SQL, [
      params.idempotencyKey,
    ]);
    if (existing) {
      if (existing.to_state === params.toState) {
        return { success: true, newState: params.toState };
      }
      return deny(
        `idempotency key conflict: ${params.idempotencyKey} already used for transition to ${existing.to_state}`,
      );
    }

    // 5. Separation Policy v2
    //    workspacePolicy/budget/concurrency 在 governor 层无独立追踪，使用安全默认值；
    //    lease 仍由 enforceSeparationV2 基于 actorInstance.leaseExpiresAt 校验。
    const separationParams: SeparationCheckParams = {
      currentProfile: params.actorProfile,
      currentInstance: params.actorInstance,
      priorInstances: params.priorInstances,
      priorProfiles: params.priorProfiles,
      authorizationEnvelopeId: stageRun.authorizationEnvelopeId,
      workspacePolicy: 'read_write',
      frozenInputHash: stageRun.frozenInputHash,
      stageFrozenHash: stageRun.frozenInputHash,
      availableBudget: Number.MAX_SAFE_INTEGER,
      availableConcurrency: 1,
    };
    const separation = enforceSeparationV2(separationParams);
    if (!separation.allowed) {
      return deny(
        separation.reason ??
          `separation policy v2 failed at step ${separation.step ?? '?'}`,
      );
    }

    // 6 & 8 需要加载 trigger receipt：PASSED 必须校验 receipt；
    //    frozenSourceSha 存在时任何迁移都须校验 frozen target 一致性。
    const needsReceipt =
      params.toState === 'PASSED' || stageRun.frozenSourceSha !== undefined;
    let receipt: StoredReceiptEnvelope | undefined;
    if (needsReceipt) {
      const receiptRow = loadReceiptRow(params.triggerReceiptId);
      if (!receiptRow) {
        return deny(`trigger receipt not found: ${params.triggerReceiptId}`);
      }
      receipt = parseReceipt(receiptRow);
      if (!receipt) {
        return deny(`trigger receipt envelope is invalid: ${params.triggerReceiptId}`);
      }
    }

    // 6. PASSED: trigger receipt 必须 SUCCESS + 在 actor lease 内新鲜
    if (params.toState === 'PASSED') {
      if (!receipt) {
        return deny(`trigger receipt not available for PASSED: ${params.triggerReceiptId}`);
      }
      if (receipt.status !== 'SUCCESS') {
        return deny(`trigger receipt status is ${receipt.status}, must be SUCCESS`);
      }
      if (!validateReceiptPayloadHash(receipt)) {
        return deny(`trigger receipt payload hash mismatch: ${params.triggerReceiptId}`);
      }
      if (
        receipt.createdAt < params.actorInstance.createdAt ||
        receipt.createdAt > params.actorInstance.leaseExpiresAt
      ) {
        return deny(
          `trigger receipt is stale: created at ${receipt.createdAt} ` +
            `is outside actor lease [${params.actorInstance.createdAt}, ${params.actorInstance.leaseExpiresAt}]`,
        );
      }
    }

    // 7. FAILED: attempt < maxAttempts（否则应迁移到 ROLLED_BACK）
    if (params.toState === 'FAILED') {
      if (stageRun.attempt >= params.actorProfile.maxAttempts) {
        return deny(
          `stage run attempt ${stageRun.attempt} >= maxAttempts ${params.actorProfile.maxAttempts}; ` +
            'must transition to ROLLED_BACK instead of FAILED',
        );
      }
    }

    // 8. Frozen target hash 一致性 — 若 stageRun 有 frozenSourceSha，
    //    receipt 的 frozenTargetHash 必须与 stageRun.frozenInputHash 一致。
    if (stageRun.frozenSourceSha !== undefined) {
      if (!receipt) {
        return deny(
          `trigger receipt not available to verify frozen source SHA: ${params.triggerReceiptId}`,
        );
      }
      const workflowPayload = extractWorkflowPayload(receipt);
      if (!workflowPayload) {
        return deny(
          `trigger receipt payload is not a valid WorkflowReceiptPayload: ${params.triggerReceiptId}`,
        );
      }
      if (workflowPayload.frozenTargetHash !== stageRun.frozenInputHash) {
        return deny(
          `frozen target hash mismatch: stage run has ${stageRun.frozenInputHash}, ` +
            `receipt has ${workflowPayload.frozenTargetHash}`,
        );
      }
    }

    // 记录迁移到 state_transition_log（item_type = 'stage_run'）
    const transitionId = createAwknId('event');
    const now = new Date().toISOString();
    const changes = queryRun(TRANSITION_INSERT_SQL, [
      transitionId,
      params.stageRunId,
      'stage_run',
      stageRun.state,
      params.toState,
      params.actorInstance.actorId,
      params.triggerReceiptId,
      stageRun.frozenInputHash,
      params.idempotencyKey,
      now,
    ]);
    if (changes === 0) {
      return deny('failed to record state transition');
    }

    // 仅通过 stage-store 写入终态（同时记录 actor 与 outputReceiptId）
    updateStageRunState(
      params.stageRunId,
      params.toState,
      params.actorInstance.actorId,
      params.outputReceiptId,
    );

    return { success: true, newState: params.toState };
  });
}
