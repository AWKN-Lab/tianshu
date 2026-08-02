/**
 * Worker 事件 → AWKN Receipt 规范化
 *
 * Spiral 2: 将 WorkerProviderPort 产生的事件（spawn / heartbeat / result）
 * 转换为 StoredReceiptEnvelope，复用 receiptPayloadHash 计算负载哈希。
 *
 * 遵循模式: src/review/application/review-receipt.ts
 * 对应契约: contracts/receipts.ts — StoredReceiptEnvelope
 */
import type {
  WorkerResultEnvelope,
  WorkerSpawnReceipt,
  WorkerHeartbeatReceipt,
} from '../contracts/workflow-v2.js';
import type { StoredReceiptEnvelope } from '../contracts/receipts.js';
import type { ActorRef } from '../contracts/actors.js';
import type { JsonValue } from '../contracts/json-value.js';
import { receiptPayloadHash } from '../contracts/receipts.js';
import { parseJsonValue } from '../contracts/json-value.js';
import { createAwknId } from '../contracts/ids.js';

type WorkerReceiptType = 'WORKER_SPAWN' | 'WORKER_HEARTBEAT' | 'WORKER_RESULT';
type ReceiptStatus = StoredReceiptEnvelope['status'];

function buildEnvelope(
  receiptType: WorkerReceiptType,
  payloadSchema: string,
  payload: JsonValue,
  producer: ActorRef,
  stageRunId: string,
  executionId: string,
  traceId: string,
  status: ReceiptStatus,
): StoredReceiptEnvelope {
  return {
    schema: 'awkn-receipt-envelope/v1',
    receiptId: createAwknId('receipt'),
    receiptType,
    payloadSchema,
    executionId,
    traceId,
    aggregateType: 'stageRun',
    aggregateId: stageRunId,
    producer,
    status,
    payload,
    payloadHash: receiptPayloadHash(payloadSchema, payload),
    artifactRefs: [],
    createdAt: new Date().toISOString(),
  };
}

export function normalizeSpawnReceipt(
  spawn: WorkerSpawnReceipt,
  stageRunId: string,
  executionId: string,
  traceId: string,
): StoredReceiptEnvelope {
  const producer: ActorRef = {
    schema: 'awkn-actor-ref/v1',
    actorId: spawn.actorId,
    actorType: 'assistant',
  };
  return buildEnvelope(
    'WORKER_SPAWN',
    'awkn-worker-spawn-receipt/v1',
    parseJsonValue(spawn),
    producer,
    stageRunId,
    executionId,
    traceId,
    'SUCCESS',
  );
}

export function normalizeHeartbeat(
  heartbeat: WorkerHeartbeatReceipt,
  stageRunId: string,
  executionId: string,
  traceId: string,
): StoredReceiptEnvelope {
  // WorkerHeartbeatReceipt 不含 actorId，用 providerRunId 标识发出心跳的 worker 服务。
  const producer: ActorRef = {
    schema: 'awkn-actor-ref/v1',
    actorId: `worker:${heartbeat.providerRunId}`,
    actorType: 'service',
  };
  return buildEnvelope(
    'WORKER_HEARTBEAT',
    'awkn-worker-heartbeat/v1',
    parseJsonValue(heartbeat),
    producer,
    stageRunId,
    executionId,
    traceId,
    'SUCCESS',
  );
}

export function normalizeResult(
  result: WorkerResultEnvelope,
  stageRunId: string,
  executionId: string,
  traceId: string,
): StoredReceiptEnvelope {
  const status: ReceiptStatus =
    result.conclusion === 'SUCCESS'
      ? 'SUCCESS'
      : result.conclusion === 'FAILURE'
        ? 'FAILURE'
        : 'PARTIAL';
  const producer: ActorRef = {
    schema: 'awkn-actor-ref/v1',
    actorId: result.actorId,
    actorType: 'assistant',
  };
  return buildEnvelope(
    'WORKER_RESULT',
    'awkn-worker-result/v1',
    parseJsonValue(result),
    producer,
    stageRunId,
    executionId,
    traceId,
    status,
  );
}
