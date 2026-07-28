/**
 * Tool & Model Broker 契约 (Phase 6 / C05 / WP-AOS-08/09)
 *
 * 设计文档: `docs/agent-os-3.0/06-Tool-Model-Broker.md`
 *
 * 职责:
 * - 根据任务能力选择模型、工具和供应商
 * - 评估成本、时延、数据边界和风险
 * - 区分请求路由与实际路由
 * - 绑定用户授权范围
 * - 计算多步操作的累计风险
 * - 校验工具调用后的真实副作用
 * - 生成可审计 Route 和 Execution Receipt
 *
 * 设计原则:
 * - fail-closed: 空 candidates / 缺失 Authorization 直接抛错 (E96)
 * - 版本冻结: planHash 由 stableHash(schemaId, plan) 决定, 跨平台一致
 * - Token 不可跨用户/项目/目标复用
 */

import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { stableHash } from './canonical-json.js';
import { awknIdSchema } from './ids.js';
import type { JsonValue } from './json-value.js';
import { JsonValueSchema } from './json-value.js';
import { SafeNonNegativeIntegerSchema, SafePositiveIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ===========================================================================
// Section 1: Tool Capability & Risk
// ===========================================================================

/**
 * 工具风险等级 (设计文档第 5.2 节)
 *
 * | 等级 | 类型 | 控制 |
 * |---|---|---|
 * | R0 | 纯本地计算、无数据访问 | 默认允许 |
 * | R1 | 受限读取、临时文件 | Policy允许后执行 |
 * | R2 | 本地可逆写入 | 会话授权或项目授权 |
 * | R3 | 外部写入、发送、创建资源 | 单次明确授权 |
 * | R4 | 金钱、交易、生产发布 | 二次确认和范围冻结 |
 * | R5 | 高影响不可逆或跨域传播 | 人工审批、补偿方案和审计 |
 */
export const ToolRiskLevelSchema = z.enum(['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
export type ToolRiskLevel = z.infer<typeof ToolRiskLevelSchema>;

export const ToolSideEffectSchema = z.enum([
  'none',
  'local_read',
  'local_write',
  'external_read',
  'external_write',
  'external_send',
  'resource_create',
  'resource_delete',
  'financial_transaction',
  'production_publish',
]);
export type ToolSideEffect = z.infer<typeof ToolSideEffectSchema>;

export const DataScopeSchema = z.object({
  read: z.array(z.string().min(1)),
  write: z.array(z.string().min(1)),
}).strict();
export type DataScope = z.infer<typeof DataScopeSchema>;

export const ResourceScopeSchema = z.object({
  schema: z.literal('awkn-resource-scope/v1'),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
  constraints: z.record(JsonValueSchema).default({}),
}).strict();
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;

/**
 * 工具能力声明 (设计文档第 5.1 节)
 */
export const ToolCapabilitySchema = z.object({
  schema: z.literal('awkn-tool-capability/v1'),
  toolId: z.string().min(1),
  providerId: z.string().min(1),
  sideEffect: ToolSideEffectSchema,
  reversible: z.boolean(),
  riskBase: ToolRiskLevelSchema,
  dataScopes: DataScopeSchema,
  requiresAuthorization: z.boolean(),
  supportsIdempotency: z.boolean(),
  supportsVerification: z.boolean(),
}).strict();
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

// ===========================================================================
// Section 2: Model & Provider Capability
// ===========================================================================

export const ModelCapabilitySchema = z.enum([
  'reasoning',
  'coding',
  'vision',
  'long_context',
  'structured_output',
  'tool_calling',
  'classification',
  'compression',
  'summarization',
]);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export const ModelTaskRoleSchema = z.enum([
  'executor',
  'reviewer',
  'classifier',
  'compressor',
  'summarizer',
]);
export type ModelTaskRole = z.infer<typeof ModelTaskRoleSchema>;

export const ModelDescriptorSchema = z.object({
  schema: z.literal('awkn-model-descriptor/v1'),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  capabilities: z.array(ModelCapabilitySchema).min(1),
  taskRoles: z.array(ModelTaskRoleSchema).min(1),
  contextWindow: SafePositiveIntegerSchema,
  inputCostPer1k: z.number().nonnegative(),
  outputCostPer1k: z.number().nonnegative(),
  latencyP50Ms: SafePositiveIntegerSchema,
  latencyP99Ms: SafePositiveIntegerSchema,
  dataLocation: z.string().min(1),
  retentionDays: SafeNonNegativeIntegerSchema,
  availability: z.number().min(0).max(1),
  fallbackCompatibleWith: z.array(z.string().min(1)),
}).strict();
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export const ProviderDescriptorSchema = z.object({
  schema: z.literal('awkn-provider-descriptor/v1'),
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  models: z.array(ModelDescriptorSchema).min(1),
  dataBoundary: z.string().min(1),
  priceTier: z.enum(['free', 'freemium', 'paid', 'enterprise']),
  isInternal: z.boolean(),
}).strict();
export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;

// ===========================================================================
// Section 3: Authorization (设计文档第六节)
// ===========================================================================

export const AuthorizationStateSchema = z.enum([
  'ACTIVE',
  'CONSUMED',
  'REVOKED',
  'EXPIRED',
]);
export type AuthorizationState = z.infer<typeof AuthorizationStateSchema>;

export const AuthorizationRequirementSchema = z.object({
  schema: z.literal('awkn-authorization-requirement/v1'),
  toolId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  requiredActions: z.array(z.string().min(1)).min(1),
  resourceScopes: z.array(ResourceScopeSchema),
  dataScopes: z.array(z.string().min(1)),
  riskCeiling: ToolRiskLevelSchema,
  maxExecutions: SafePositiveIntegerSchema,
  requiresHumanConfirmation: z.boolean(),
}).strict();
export type AuthorizationRequirement = z.infer<typeof AuthorizationRequirementSchema>;

export const AuthorizationTokenSchema = z.object({
  schema: z.literal('awkn-authorization-token/v1'),
  authorizationId: awknIdSchema('auth'),
  actor: ActorRefSchema,
  executionId: awknIdSchema('exec'),
  toolId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  allowedActions: z.array(z.string().min(1)).min(1),
  resourceScopes: z.array(ResourceScopeSchema),
  dataScopes: z.array(z.string().min(1)),
  maxExecutions: SafePositiveIntegerSchema,
  usedCount: SafeNonNegativeIntegerSchema,
  expiresAt: UtcTimestampSchema,
  confirmationSourceRef: z.string().min(1),
  tokenHash: z.string().regex(SHA256_HEX_PATTERN),
  state: AuthorizationStateSchema,
  issuedAt: UtcTimestampSchema,
  revokedAt: UtcTimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.usedCount > value.maxExecutions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['usedCount'],
      message: 'usedCount cannot exceed maxExecutions',
    });
  }
  if (value.expiresAt <= value.issuedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'expiresAt must be after issuedAt',
    });
  }
  if (value.state === 'CONSUMED' && value.usedCount !== value.maxExecutions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['usedCount'],
      message: 'CONSUMED authorization must use its full allowance',
    });
  }
  if (value.state === 'ACTIVE' && value.usedCount >= value.maxExecutions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: 'authorization at its usage ceiling must be CONSUMED',
    });
  }
  if (value.state === 'REVOKED' && value.revokedAt === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revokedAt'],
      message: 'revokedAt is required when status is REVOKED',
    });
  }
  if (value.state !== 'REVOKED' && value.revokedAt !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revokedAt'],
      message: 'revokedAt is only valid when status is REVOKED',
    });
  }
});
export type AuthorizationToken = z.infer<typeof AuthorizationTokenSchema>;

// ===========================================================================
// Section 4: Risk & Cost (设计文档第八节)
// ===========================================================================

export const RiskSnapshotSchema = z.object({
  schema: z.literal('awkn-risk-snapshot/v1'),
  baseActionRisk: ToolRiskLevelSchema,
  dataAggregationRisk: ToolRiskLevelSchema,
  irreversibility: ToolRiskLevelSchema,
  crossSystemPropagation: ToolRiskLevelSchema,
  financialImpact: ToolRiskLevelSchema,
  identityRepresentation: ToolRiskLevelSchema,
  repetitionFactor: SafeNonNegativeIntegerSchema,
  verifiedCompensation: z.boolean(),
  cumulativeRisk: ToolRiskLevelSchema,
}).strict();
export type RiskSnapshot = z.infer<typeof RiskSnapshotSchema>;

export const CostBudgetSchema = z.object({
  schema: z.literal('awkn-cost-budget/v1'),
  estimatedInputTokens: SafeNonNegativeIntegerSchema,
  estimatedOutputTokens: SafeNonNegativeIntegerSchema,
  estimatedCostUsd: z.number().nonnegative(),
  budgetCeilingUsd: z.number().nonnegative(),
  budgetConsumedUsd: z.number().nonnegative(),
}).strict();
export type CostBudget = z.infer<typeof CostBudgetSchema>;

// ===========================================================================
// Section 5: Broker Plan (设计文档第三节)
// ===========================================================================

export const ModelRoutePlanSchema = z.object({
  schema: z.literal('awkn-model-route-plan/v1'),
  routeId: awknIdSchema('mr'),
  taskRole: ModelTaskRoleSchema,
  requestedProviderId: z.string().min(1).optional(),
  requestedModelId: z.string().min(1).optional(),
  selectedProviderId: z.string().min(1),
  selectedModelId: z.string().min(1),
  reasonCodes: z.array(z.string().min(1)).min(1),
  fallbackChain: z.array(z.string().min(1)),
  capabilityDelta: z.array(z.string().min(1)),
  estimatedInputTokens: SafeNonNegativeIntegerSchema,
  estimatedOutputTokens: SafeNonNegativeIntegerSchema,
  estimatedLatencyMs: SafePositiveIntegerSchema,
}).strict();
export type ModelRoutePlan = z.infer<typeof ModelRoutePlanSchema>;

export const ToolRoutePlanSchema = z.object({
  schema: z.literal('awkn-tool-route-plan/v1'),
  toolId: z.string().min(1),
  providerId: z.string().min(1),
  sideEffect: ToolSideEffectSchema,
  riskBase: ToolRiskLevelSchema,
  requiresAuthorization: z.boolean(),
  authorizationRequirement: AuthorizationRequirementSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  requiresSideEffectVerification: z.boolean(),
}).strict();
export type ToolRoutePlan = z.infer<typeof ToolRoutePlanSchema>;

export const ProviderChoiceSchema = z.object({
  schema: z.literal('awkn-provider-choice/v1'),
  providerId: z.string().min(1),
  reasonCodes: z.array(z.string().min(1)).min(1),
  isUserSelected: z.boolean(),
  dataBoundary: z.string().min(1),
  priceTier: z.enum(['free', 'freemium', 'paid', 'enterprise']),
}).strict();
export type ProviderChoice = z.infer<typeof ProviderChoiceSchema>;

export const BrokerPlanSchema = z.object({
  schema: z.literal('awkn-broker-plan/v1'),
  brokerPlanId: awknIdSchema('bp'),
  executionId: awknIdSchema('exec'),
  modelRoutes: z.array(ModelRoutePlanSchema),
  toolRoutes: z.array(ToolRoutePlanSchema),
  providerChoices: z.array(ProviderChoiceSchema),
  authorizationRequirements: z.array(AuthorizationRequirementSchema),
  cumulativeRisk: RiskSnapshotSchema,
  costBudget: CostBudgetSchema,
  planHash: z.string().regex(SHA256_HEX_PATTERN),
  frozenAt: UtcTimestampSchema,
}).strict();
export type BrokerPlan = z.infer<typeof BrokerPlanSchema>;

export const BROKER_PLAN_SCHEMA_ID = 'awkn-broker-plan/v1';

/**
 * 深度剥离 undefined 字段 (递归处理对象和数组).
 *
 * canonical JSON 不允许 undefined 字段, 而 BrokerPlan 中有 optional 字段
 * (如 requestedProviderId / authorizationRequirement / idempotencyKey).
 * 在哈希前剥离它们以保证哈希稳定且不抛错.
 */
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

/**
 * 计算 BrokerPlan 的稳定哈希 (跨平台一致).
 *
 * 排除 planHash / frozenAt 以保证幂等性 — 同一 plan 的两次构建必须
 * 产生相同的哈希, 否则 freeze 不可重现.
 *
 * 在哈希前剥离 undefined optional 字段以符合 canonical JSON 规范.
 */
export function computeBrokerPlanHash(plan: Omit<BrokerPlan, 'planHash' | 'frozenAt'>): string {
  const stripped = stripUndefined(plan as unknown as JsonValue);
  return stableHash(BROKER_PLAN_SCHEMA_ID, stripped);
}

// ===========================================================================
// Section 6: Model Route Receipt (设计文档第 4.2 节)
// ===========================================================================

export const ModelRouteReceiptSchema = z.object({
  schema: z.literal('awkn-model-route-receipt/v1'),
  routeId: awknIdSchema('mr'),
  traceId: awknIdSchema('tr'),
  callSource: z.string().min(1),
  requestedProvider: z.string().min(1).optional(),
  requestedModel: z.string().min(1).optional(),
  executedProvider: z.string().min(1),
  executedModel: z.string().min(1),
  routeReasonCodes: z.array(z.string().min(1)).min(1),
  fallbackOccurred: z.boolean(),
  fallbackChain: z.array(z.string().min(1)),
  capabilityDelta: z.array(z.string().min(1)),
  promptVersion: z.string().min(1),
  policyBundleHash: z.string().regex(SHA256_HEX_PATTERN),
  inputTokens: SafeNonNegativeIntegerSchema,
  outputTokens: SafeNonNegativeIntegerSchema,
  latencyMs: SafeNonNegativeIntegerSchema,
  createdAt: UtcTimestampSchema,
}).strict();
export type ModelRouteReceipt = z.infer<typeof ModelRouteReceiptSchema>;

// ===========================================================================
// Section 7: Tool Execution Receipt (设计文档第十节)
// ===========================================================================

export const ToolExecutionReceiptSchema = z.object({
  schema: z.literal('awkn-tool-execution-receipt/v1'),
  toolCallId: awknIdSchema('tc'),
  toolId: z.string().min(1),
  authorizationId: awknIdSchema('auth').optional(),
  requestHash: z.string().regex(SHA256_HEX_PATTERN),
  resultHash: z.string().regex(SHA256_HEX_PATTERN),
  sideEffect: ToolSideEffectSchema,
  resourceRefs: z.array(z.string().min(1)),
  reportedSuccess: z.boolean(),
  verifiedSuccess: z.boolean(),
  reversible: z.boolean(),
  compensationRef: z.string().min(1).optional(),
  createdAt: UtcTimestampSchema,
}).strict();
export type ToolExecutionReceipt = z.infer<typeof ToolExecutionReceiptSchema>;

// ===========================================================================
// Section 8: 可见降级 (设计文档第 4.3 节)
// ===========================================================================

export const DegradationLevelSchema = z.enum(['NONE', 'CAPABILITY_DELTA', 'DEGRADED', 'BLOCKING']);
export type DegradationLevel = z.infer<typeof DegradationLevelSchema>;

export const DegradationNoticeSchema = z.object({
  schema: z.literal('awkn-degradation-notice/v1'),
  level: DegradationLevelSchema,
  capabilityDelta: z.array(z.string().min(1)),
  fallbackChain: z.array(z.string().min(1)),
  requiresReconfirmation: z.boolean(),
  structuredOutputMissing: z.boolean(),
  reviewerReuseForbidden: z.boolean(),
}).strict();
export type DegradationNotice = z.infer<typeof DegradationNoticeSchema>;

// ===========================================================================
// Section 9: Side-effect Verification (设计文档第九节)
// ===========================================================================

export const SideEffectVerificationResultSchema = z.object({
  schema: z.literal('awkn-side-effect-verification/v1'),
  toolCallId: awknIdSchema('tc'),
  reportedSuccess: z.boolean(),
  verifiedSuccess: z.boolean(),
  resourceRefs: z.array(z.string().min(1)),
  verificationReasonCodes: z.array(z.string().min(1)),
  compensationTriggered: z.boolean(),
  partialState: z.boolean(),
}).strict();
export type SideEffectVerificationResult = z.infer<typeof SideEffectVerificationResultSchema>;
