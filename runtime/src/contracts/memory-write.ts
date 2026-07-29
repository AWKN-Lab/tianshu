/**
 * Memory Write Gate Contracts (Phase 6 / C09 / WP-AOS-14)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第五、六节
 *
 * 本文件冻结 Memory Write Gate 的所有公开 Contract：
 * - MemoryClassSchema: 六层记忆分类（M0-M5）
 * - MemoryBackendSchema: 写入后端（local / memory-os / none）
 * - SensitivityDecisionSchema: 敏感性判定
 * - MemoryWriteDecisionSchema: 写入决策（WRITE / REJECT / DEFER）
 * - MemoryWriteReasonCodeSchema: 决策原因码
 * - MemoryOperationTypeSchema: 操作类型（create / update / delete）
 * - MemoryCandidateSchema (awkn-memory-candidate/v1): 记忆候选
 * - MemoryOperationSchema: 单条记忆操作
 * - DependencyUpdateSchema: 依赖更新（删除传播）
 * - TombstoneSchema: 墓碑（删除标记）
 * - MemoryTransactionSchema (awkn-transaction/v1): 记忆事务
 * - MemoryWriteReceiptSchema (awkn-memory-write-receipt/v1): 写入回执
 *
 * 不变量：
 * - 所有 schema 使用 zod strict + superRefine
 * - 所有 hash 使用 stableHash（canonical-json.ts）
 * - 所有 ID 使用 createAwknId / awknIdSchema
 * - 所有时间戳使用 UtcTimestampSchema
 * - canonical JSON 不允许 undefined 字段，哈希前需 stripUndefined
 * - governance 记忆需要确认才能写入
 * - blocked 敏感性不能写入 memory-os 后端
 * - assistant 提议的 decision 类型 claim 需要确认
 */

import { z } from 'zod';
import { stableHash } from './canonical-json.js';
import { awknIdSchema, createAwknId } from './ids.js';
import type { JsonValue } from './json-value.js';
import { SafeNonNegativeIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

// ===== Section 1: Enums =====

export const MemoryClassSchema = z.enum([
  'working',
  'goal',
  'episodic',
  'semantic',
  'procedural',
  'governance',
]);
export type MemoryClass = z.infer<typeof MemoryClassSchema>;

export const MemoryBackendSchema = z.enum([
  'local',
  'memory-os',
  'none',
]);
export type MemoryBackend = z.infer<typeof MemoryBackendSchema>;

export const SensitivityDecisionSchema = z.enum([
  'allowed',
  'sensitive',
  'blocked',
  'redacted',
]);
export type SensitivityDecision = z.infer<typeof SensitivityDecisionSchema>;

export const MemoryWriteDecisionSchema = z.enum([
  'WRITE',
  'REJECT',
  'DEFER',
]);
export type MemoryWriteDecision = z.infer<typeof MemoryWriteDecisionSchema>;

export const MemoryWriteReasonCodeSchema = z.enum([
  'HUMAN_FIELD_CONFIRMED',
  'HUMAN_DECISION_EXPLICIT',
  'PROJECT_STATE_OBSERVED',
  'EXECUTION_EXPERIENCE_VERIFIED',
  'PROCEDURAL_EXPERIENCE_REPLAY_APPROVED',
  'DURABLE',
  'HIGH_FUTURE_UTILITY',
  'SOURCE_VERIFIED',
  'MODEL_INFERENCE',
  'UNCONFIRMED_SUGGESTION',
  'EXTERNAL_RETRIEVAL_AS_USER_ATTR',
  'TRANSIENT_STATE',
  'NO_FUTURE_UTILITY',
  'UNSOURCED_SUMMARY',
  'CROSS_PROJECT_RUNTIME',
  'DUPLICATE',
  'CONFLICT',
  'REQUIRES_CONFIRMATION',
  'BACKEND_UNAVAILABLE',
  'DEPENDENCY_TOMBSTONED',
  'CAS_CONFLICT',
]);
export type MemoryWriteReasonCode = z.infer<typeof MemoryWriteReasonCodeSchema>;

export const MemoryOperationTypeSchema = z.enum([
  'create',
  'update',
  'delete',
]);
export type MemoryOperationType = z.infer<typeof MemoryOperationTypeSchema>;

// ===== Section 2: Memory Candidate (awkn-memory-candidate/v1) =====

/**
 * Memory Candidate 通过 z.any().refine 校验 Claim，避免与 claim.ts 形成循环依赖。
 * 校验规则：
 * - 必须是 awkn-claim/v3 schema
 * - 必须有至少一个 sourceRef（来源验证）
 */
export const MemoryCandidateSchema = z.object({
  schema: z.literal('awkn-memory-candidate/v1'),
  candidateId: awknIdSchema('mc'),
  claim: z.any().refine((value): boolean => {
    if (!value || typeof value !== 'object') return false;
    const claim = value as Record<string, unknown>;
    if (claim.schema !== 'awkn-claim/v3') return false;
    if (!Array.isArray(claim.sourceRefs) || claim.sourceRefs.length === 0) return false;
    return true;
  }, 'claim must be a valid awkn-claim/v3 with at least one sourceRef'),
  proposedMemoryClass: MemoryClassSchema,
  writeReason: z.string().min(1),
  durabilityScore: z.number().min(0).max(1),
  futureUtilityScore: z.number().min(0).max(1),
  sensitivityDecision: SensitivityDecisionSchema,
  requiresConfirmation: z.boolean(),
  targetBackend: MemoryBackendSchema,
}).strict().superRefine((value, context) => {
  // governance 记忆必须确认才能写入（设计文档 5.3）
  if (value.proposedMemoryClass === 'governance' && !value.requiresConfirmation) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requiresConfirmation'],
      message: 'governance memory requires confirmation before write',
    });
  }
  // blocked 敏感性不能写入 memory-os 后端
  if (value.sensitivityDecision === 'blocked' && value.targetBackend === 'memory-os') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetBackend'],
      message: 'blocked sensitivity cannot target memory-os backend',
    });
  }
  // assistant 提议的 decision 类型 claim 需要确认（设计文档测试 4）
  const claim = value.claim as Record<string, unknown>;
  if (claim.originator === 'assistant' && claim.claimType === 'decision' && !value.requiresConfirmation) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requiresConfirmation'],
      message: 'assistant-proposed decision claim requires confirmation before write',
    });
  }
});
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

export const MEMORY_CANDIDATE_SCHEMA_ID = 'awkn-memory-candidate/v1';

// ===== Section 3: Memory Operation =====

export const MemoryOperationSchema = z.object({
  type: MemoryOperationTypeSchema,
  memoryId: z.string().min(1).optional(),
  claim: z.any().refine((value): boolean => {
    if (!value || typeof value !== 'object') return false;
    const claim = value as Record<string, unknown>;
    return claim.schema === 'awkn-claim/v3';
  }, 'claim must be a valid awkn-claim/v3'),
  memoryClass: MemoryClassSchema,
  expectedRevision: SafeNonNegativeIntegerSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.type === 'update' || value.type === 'delete') && value.memoryId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['memoryId'],
      message: `${value.type} operation requires memoryId`,
    });
  }
  if (value.type === 'create' && value.memoryId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['memoryId'],
      message: 'create operation must not specify memoryId (assigned by backend)',
    });
  }
});
export type MemoryOperation = z.infer<typeof MemoryOperationSchema>;

// ===== Section 4: Dependency Update & Tombstone =====

export const DependencyUpdateSchema = z.object({
  dependentMemoryId: z.string().min(1),
  dependencyClaimId: awknIdSchema('clm'),
  action: z.enum(['invalidate', 'reassess', 'tombstone']),
  reason: z.string().min(1),
}).strict();
export type DependencyUpdate = z.infer<typeof DependencyUpdateSchema>;

export const TombstoneSchema = z.object({
  memoryId: z.string().min(1),
  reason: z.string().min(1),
  claimId: awknIdSchema('clm').optional(),
  deletedAt: UtcTimestampSchema,
}).strict();
export type Tombstone = z.infer<typeof TombstoneSchema>;

// ===== Section 5: Memory Transaction (awkn-transaction/v1) =====

export const MemoryTransactionSchema = z.object({
  schema: z.literal('awkn-transaction/v1'),
  transactionId: awknIdSchema('mtx'),
  idempotencyKey: z.string().min(1),
  expectedRevision: SafeNonNegativeIntegerSchema.optional(),
  operations: z.array(MemoryOperationSchema).min(1),
  dependencyUpdates: z.array(DependencyUpdateSchema),
  tombstones: z.array(TombstoneSchema),
}).strict().superRefine((value, context) => {
  // 检测同一事务内重复的 memoryId
  const operationMemoryIds = new Set<string>();
  const duplicates = new Set<string>();
  for (const op of value.operations) {
    if (op.memoryId === undefined) continue;
    if (operationMemoryIds.has(op.memoryId)) duplicates.add(op.memoryId);
    operationMemoryIds.add(op.memoryId);
  }
  if (duplicates.size > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operations'],
      message: `duplicate memoryId in transaction: ${[...duplicates].sort().join(', ')}`,
    });
  }
  // 不能 create/update 已被墓碑标记的 memory
  const tombstonedIds = new Set(value.tombstones.map((t) => t.memoryId));
  for (const [index, op] of value.operations.entries()) {
    if (op.memoryId !== undefined && tombstonedIds.has(op.memoryId) && op.type !== 'delete') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations', index, 'memoryId'],
        message: `cannot create/update a tombstoned memory: ${op.memoryId}`,
      });
    }
  }
});
export type MemoryTransaction = z.infer<typeof MemoryTransactionSchema>;

export const MEMORY_TRANSACTION_SCHEMA_ID = 'awkn-transaction/v1';

// ===== Section 6: Memory Write Receipt (awkn-memory-write-receipt/v1) =====

export const MemoryWriteReceiptSchema = z.object({
  schema: z.literal('awkn-memory-write-receipt/v1'),
  receiptId: awknIdSchema('mw'),
  candidateId: awknIdSchema('mc'),
  claimId: awknIdSchema('clm'),
  decision: MemoryWriteDecisionSchema,
  reasonCodes: z.array(MemoryWriteReasonCodeSchema).min(1),
  backend: MemoryBackendSchema,
  memoryId: z.string().min(1).optional(),
  revision: SafeNonNegativeIntegerSchema.optional(),
  idempotencyKey: z.string().min(1),
  transactionId: awknIdSchema('mtx').optional(),
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  // WRITE 决策必须非 none 后端（除非 BACKEND_UNAVAILABLE）
  if (value.decision === 'WRITE' && value.backend === 'none'
    && !value.reasonCodes.includes('BACKEND_UNAVAILABLE')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['backend'],
      message: 'WRITE decision requires non-none backend (or BACKEND_UNAVAILABLE reasonCode)',
    });
  }
  // REJECT 决策必须 none 后端
  if (value.decision === 'REJECT' && value.backend !== 'none') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['backend'],
      message: 'REJECT decision must have none backend',
    });
  }
  // DEFER 决策必须有 REQUIRES_CONFIRMATION
  if (value.decision === 'DEFER' && !value.reasonCodes.includes('REQUIRES_CONFIRMATION')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reasonCodes'],
      message: 'DEFER decision requires REQUIRES_CONFIRMATION reasonCode',
    });
  }
  // WRITE 且 backend 可用时必须有 memoryId
  if (value.decision === 'WRITE' && !value.reasonCodes.includes('BACKEND_UNAVAILABLE')
    && value.memoryId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['memoryId'],
      message: 'WRITE decision (backend available) requires memoryId',
    });
  }
  // REJECT 不能携带 memoryId
  if (value.decision === 'REJECT' && value.memoryId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['memoryId'],
      message: 'REJECT decision must not carry memoryId',
    });
  }
});
export type MemoryWriteReceipt = z.infer<typeof MemoryWriteReceiptSchema>;

export const MEMORY_WRITE_RECEIPT_SCHEMA_ID = 'awkn-memory-write-receipt/v1';

// ===== Section 7: Hash Computation =====

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val !== undefined) {
      result[key] = stripUndefined(val);
    }
  }
  return result;
}

export function computeMemoryCandidateHash(
  candidate: Omit<MemoryCandidate, 'candidateId'>,
): string {
  const { candidateId: _candidateId, ...contentFields } = candidate as MemoryCandidate;
  void _candidateId;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(MEMORY_CANDIDATE_SCHEMA_ID, stripped);
}

export function computeMemoryTransactionHash(
  transaction: Omit<MemoryTransaction, 'transactionId'>,
): string {
  const { transactionId: _transactionId, ...contentFields } = transaction as MemoryTransaction;
  void _transactionId;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(MEMORY_TRANSACTION_SCHEMA_ID, stripped);
}

export function computeMemoryWriteReceiptHash(
  receipt: Omit<MemoryWriteReceipt, 'receiptId'>,
): string {
  const { receiptId: _receiptId, ...contentFields } = receipt as MemoryWriteReceipt;
  void _receiptId;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(MEMORY_WRITE_RECEIPT_SCHEMA_ID, stripped);
}

// ===== Section 8: ID 生成辅助 =====

export function createMemoryCandidateId(): string {
  return createAwknId('memoryCandidate');
}

export function createMemoryTransactionId(): string {
  return createAwknId('memoryTransaction');
}

export function createMemoryWriteReceiptId(): string {
  return createAwknId('memoryWrite');
}
