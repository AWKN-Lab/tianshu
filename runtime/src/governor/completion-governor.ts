/**
 * 完成状态门卫 — 唯一可将工作项迁移到完成状态的实体
 *
 * 完成状态: ACCEPTED, INTEGRATED, CLOSED (COMPLETION_STATES)
 *
 * 验证项:
 *   1. toState 属于完成状态集合
 *   2. actor 实例结构合法
 *   3. 幂等性 — 相同 idempotency_key 重复请求返回已有记录
 *   4. 职责分离 — actor 与前置 agent 无不相容角色冲突
 *   5. receipt 新鲜度 — 存在、status=SUCCESS、payload hash 完整、在 actor lease 内
 *   6. frozen target 未变 — 工作项的 frozenTargetHash 与 receipt payload 一致
 *   7. authorization 边界 — 授权信封 ACTIVE 且未过期，actor 持有完成权限
 *   8. upstream gates PASS — 所有上游 gate receipt 判定为 PASS
 *   9. 记录迁移到 state_transition_log 并更新工作项状态
 *
 * 表: state_transition_log (Migration v18)
 */
import { createAwknId } from '../contracts/ids.js';
import {
  StoredReceiptEnvelopeSchema,
  validateReceiptPayloadHash,
  type StoredReceiptEnvelope,
} from '../contracts/receipts.js';
import {
  AgentInstanceSchema,
  COMPLETION_STATES,
  WorkflowReceiptPayloadSchema,
  type AgentInstance,
  type WorkItemState,
  type WorkflowReceiptPayload,
} from '../contracts/workflow.js';
import {
  getComponent,
  getModule,
  getWorkPackage,
  updateComponentStatus,
  updateModuleStatus,
  updateWorkPackageStatus,
} from '../hierarchy/repository.js';
import { queryOne, queryRun, transaction } from '../store/db.js';
import { enforceSeparation, type SeparationScope } from './separation-matrix.js';

// ─── 公共类型 ─────────────────────────────────────────────

export type ItemType = 'workpackage' | 'module' | 'component' | 'mission';

export interface TransitionParams {
  readonly workItemId: string;
  readonly itemType: ItemType;
  readonly toState: WorkItemState;
  readonly actor: AgentInstance;
  readonly triggerReceiptId: string;
  readonly inputHash: string;
  readonly idempotencyKey: string;
  readonly priorInstances: readonly AgentInstance[];
  readonly scope: SeparationScope;
  readonly upstreamGates?: readonly string[];
}

export type TransitionResult =
  | { readonly success: true; readonly transitionId: string }
  | { readonly success: false; readonly reason: string };

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

interface AuthorizationEnvelopeRow {
  readonly id: string;
  readonly status: string;
  readonly expires_at: string | null;
}

interface ExistingTransitionRow {
  readonly id: string;
  readonly to_state: string;
  readonly input_hash: string;
}

interface WorkItemSnapshot {
  readonly status: WorkItemState;
  readonly frozenTargetHash: string | undefined;
}

// ─── SQL 常量 ─────────────────────────────────────────────

const RECEIPT_SELECT_SQL = `
  SELECT id, receipt_type, payload_schema, execution_id, trace_id,
         run_id, step_id, aggregate_type, aggregate_id,
         producer_json, status, payload_json, payload_hash,
         artifact_refs_json, created_at
  FROM receipts WHERE id = ?
`;

const ENVELOPE_SELECT_SQL =
  'SELECT id, status, expires_at FROM authorization_envelope WHERE id = ?';

const TRANSITION_DEDUP_SQL =
  'SELECT id, to_state, input_hash FROM state_transition_log WHERE idempotency_key = ?';

const TRANSITION_INSERT_SQL = `
  INSERT INTO state_transition_log
    (id, work_item_id, item_type, from_state, to_state, actor_id,
     trigger_receipt_id, input_hash, idempotency_key, transitioned_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// ─── 内部辅助 ─────────────────────────────────────────────

function deny(reason: string): TransitionResult {
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

function extractWorkflowPayload(receipt: StoredReceiptEnvelope): WorkflowReceiptPayload | undefined {
  const result = WorkflowReceiptPayloadSchema.safeParse(receipt.payload);
  return result.success ? result.data : undefined;
}

function loadWorkItemSnapshot(
  workItemId: string,
  itemType: ItemType,
): WorkItemSnapshot | undefined {
  switch (itemType) {
    case 'workpackage': {
      const wp = getWorkPackage(workItemId);
      return wp
        ? { status: wp.status, frozenTargetHash: wp.frozenTargetHash }
        : undefined;
    }
    case 'module': {
      const mod = getModule(workItemId);
      return mod
        ? { status: mod.status, frozenTargetHash: mod.frozenTargetHash }
        : undefined;
    }
    case 'component': {
      const comp = getComponent(workItemId);
      return comp
        ? { status: comp.status, frozenTargetHash: comp.frozenTargetHash }
        : undefined;
    }
    case 'mission':
      return undefined;
  }
}

function updateWorkItemStatus(
  workItemId: string,
  itemType: ItemType,
  state: WorkItemState,
): void {
  switch (itemType) {
    case 'workpackage':
      updateWorkPackageStatus(workItemId, state);
      break;
    case 'module':
      updateModuleStatus(workItemId, state);
      break;
    case 'component':
      updateComponentStatus(workItemId, state);
      break;
    case 'mission':
      // Goal 状态由 goal-manager 管理；governor 仅记录审计日志。
      break;
  }
}

function hasCompletionPermission(actor: AgentInstance, itemType: ItemType): boolean {
  const snapshot = actor.permissionSnapshot;
  return (
    snapshot.includes('workflow:complete') ||
    snapshot.includes(`workflow:complete:${itemType}`)
  );
}

// ─── 主入口 ───────────────────────────────────────────────

export function transitionState(params: TransitionParams): TransitionResult {
  // 1. toState 必须是完成状态
  if (!COMPLETION_STATES.has(params.toState)) {
    return deny(
      `toState ${params.toState} is not a completion state (ACCEPTED, INTEGRATED, CLOSED)`,
    );
  }

  // 2. actor 实例结构合法
  const actorParse = AgentInstanceSchema.safeParse(params.actor);
  if (!actorParse.success) {
    return deny(`invalid actor instance: ${actorParse.error.message}`);
  }

  // 3. 事务内完成所有 DB 校验 + 记录（原子性）
  return transaction((): TransitionResult => {
    // 3a. 幂等检查 — 相同 idempotency_key 视为重复请求
    const existing = queryOne<ExistingTransitionRow>(TRANSITION_DEDUP_SQL, [
      params.idempotencyKey,
    ]);
    if (existing) {
      if (existing.to_state === params.toState && existing.input_hash === params.inputHash) {
        return { success: true, transitionId: existing.id };
      }
      return deny(
        `idempotency key conflict: ${params.idempotencyKey} already used for a different transition`,
      );
    }

    // 3b. 职责分离 — actor 与前置 agent 不可有不相容角色
    const separation = enforceSeparation(
      params.priorInstances,
      params.actor,
      params.scope,
    );
    if (!separation.allowed) {
      return deny(separation.reason ?? 'separation of duties violated');
    }

    // 3c. 加载并校验 trigger receipt（新鲜度 + 完整性）
    const receiptRow = loadReceiptRow(params.triggerReceiptId);
    if (!receiptRow) {
      return deny(`trigger receipt not found: ${params.triggerReceiptId}`);
    }
    const receipt = parseReceipt(receiptRow);
    if (!receipt) {
      return deny(`trigger receipt envelope is invalid: ${params.triggerReceiptId}`);
    }
    if (receipt.status !== 'SUCCESS') {
      return deny(`trigger receipt status is ${receipt.status}, must be SUCCESS`);
    }
    if (!validateReceiptPayloadHash(receipt)) {
      return deny(`trigger receipt payload hash mismatch: ${params.triggerReceiptId}`);
    }

    // 3d. receipt 新鲜度 — 创建时间必须在 actor lease 有效期内
    if (
      receipt.createdAt < params.actor.createdAt ||
      receipt.createdAt > params.actor.leaseExpiry
    ) {
      return deny(
        `trigger receipt is stale: created at ${receipt.createdAt} ` +
          `is outside actor lease [${params.actor.createdAt}, ${params.actor.leaseExpiry}]`,
      );
    }

    // 3e. 解析 workflow payload — 提取 frozenTargetHash 和 envelopeId
    const workflowPayload = extractWorkflowPayload(receipt);
    if (!workflowPayload) {
      return deny(
        `trigger receipt payload is not a valid WorkflowReceiptPayload: ${params.triggerReceiptId}`,
      );
    }

    // 3f. 加载工作项快照（status + frozenTargetHash）
    const snapshot = loadWorkItemSnapshot(params.workItemId, params.itemType);
    const fromState: WorkItemState = snapshot?.status ?? 'RUNNING';

    // 3g. frozen target 未变 — 工作项的 hash 必须与 receipt payload 一致
    if (params.itemType !== 'mission') {
      if (!snapshot) {
        return deny(
          `work item not found: ${params.itemType}:${params.workItemId}`,
        );
      }
      const itemFrozenHash = snapshot.frozenTargetHash;
      if (!itemFrozenHash) {
        return deny(
          `work item has no frozen target hash: ${params.itemType}:${params.workItemId}`,
        );
      }
      if (itemFrozenHash !== workflowPayload.frozenTargetHash) {
        return deny(
          `frozen target hash mismatch: work item has ${itemFrozenHash}, ` +
            `receipt has ${workflowPayload.frozenTargetHash}`,
        );
      }
    }

    // 3h. authorization 边界 — 授权信封必须 ACTIVE 且未过期
    const envelopeRow = queryOne<AuthorizationEnvelopeRow>(ENVELOPE_SELECT_SQL, [
      workflowPayload.envelopeId,
    ]);
    if (!envelopeRow) {
      return deny(
        `authorization envelope not found: ${workflowPayload.envelopeId}`,
      );
    }
    if (envelopeRow.status !== 'ACTIVE') {
      return deny(
        `authorization envelope is ${envelopeRow.status}, must be ACTIVE`,
      );
    }
    if (envelopeRow.expires_at && new Date(envelopeRow.expires_at) < new Date()) {
      return deny(
        `authorization envelope expired at ${envelopeRow.expires_at}`,
      );
    }

    // 3i. actor 权限边界 — 必须持有完成权限
    if (!hasCompletionPermission(params.actor, params.itemType)) {
      return deny(
        `actor ${params.actor.actorId} lacks completion permission for ${params.itemType}`,
      );
    }

    // 3j. upstream gates PASS — 所有上游 gate receipt 判定必须为 PASS
    if (params.upstreamGates && params.upstreamGates.length > 0) {
      for (const gateReceiptId of params.upstreamGates) {
        const gateRow = loadReceiptRow(gateReceiptId);
        if (!gateRow) {
          return deny(`upstream gate receipt not found: ${gateReceiptId}`);
        }
        const gateReceipt = parseReceipt(gateRow);
        if (!gateReceipt) {
          return deny(`upstream gate receipt is invalid: ${gateReceiptId}`);
        }
        if (gateReceipt.status !== 'SUCCESS') {
          return deny(
            `upstream gate receipt status is ${gateReceipt.status}: ${gateReceiptId}`,
          );
        }
        const gatePayload = extractWorkflowPayload(gateReceipt);
        if (!gatePayload) {
          return deny(
            `upstream gate receipt has invalid workflow payload: ${gateReceiptId}`,
          );
        }
        if (gatePayload.verdict !== 'PASS') {
          return deny(
            `upstream gate ${gateReceiptId} verdict is ${gatePayload.verdict}, must be PASS`,
          );
        }
      }
    }

    // 3k. 记录迁移到 state_transition_log
    const transitionId = createAwknId('event');
    const now = new Date().toISOString();
    const changes = queryRun(TRANSITION_INSERT_SQL, [
      transitionId,
      params.workItemId,
      params.itemType,
      fromState,
      params.toState,
      params.actor.actorId,
      params.triggerReceiptId,
      params.inputHash,
      params.idempotencyKey,
      now,
    ]);
    if (changes === 0) {
      return deny('failed to record state transition');
    }

    // 3l. 更新工作项状态
    updateWorkItemStatus(params.workItemId, params.itemType, params.toState);

    return { success: true, transitionId };
  });
}
