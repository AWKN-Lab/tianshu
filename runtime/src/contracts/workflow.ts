/**
 * 工作流智能体系统契约
 *
 * 定义 Mission → Component → Module → WorkPackage 四层分层模型、
 * AgentProfile/AgentInstance 身份隔离、Authorization Envelope 授权包、
 * 职责隔离矩阵和 WorkGraph 依赖图。
 *
 * 对应 PRD: AWKN-PRD-WFA-001
 * 工程文档: AWKN-ENG-WFA-001
 */
import { z } from 'zod';
import { awknIdSchema } from './ids.js';
import { SafePositiveIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

// ─── Agent 角色 ───────────────────────────────────────────

export const AgentRoleSchema = z.enum([
  'Product',
  'Architect',
  'Planner',
  'Engineer',
  'Test',
  'Review',
  'Git',
  'Release',
  'Deploy',
  'Retrospective',
  'Evolution',
  'Recovery',
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const IndependenceLevelSchema = z.enum(['STRICT', 'RELAXED']);
export type IndependenceLevel = z.infer<typeof IndependenceLevelSchema>;

export const AgentProfileSchema = z.object({
  schema: z.literal('awkn-agent-profile/v1'),
  role: AgentRoleSchema,
  capabilities: z.array(z.string().min(1)).min(1),
  permissions: z.array(z.string().min(1)),
  inputTypes: z.array(z.string().min(1)).min(1),
  outputTypes: z.array(z.string().min(1)).min(1),
  independenceLevel: IndependenceLevelSchema,
  maxConcurrentAssignments: SafePositiveIntegerSchema,
}).strict();
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentInstanceSchema = z.object({
  schema: z.literal('awkn-agent-instance/v1'),
  actorId: z.string().min(1),
  profile: AgentProfileSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  sessionId: z.string().min(1),
  permissionSnapshot: z.array(z.string().min(1)),
  leaseExpiry: UtcTimestampSchema,
  createdAt: UtcTimestampSchema,
}).strict();
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;

// ─── 工作项状态 ───────────────────────────────────────────

export const WorkItemStateSchema = z.enum([
  'DRAFT',
  'READY',
  'ASSIGNED',
  'RUNNING',
  'PRODUCED',
  'TESTING',
  'REVIEWING',
  'ACCEPTED',
  'INTEGRATED',
  'CLOSED',
  // 异常状态
  'BLOCKED',
  'FAILED',
  'RETRYING',
  'ROLLED_BACK',
  'QUARANTINED',
  'CANCELLED',
]);
export type WorkItemState = z.infer<typeof WorkItemStateSchema>;

export const COMPLETION_STATES = new Set<WorkItemState>(['ACCEPTED', 'INTEGRATED', 'CLOSED']);
export const ABNORMAL_STATES = new Set<WorkItemState>([
  'BLOCKED', 'FAILED', 'RETRYING', 'ROLLED_BACK', 'QUARANTINED', 'CANCELLED',
]);

// ─── 分层任务模型 ─────────────────────────────────────────

export const ComponentSpecSchema = z.object({
  name: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
}).strict();
export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;

export const ModuleSpecSchema = z.object({
  name: z.string().min(1),
  boundary: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
}).strict();
export type ModuleSpec = z.infer<typeof ModuleSpecSchema>;

export const WorkPackageSpecSchema = z.object({
  name: z.string().min(1),
  scope: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependencies: z.array(awknIdSchema('wp')).default([]),
}).strict();
export type WorkPackageSpec = z.infer<typeof WorkPackageSpecSchema>;

export const ComponentSchema = z.object({
  schema: z.literal('awkn-component/v1'),
  id: awknIdSchema('comp'),
  missionId: awknIdSchema('goal'),
  name: z.string().min(1),
  status: WorkItemStateSchema,
  acceptanceCriteria: z.array(z.string().min(1)),
  frozenTargetHash: z.string().optional(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
}).strict();
export type Component = z.infer<typeof ComponentSchema>;

export const ModuleSchema = z.object({
  schema: z.literal('awkn-module/v1'),
  id: awknIdSchema('mod'),
  componentId: awknIdSchema('comp'),
  name: z.string().min(1),
  status: WorkItemStateSchema,
  boundary: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  frozenTargetHash: z.string().optional(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
}).strict();
export type Module = z.infer<typeof ModuleSchema>;

export const WorkPackageSchema = z.object({
  schema: z.literal('awkn-work-package/v1'),
  id: awknIdSchema('wp'),
  moduleId: awknIdSchema('mod'),
  name: z.string().min(1),
  status: WorkItemStateSchema,
  scope: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  dependencies: z.array(awknIdSchema('wp')),
  assignedActorId: z.string().optional(),
  engineerReceiptId: z.string().optional(),
  testReceiptId: z.string().optional(),
  reviewReceiptId: z.string().optional(),
  gitReceiptId: z.string().optional(),
  retroReceiptId: z.string().optional(),
  frozenTargetHash: z.string().optional(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
}).strict();
export type WorkPackage = z.infer<typeof WorkPackageSchema>;

// ─── Authorization Envelope ───────────────────────────────

export const AuthorizationEnvelopeSchema = z.object({
  schema: z.literal('awkn-authorization-envelope/v1'),
  id: awknIdSchema('env'),
  missionId: awknIdSchema('goal'),
  userSignature: z.string().min(1),
  scopeDirectories: z.array(z.string().min(1)).min(1),
  scopeTools: z.array(z.string().min(1)),
  costBudgetTokens: SafePositiveIntegerSchema.optional(),
  costBudgetCalls: SafePositiveIntegerSchema.optional(),
  timeLimitHours: SafePositiveIntegerSchema.optional(),
  allowGitCommit: z.boolean().default(false),
  allowGitPush: z.boolean().default(false),
  allowDeploy: z.boolean().default(false),
  allowExternalMessages: z.boolean().default(false),
  allowPaidActions: z.boolean().default(false),
  deployEnvironments: z.array(z.string().min(1)).default([]),
  createdAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema.optional(),
  status: z.enum(['ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED']).default('ACTIVE'),
}).strict();
export type AuthorizationEnvelope = z.infer<typeof AuthorizationEnvelopeSchema>;

export const AuthorizationConsumptionSchema = z.object({
  schema: z.literal('awkn-authorization-consumption/v1'),
  id: z.string().min(1),
  envelopeId: awknIdSchema('env'),
  actorId: z.string().min(1),
  actionType: z.enum(['commit', 'push', 'deploy', 'external_message', 'paid']),
  actionTarget: z.string().min(1),
  receiptId: z.string().min(1),
  consumedAt: UtcTimestampSchema,
}).strict();
export type AuthorizationConsumption = z.infer<typeof AuthorizationConsumptionSchema>;

// ─── 职责隔离矩阵 ─────────────────────────────────────────

export const ScopeLevelSchema = z.enum([
  'MISSION',
  'COMPONENT',
  'MODULE',
  'WORKPACKAGE',
  'CHANGESET',
  'RELEASE_TARGET',
  'DEPLOY_TARGET',
  'GATE',
  'CANDIDATE',
]);
export type ScopeLevel = z.infer<typeof ScopeLevelSchema>;

/** 不相容角色对：[前置角色, 后置角色, 约束层级] */
export const INCOMPATIBLE_ROLES: ReadonlyArray<readonly [AgentRole, AgentRole, ScopeLevel]> = [
  ['Product', 'Review', 'MISSION'],
  ['Architect', 'Review', 'COMPONENT'],
  ['Architect', 'Engineer', 'COMPONENT'],
  ['Planner', 'Engineer', 'WORKPACKAGE'],
  ['Engineer', 'Test', 'WORKPACKAGE'],
  ['Engineer', 'Review', 'WORKPACKAGE'],
  ['Engineer', 'Git', 'CHANGESET'],
  ['Engineer', 'Release', 'RELEASE_TARGET'],
  ['Engineer', 'Deploy', 'DEPLOY_TARGET'],
  ['Test', 'Review', 'GATE'],
  ['Review', 'Deploy', 'DEPLOY_TARGET'],
  ['Retrospective', 'Evolution', 'CANDIDATE'],
] as const;

export const SeparationCheckResultSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  conflictingActorId: z.string().optional(),
  conflictingRole: AgentRoleSchema.optional(),
}).strict();
export type SeparationCheckResult = z.infer<typeof SeparationCheckResultSchema>;

// ─── WorkGraph ────────────────────────────────────────────

export const WorkGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['component', 'module', 'workpackage']),
  status: WorkItemStateSchema,
  assignedActorId: z.string().optional(),
  dependencies: z.array(z.string().min(1)),
}).strict();
export type WorkGraphNode = z.infer<typeof WorkGraphNodeSchema>;

export const DependencyEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
}).strict();
export type DependencyEdge = z.infer<typeof DependencyEdgeSchema>;

export const WorkGraphSchema = z.object({
  schema: z.literal('awkn-work-graph/v1'),
  missionId: awknIdSchema('goal'),
  nodes: z.array(WorkGraphNodeSchema),
  edges: z.array(DependencyEdgeSchema),
}).strict();
export type WorkGraph = z.infer<typeof WorkGraphSchema>;

export const ConflictSchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(2),
  reason: z.string().min(1),
}).strict();
export type Conflict = z.infer<typeof ConflictSchema>;

// ─── 状态迁移记录 ─────────────────────────────────────────

export const StateTransitionSchema = z.object({
  schema: z.literal('awkn-state-transition/v1'),
  workItemId: z.string().min(1),
  itemType: z.enum(['workpackage', 'module', 'component', 'mission']),
  fromState: WorkItemStateSchema,
  toState: WorkItemStateSchema,
  actorId: z.string().min(1),
  triggerReceiptId: z.string().min(1),
  inputHash: z.string().min(1),
  transitionedAt: UtcTimestampSchema,
  idempotencyKey: z.string().min(1),
}).strict();
export type StateTransition = z.infer<typeof StateTransitionSchema>;

// ─── Receipt 扩展类型 ─────────────────────────────────────

export const WorkflowReceiptTypeSchema = z.enum([
  'ENGINEER',
  'TEST',
  'REVIEW_WORKFLOW',
  'GIT',
  'RELEASE',
  'DEPLOY',
  'RETROSPECTIVE',
  'RECOVERY',
]);
export type WorkflowReceiptType = z.infer<typeof WorkflowReceiptTypeSchema>;

export const WorkflowReceiptPayloadSchema = z.object({
  missionId: awknIdSchema('goal'),
  componentId: awknIdSchema('comp').optional(),
  moduleId: awknIdSchema('mod').optional(),
  workPackageId: awknIdSchema('wp').optional(),
  envelopeId: awknIdSchema('env'),
  frozenTargetHash: z.string().min(1),
  verdict: z.enum(['PASS', 'FAIL', 'PARTIAL', 'BLOCKED']),
  toolsUsed: z.array(z.string().min(1)),
  evidenceRefs: z.array(z.string().min(1)),
  rollbackTargetId: z.string().optional(),
}).strict();
export type WorkflowReceiptPayload = z.infer<typeof WorkflowReceiptPayloadSchema>;
