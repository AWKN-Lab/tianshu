/**
 * Recovery 契约 — Recovery Attempt / Receipt 载荷
 *
 * Spiral 3: Recovery Agent 产出恢复尝试契约。Recovery Agent 仅执行恢复动作
 * （RETRY/REASSIGN/ROLLBACK/QUARANTINE/ESCALATE），不签署质量或发布 PASS。
 *
 * 对应契约: contracts/receipts.ts — ReceiptType 'RECOVERY'
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 3
 */
import { z } from 'zod';
import { awknIdSchema } from '../contracts/ids.js';
import { SafeNonNegativeIntegerSchema, SafePositiveIntegerSchema } from '../contracts/numbers.js';
import { UtcTimestampSchema } from '../contracts/time.js';

// ─── 失败分类 ─────────────────────────────────────────────

export const FailureClassSchema = z.enum([
  'TRANSIENT',
  'PERMANENT',
  'SECURITY',
  'RESOURCE',
  'UNKNOWN',
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

// ─── 恢复动作 ─────────────────────────────────────────────

export const RecoveryActionSchema = z.enum([
  'RETRY',
  'REASSIGN',
  'ROLLBACK',
  'QUARANTINE',
  'ESCALATE',
]);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

// ─── 恢复状态 ─────────────────────────────────────────────

export const RecoveryStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'SUCCEEDED',
  'FAILED',
  'QUARANTINED',
]);
export type RecoveryStatus = z.infer<typeof RecoveryStatusSchema>;

// ─── Recovery Attempt ─────────────────────────────────────

export const RecoveryAttemptSchema = z.object({
  schema: z.literal('awkn-recovery-attempt/v1'),
  recoveryAttemptId: z.string().min(1),
  stageRunId: z.string().min(1).optional(),
  deploymentRunId: z.string().min(1).optional(),
  failureClass: FailureClassSchema,
  recoveryAction: RecoveryActionSchema,
  attempt: SafeNonNegativeIntegerSchema,
  maxAttempts: SafePositiveIntegerSchema,
  status: RecoveryStatusSchema,
  resultDetail: z.string().min(1),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
}).strict();
export type RecoveryAttempt = z.infer<typeof RecoveryAttemptSchema>;

// ─── Recovery Receipt 载荷 ────────────────────────────────

export const RecoveryReceiptPayloadSchema = z.object({
  missionId: awknIdSchema('goal'),
  envelopeId: awknIdSchema('env'),
  stageRunId: z.string().min(1).optional(),
  deploymentRunId: z.string().min(1).optional(),
  failureClass: FailureClassSchema,
  recoveryAction: RecoveryActionSchema,
  attempt: SafeNonNegativeIntegerSchema,
  verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']),
}).strict();
export type RecoveryReceiptPayload = z.infer<typeof RecoveryReceiptPayloadSchema>;

export const RECOVERY_RECEIPT_PAYLOAD_SCHEMA = 'awkn-recovery-receipt/v1';
