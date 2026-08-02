/**
 * Deploy 契约 — Deployment Run / Observation / Receipt 载荷
 *
 * Spiral 3: Deploy Agent 产出的部署运行契约。Deploy Agent 仅部署已存在的
 * Release Bundle，不构建新制品。支持灰度（canary）→ 健康检查 → 自动回滚。
 *
 * 对应契约: contracts/receipts.ts — ReceiptType 'DEPLOY'
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 3
 */
import { z } from 'zod';
import { awknIdSchema } from '../contracts/ids.js';
import { UtcTimestampSchema } from '../contracts/time.js';

// ─── 灰度阶段 ─────────────────────────────────────────────

export const GrayStageSchema = z.enum([
  'PENDING',
  'CANARY',
  'HEALTH_CHECK',
  'COMPLETED',
  'ROLLED_BACK',
]);
export type GrayStage = z.infer<typeof GrayStageSchema>;

// ─── 健康状态 ─────────────────────────────────────────────

export const HealthStatusSchema = z.enum(['UNKNOWN', 'HEALTHY', 'UNHEALTHY']);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

// ─── Deployment Run ───────────────────────────────────────

export const DeploymentRunSchema = z.object({
  schema: z.literal('awkn-deployment-run/v1'),
  deploymentRunId: awknIdSchema('dt'),
  releaseBundleId: awknIdSchema('rb'),
  targetEnvironment: z.string().min(1),
  authorizationEnvelopeId: awknIdSchema('env'),
  grayStage: GrayStageSchema,
  healthStatus: HealthStatusSchema,
  finalVerdict: z.string().min(1).optional(),
  rollbackTargetId: z.string().min(1).optional(),
  startedAt: UtcTimestampSchema,
  completedAt: UtcTimestampSchema.optional(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
}).strict();
export type DeploymentRun = z.infer<typeof DeploymentRunSchema>;

// ─── Deployment Observation ───────────────────────────────

export const DeploymentObservationSchema = z.object({
  schema: z.literal('awkn-deployment-observation/v1'),
  observationId: z.string().min(1),
  deploymentRunId: awknIdSchema('dt'),
  checkName: z.string().min(1),
  checkResult: z.string().min(1),
  detailJson: z.string().min(1),
  observedAt: UtcTimestampSchema,
}).strict();
export type DeploymentObservation = z.infer<typeof DeploymentObservationSchema>;

// ─── Deploy Receipt 载荷 ──────────────────────────────────

export const DeployReceiptPayloadSchema = z.object({
  missionId: awknIdSchema('goal'),
  releaseBundleId: awknIdSchema('rb'),
  deploymentRunId: awknIdSchema('dt'),
  envelopeId: awknIdSchema('env'),
  targetEnvironment: z.string().min(1),
  grayStage: GrayStageSchema,
  healthStatus: HealthStatusSchema,
  verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']),
  rollbackTargetId: z.string().min(1).optional(),
}).strict();
export type DeployReceiptPayload = z.infer<typeof DeployReceiptPayloadSchema>;

export const DEPLOY_RECEIPT_PAYLOAD_SCHEMA = 'awkn-deploy-receipt/v1';
