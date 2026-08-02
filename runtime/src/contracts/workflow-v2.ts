/**
 * 工作流智能体系统 v2 契约
 *
 * Spiral 1 增量：StageGraph、AgentProfile/Instance v2、StageRun、
 * WorkerProviderPort、Receipt 扩展、Separation Policy v2。
 *
 * 保留 v1 契约不动；v2 通过适配函数映射，不绕过 Stage 门禁。
 *
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 1
 */
import { z } from 'zod';
import { awknIdSchema } from './ids.js';
import { SafePositiveIntegerSchema, SafeNonNegativeIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';
import { AgentRoleSchema, type AgentRole } from './workflow.js';

// ─── Stage 类型（17 类）──────────────────────────────────

export const WorkflowStageTypeSchema = z.enum([
  'PRODUCT_AUTHOR',
  'REQUIREMENTS_REVIEW',
  'ARCHITECTURE_AUTHOR',
  'ARCHITECTURE_REVIEW',
  'PLAN_AUTHOR',
  'PLAN_REVIEW',
  'IMPLEMENT',
  'TEST',
  'CODE_REVIEW',
  'SECURITY_REVIEW',
  'GIT_INTEGRATE',
  'RELEASE_BUILD',
  'DEPLOY',
  'HEALTH_VERIFY',
  'RETROSPECTIVE',
  'EVOLUTION_VALIDATE',
  'RECOVERY',
]);
export type WorkflowStageType = z.infer<typeof WorkflowStageTypeSchema>;

/** Stage 适用的层级 */
export const StageWorkItemTypeSchema = z.enum(['mission', 'component', 'module', 'workpackage']);
export type StageWorkItemType = z.infer<typeof StageWorkItemTypeSchema>;

// ─── Stage 运行状态 ──────────────────────────────────────

export const StageRunStateSchema = z.enum([
  'READY',
  'ASSIGNED',
  'RUNNING',
  'PRODUCED',
  'PASSED',
  'FAILED',
  'BLOCKED',
  'RETRYING',
  'ROLLED_BACK',
  'QUARANTINED',
]);
export type StageRunState = z.infer<typeof StageRunStateSchema>;

export const STAGE_TERMINAL_STATES = new Set<StageRunState>(['PASSED', 'FAILED', 'ROLLED_BACK', 'QUARANTINED']);
export const STAGE_COMPLETION_STATES = new Set<StageRunState>(['PASSED']);

// ─── Profile 生命周期状态 ────────────────────────────────

export const ProfileStatusSchema = z.enum([
  'DRAFT',
  'SHADOW',
  'CANARY',
  'ACTIVE',
  'QUARANTINED',
  'RETIRED',
]);
export type ProfileStatus = z.infer<typeof ProfileStatusSchema>;

// ─── Provider 策略 ───────────────────────────────────────

export const ProviderPolicySchema = z.enum([
  'ANY_APPROVED',
  'DIFFERENT_FROM_UPSTREAM',
  'PINNED',
]);
export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>;

// ─── Memory 策略 ─────────────────────────────────────────

export const MemoryPolicySchema = z.enum([
  'SCOPED_READ_NO_WRITE',
  'CANDIDATE_WRITE_ONLY',
  'NO_MEMORY',
]);
export type MemoryPolicy = z.infer<typeof MemoryPolicySchema>;

// ─── AgentProfile v2 ─────────────────────────────────────

export const AgentProfileV2Schema = z.object({
  schema: z.literal('awkn-agent-profile/v2'),
  profileId: z.string().min(1),
  version: z.string().min(1),
  role: AgentRoleSchema,
  specialty: WorkflowStageTypeSchema,
  capabilities: z.array(z.string().min(1)).min(1),
  inputTypes: z.array(z.string().min(1)).min(1),
  outputTypes: z.array(z.string().min(1)).min(1),
  toolPolicyRef: z.string().min(1),
  independenceGroup: z.string().min(1),
  providerPolicy: ProviderPolicySchema,
  maxConcurrentAssignments: SafePositiveIntegerSchema,
  maxAttempts: SafePositiveIntegerSchema,
  timeoutMs: SafePositiveIntegerSchema,
  memoryPolicy: MemoryPolicySchema,
  status: ProfileStatusSchema,
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type AgentProfileV2 = z.infer<typeof AgentProfileV2Schema>;

// ─── AgentInstance v2 ────────────────────────────────────

export const AgentInstanceV2Schema = z.object({
  schema: z.literal('awkn-agent-instance/v2'),
  actorId: z.string().min(1),
  profileId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  sessionId: z.string().min(1),
  workerProviderId: z.string().min(1),
  providerRunId: z.string().min(1),
  workspaceId: z.string().min(1),
  permissionSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  authorizationEnvelopeId: awknIdSchema('env'),
  leaseId: z.string().min(1),
  leaseExpiresAt: UtcTimestampSchema,
  createdAt: UtcTimestampSchema,
}).strict();
export type AgentInstanceV2 = z.infer<typeof AgentInstanceV2Schema>;

// ─── WorkflowStageRun ────────────────────────────────────

export const WorkflowStageRunSchema = z.object({
  schema: z.literal('awkn-workflow-stage-run/v1'),
  stageRunId: z.string().min(1),
  missionId: awknIdSchema('goal'),
  workItemType: StageWorkItemTypeSchema,
  workItemId: z.string().min(1),
  stageType: WorkflowStageTypeSchema,
  state: StageRunStateSchema,
  requiredProfileId: z.string().min(1),
  actorId: z.string().optional(),
  frozenInputHash: z.string().regex(/^[0-9a-f]{64}$/),
  frozenSourceSha: z.string().optional(),
  frozenArtifactDigest: z.string().optional(),
  authorizationEnvelopeId: awknIdSchema('env'),
  inputReceiptIds: z.array(z.string().min(1)),
  outputReceiptId: z.string().optional(),
  attempt: SafeNonNegativeIntegerSchema,
  idempotencyKey: z.string().min(1),
  leaseExpiresAt: UtcTimestampSchema.optional(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
}).strict();
export type WorkflowStageRun = z.infer<typeof WorkflowStageRunSchema>;

// ─── StageGraph ──────────────────────────────────────────

export const StageNodeSchema = z.object({
  stageType: WorkflowStageTypeSchema,
  workItemType: StageWorkItemTypeSchema,
  workItemId: z.string().min(1),
  requiredProfileId: z.string().min(1),
  optional: z.boolean().default(false),
}).strict();
export type StageNode = z.infer<typeof StageNodeSchema>;

export const StageEdgeSchema = z.object({
  from: WorkflowStageTypeSchema,
  to: WorkflowStageTypeSchema,
  condition: z.enum(['always', 'on_pass', 'on_fail', 'not_required']).default('on_pass'),
}).strict();
export type StageEdge = z.infer<typeof StageEdgeSchema>;

export const StageGraphSchema = z.object({
  schema: z.literal('awkn-stage-graph/v1'),
  missionId: awknIdSchema('goal'),
  nodes: z.array(StageNodeSchema).min(1),
  edges: z.array(StageEdgeSchema),
  frozenSourceSha: z.string().optional(),
  createdAt: UtcTimestampSchema,
}).strict();
export type StageGraph = z.infer<typeof StageGraphSchema>;

// ─── Worker Provider Port ────────────────────────────────

export const WorkerSpawnRequestSchema = z.object({
  schema: z.literal('awkn-worker-spawn-request/v1'),
  stageRunId: z.string().min(1),
  profileId: z.string().min(1),
  frozenInputHash: z.string().regex(/^[0-9a-f]{64}$/),
  workspaceId: z.string().min(1),
  toolPolicyRef: z.string().min(1),
  authorizationEnvelopeId: awknIdSchema('env'),
  budgetTokens: SafePositiveIntegerSchema.optional(),
  idempotencyKey: z.string().min(1),
}).strict();
export type WorkerSpawnRequest = z.infer<typeof WorkerSpawnRequestSchema>;

export const WorkerProviderCapabilityReceiptSchema = z.object({
  schema: z.literal('awkn-worker-capability/v1'),
  providerId: z.string().min(1),
  probedAt: UtcTimestampSchema,
  maxConcurrentRuns: SafePositiveIntegerSchema,
  supportedSpecialties: z.array(WorkflowStageTypeSchema).min(1),
  heartbeatIntervalMs: SafePositiveIntegerSchema,
}).strict();
export type WorkerProviderCapabilityReceipt = z.infer<typeof WorkerProviderCapabilityReceiptSchema>;

export const WorkerSpawnReceiptSchema = z.object({
  schema: z.literal('awkn-worker-spawn-receipt/v1'),
  providerRunId: z.string().min(1),
  providerId: z.string().min(1),
  actorId: z.string().min(1),
  sessionId: z.string().min(1),
  spawnedAt: UtcTimestampSchema,
}).strict();
export type WorkerSpawnReceipt = z.infer<typeof WorkerSpawnReceiptSchema>;

export const WorkerHeartbeatReceiptSchema = z.object({
  schema: z.literal('awkn-worker-heartbeat/v1'),
  providerRunId: z.string().min(1),
  observedAt: UtcTimestampSchema,
  status: z.enum(['alive', 'busy', 'stale']),
}).strict();
export type WorkerHeartbeatReceipt = z.infer<typeof WorkerHeartbeatReceiptSchema>;

export const WorkerResultEnvelopeSchema = z.object({
  schema: z.literal('awkn-worker-result/v1'),
  providerRunId: z.string().min(1),
  actorId: z.string().min(1),
  conclusion: z.enum(['SUCCESS', 'FAILURE', 'PARTIAL']),
  outputReceiptId: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)),
  completedAt: UtcTimestampSchema,
}).strict();
export type WorkerResultEnvelope = z.infer<typeof WorkerResultEnvelopeSchema>;

export const WorkerCancelReceiptSchema = z.object({
  schema: z.literal('awkn-worker-cancel/v1'),
  providerRunId: z.string().min(1),
  reason: z.string().min(1),
  cancelledAt: UtcTimestampSchema,
}).strict();
export type WorkerCancelReceipt = z.infer<typeof WorkerCancelReceiptSchema>;

/**
 * Worker Provider Port — Provider 只返回事件和结果，不能改变 AWKN 状态。
 */
export interface WorkerProviderPort {
  readonly providerId: string;
  probe(): Promise<WorkerProviderCapabilityReceipt>;
  spawn(request: WorkerSpawnRequest): Promise<WorkerSpawnReceipt>;
  inspect(providerRunId: string): Promise<{ state: string; lastHeartbeatAt: string }>;
  heartbeat(providerRunId: string): Promise<WorkerHeartbeatReceipt>;
  cancel(providerRunId: string, reason: string): Promise<WorkerCancelReceipt>;
  collect(providerRunId: string): Promise<WorkerResultEnvelope>;
}

// ─── Separation Policy v2 不相容对 ───────────────────────
//
// 工程文档 7.1 节定义的 20 个不相容组合。
// 每个元组：[前置角色, 后置角色]
// 判定时双向检查（A↔B 和 B↔A 都拦截）。

export const INCOMPATIBLE_PAIRS_V2: ReadonlyArray<readonly [AgentRole, AgentRole]> = [
  ['Product', 'Planner'],
  ['Product', 'Review'],       // Requirements Reviewer
  ['Architect', 'Review'],     // Architecture Reviewer
  ['Architect', 'Planner'],
  ['Planner', 'Review'],       // Plan Reviewer
  ['Planner', 'Engineer'],
  ['Engineer', 'Test'],
  ['Engineer', 'Review'],      // Code Reviewer
  ['Engineer', 'Git'],
  ['Engineer', 'Release'],
  ['Engineer', 'Deploy'],
  ['Test', 'Review'],          // Test ↔ Code Reviewer
  ['Review', 'Deploy'],        // Code Reviewer ↔ Deploy
  ['Git', 'Release'],
  ['Release', 'Deploy'],
  ['Deploy', 'Review'],        // Deploy ↔ Health Verify (Review covers quality gates)
  ['Retrospective', 'Evolution'],
  ['Recovery', 'Review'],      // Recovery ↔ 最终质量/发布批准者
  ['Engineer', 'Recovery'],    // Engineer 不能兼任 Recovery
  ['Test', 'Git'],             // Test 不能兼任 Git（防止自测自提交）
] as const;

// ─── v1 → v2 适配 ────────────────────────────────────────

/**
 * 将 v1 AgentRole 映射到 v2 WorkflowStageType。
 * 用于旧路径继续运行但不绕过 v2 Stage 门禁。
 */
export const ROLE_TO_DEFAULT_SPECIALTY: Readonly<Record<string, WorkflowStageType>> = {
  Product: 'PRODUCT_AUTHOR',
  Architect: 'ARCHITECTURE_AUTHOR',
  Planner: 'PLAN_AUTHOR',
  Engineer: 'IMPLEMENT',
  Test: 'TEST',
  Review: 'CODE_REVIEW',
  Git: 'GIT_INTEGRATE',
  Release: 'RELEASE_BUILD',
  Deploy: 'DEPLOY',
  Retrospective: 'RETROSPECTIVE',
  Evolution: 'EVOLUTION_VALIDATE',
  Recovery: 'RECOVERY',
} as const;

// ─── Stage 模板类型 ──────────────────────────────────────

export const StageTemplateSchema = z.object({
  templateName: z.string().min(1),
  workItemType: StageWorkItemTypeSchema,
  stages: z.array(z.object({
    stageType: WorkflowStageTypeSchema,
    requiredRole: AgentRoleSchema,
    optional: z.boolean().default(false),
  })).min(1),
  edges: z.array(StageEdgeSchema),
}).strict();
export type StageTemplate = z.infer<typeof StageTemplateSchema>;
