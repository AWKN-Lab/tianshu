/**
 * Policy Compiler Contracts (Phase 6 / C04 / WP-AOS-06)
 *
 * 设计文档：`docs/agent-os-3.0/05-Policy-Skill-Compiler.md` v0.2 Draft
 *
 * 本文件冻结 Policy Compiler 的所有公开 Contract：
 * - PolicySchema (awkn-policy/v1)：Policy 源定义
 * - CompiledPolicySchema：编译后 Policy AST
 * - PolicyConflictSchema：冲突描述
 * - PrecomputedPolicyDecisionSchema：预计算决策
 * - CompiledPolicyBundleSchema (awkn-compiled-policy-bundle/v1)：Bundle 产物
 * - PolicyCandidateLifecycle：候选生命周期状态
 *
 * 不变量：
 * - 所有 schema 使用 zod strict + superRefine
 * - 所有 hash 使用 stableHash（canonical-json.ts）
 * - 所有 ID 使用 createAwknId / awknIdSchema
 * - 所有时间戳使用 UtcTimestampSchema
 */

import { z } from 'zod';
import { awknIdSchema, createAwknId } from './ids.js';
import { UtcTimestampSchema } from './time.js';
import { JsonValueSchema, JsonValue } from './json-value.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-zA-Z.-]+)?(?:\+[0-9a-zA-Z.-]+)?$/;

// ===== 通用枚举 =====

/** Policy 状态生命周期（设计文档第 14 章） */
export const PolicyStatusSchema = z.enum([
  'DRAFT',
  'VALIDATING',
  'APPROVED',
  'ACTIVE',
  'QUARANTINED',
  'RETIRED',
]);
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

/** Policy 决策类型（设计文档第 3 章 decision 字段） */
export const PolicyDecisionTypeSchema = z.enum([
  'ALLOW',
  'DENY',
  'REQUIRE_AUTHORIZATION',
  'REQUIRE_CONFIRMATION',
  'LIMIT',
  'ESCALATE',
  'BLOCK',
]);
export type PolicyDecisionType = z.infer<typeof PolicyDecisionTypeSchema>;

/** Policy 失败处理（设计文档第 3 章 onFailure 字段） */
export const PolicyOnFailureSchema = z.enum(['BLOCK', 'WARN', 'ALLOW_WITH_RECEIPT']);
export type PolicyOnFailure = z.infer<typeof PolicyOnFailureSchema>;

/** Policy 优先级（设计文档第 5 章 P1000-P200） */
export const PolicyPrioritySchema = z.number().int().min(100).max(1000);
export type PolicyPriority = z.infer<typeof PolicyPrioritySchema>;

/** Policy 类型（设计文档第 3.1 章） */
export const PolicyTypeSchema = z.enum([
  'identity',
  'input',
  'privacy',
  'memory',
  'tool',
  'model_routing',
  'freshness',
  'delivery',
  'project_governance',
  'task_profile',
  'evolution',
]);
export type PolicyType = z.infer<typeof PolicyTypeSchema>;

/** 执行层级（与 intent.ts ExecutionLevelSchema 一致） */
export const PolicyExecutionLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4', 'all']);
export type PolicyExecutionLevel = z.infer<typeof PolicyExecutionLevelSchema>;

/** Task Profile 引用（'all' 或 TaskProfileId） */
export const PolicyTaskProfileSchema = z.enum([
  'all',
  'analysis',
  'research',
  'engineering',
  'repository_review',
  'document_creation',
  'automation',
  'scheduled_check',
  'multi_agent_orchestration',
]);
export type PolicyTaskProfile = z.infer<typeof PolicyTaskProfileSchema>;

// ===== Policy Scope =====

/** Policy 适用范围 */
export const PolicyScopeSchema = z.object({
  taskProfiles: z.array(PolicyTaskProfileSchema).min(1),
  levels: z.array(PolicyExecutionLevelSchema).min(1),
}).strict();
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

// ===== Policy Condition（AST） =====

/** Policy 条件操作符 */
export const PolicyConditionOperatorSchema = z.enum([
  'all', // AND
  'any', // OR
  'none', // NOT
  'eq', // equals
  'neq', // not equals
  'gt', // greater than
  'gte', // greater than or equal
  'lt', // less than
  'lte', // less than or equal
  'in', // in set
  'nin', // not in set
  'matches', // regex match
  'exists', // field exists
  'not_exists', // field not exists
]);
export type PolicyConditionOperator = z.infer<typeof PolicyConditionOperatorSchema>;

/** Policy 条件 AST 节点（递归） */
export interface PolicyCondition {
  readonly operator: PolicyConditionOperator;
  readonly field?: string;
  readonly value?: JsonValue;
  readonly children?: readonly PolicyCondition[];
}

/** Policy Condition Schema（递归 zod schema） */
export const PolicyConditionSchema: z.ZodType<PolicyCondition> = z.lazy(() => z.object({
  operator: PolicyConditionOperatorSchema,
  field: z.string().min(1).optional(),
  value: JsonValueSchema.optional(),
  children: z.array(z.lazy(() => PolicyConditionSchema)).optional(),
}).strict());

// ===== Policy 源定义（awkn-policy/v1） =====

/** Policy 必要动作（设计文档第 3 章 requiredActions） */
export const PolicyRequiredActionSchema = z.enum([
  'build_action_summary',
  'bind_target_resource',
  'request_explicit_confirmation',
  'attach_evidence_bundle',
  'record_audit_trail',
  'capture_side_effect_receipt',
]);
export type PolicyRequiredAction = z.infer<typeof PolicyRequiredActionSchema>;

/** Policy 禁止动作（设计文档第 3 章 prohibitedActions） */
export const PolicyProhibitedActionSchema = z.enum([
  'execute_without_authorization',
  'bypass_audit_trail',
  'skip_evidence_collection',
  'use_legacy_path',
  'modify_state_offline',
]);
export type PolicyProhibitedAction = z.infer<typeof PolicyProhibitedActionSchema>;

/** Policy 证据要求 */
export const PolicyEvidenceRequirementSchema = z.enum([
  'authorization_receipt',
  'tool_execution_receipt',
  'context_manifest_hash',
  'side_effect_verification',
  'human_confirmation',
  'deterministic_test_pass',
]);
export type PolicyEvidenceRequirement = z.infer<typeof PolicyEvidenceRequirementSchema>;

/**
 * Policy 源定义 Schema (awkn-policy/v1)
 *
 * 设计文档第 3 章。
 */
export const PolicySchema = z.object({
  schema: z.literal('awkn-policy/v1'),
  policyId: z.string().min(1).regex(/^[a-z0-9.-]+$/i, 'policyId must be kebab-case'),
  version: z.string().regex(SEMVER_PATTERN, 'version must be semver'),
  status: PolicyStatusSchema,
  type: PolicyTypeSchema,
  scope: PolicyScopeSchema,
  priority: PolicyPrioritySchema,
  condition: PolicyConditionSchema,
  decision: PolicyDecisionTypeSchema,
  requiredActions: z.array(PolicyRequiredActionSchema),
  prohibitedActions: z.array(PolicyProhibitedActionSchema),
  evidenceRequirements: z.array(PolicyEvidenceRequirementSchema),
  onFailure: PolicyOnFailureSchema,
  description: z.string().min(1),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  source: z.enum(['core', 'project', 'task_profile', 'evolve_candidate']),
}).strict().superRefine((value, context) => {
  // updatedAt 必须 >= createdAt
  if (value.updatedAt < value.createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt must be >= createdAt',
    });
  }
  // DENY 决策不应有 requiredActions
  if (value.decision === 'DENY' && value.requiredActions.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requiredActions'],
      message: 'DENY decision must not have requiredActions',
    });
  }
});
export type Policy = z.infer<typeof PolicySchema>;

// ===== CompiledPolicy（编译后 AST） =====

/** CompiledPolicy：编译后保留的 Policy AST 节点 */
export const CompiledPolicySchema = z.object({
  policyId: z.string().min(1),
  version: z.string().regex(SEMVER_PATTERN),
  priority: PolicyPrioritySchema,
  decision: PolicyDecisionTypeSchema,
  condition: PolicyConditionSchema,
  requiredActions: z.array(PolicyRequiredActionSchema),
  prohibitedActions: z.array(PolicyProhibitedActionSchema),
  evidenceRequirements: z.array(PolicyEvidenceRequirementSchema),
  onFailure: PolicyOnFailureSchema,
  sourceHash: z.string().regex(SHA256_HEX_PATTERN),
}).strict();
export type CompiledPolicy = z.infer<typeof CompiledPolicySchema>;

// ===== PolicyConflict =====

/** Policy 冲突类型（设计文档第 6 章） */
export const PolicyConflictTypeSchema = z.enum([
  'ALLOW_VS_DENY',
  'REQUIRE_CONFIRMATION_VS_AUTO_EXECUTE',
  'THRESHOLD_MISMATCH',
  'MULTIPLE_ACTIVE_VERSIONS',
  'SKILL_DEPENDENCY_INCOMPATIBLE',
  'PROJECT_RULE_OVERLAP',
  'USER_PREFERENCE_VS_GOVERNANCE',
  'SCOPE_OVERLAP',
]);
export type PolicyConflictType = z.infer<typeof PolicyConflictTypeSchema>;

/** Policy 冲突解析结果 */
export const PolicyConflictResolutionSchema = z.enum([
  'PRIORITY_WINS',
  'SPECIFICITY_WINS',
  'AUTHORITY_WINS',
  'CONSERVATIVE_WINS',
  'UNRESOLVED',
]);
export type PolicyConflictResolution = z.infer<typeof PolicyConflictResolutionSchema>;

/** Policy 冲突描述 */
export const PolicyConflictSchema = z.object({
  conflictId: z.string().min(1),
  type: PolicyConflictTypeSchema,
  policyIds: z.array(z.string().min(1)).length(2),
  field: z.string().min(1),
  description: z.string().min(1),
  resolution: PolicyConflictResolutionSchema,
  winningPolicyId: z.string().min(1).optional(),
}).strict();
export type PolicyConflict = z.infer<typeof PolicyConflictSchema>;

// ===== PrecomputedPolicyDecision =====

/** 预计算 Policy 决策（针对常见输入场景，提前计算好的决策） */
export const PrecomputedPolicyDecisionSchema = z.object({
  decisionId: z.string().min(1),
  policyIds: z.array(z.string().min(1)).min(1),
  decision: PolicyDecisionTypeSchema,
  matchedConditions: z.array(z.string().min(1)),
  requiredActions: z.array(PolicyRequiredActionSchema),
  prohibitedActions: z.array(PolicyProhibitedActionSchema),
  evidenceRequirements: z.array(PolicyEvidenceRequirementSchema),
}).strict();
export type PrecomputedPolicyDecision = z.infer<typeof PrecomputedPolicyDecisionSchema>;

// ===== CompiledPolicyBundle（awkn-compiled-policy-bundle/v1） =====

/**
 * Compiled Policy Bundle Schema (awkn-compiled-policy-bundle/v1)
 *
 * 设计文档第 7.1 章。
 *
 * 不变量：
 * - bundleHash 由 stableHash 计算（排除 frozenAt）
 * - sourceVersions 记录每个 Policy 源版本
 * - conflicts 数组：UNRESOLVED 冲突会使 Bundle 整体拒绝（fail-closed）
 */
export const CompiledPolicyBundleSchema = z.object({
  schema: z.literal('awkn-compiled-policy-bundle/v1'),
  bundleId: z.string().min(1).regex(/^pb_[0-9a-f]{32}$/),
  executionId: awknIdSchema('exec'),
  policies: z.array(CompiledPolicySchema).min(1),
  conflicts: z.array(PolicyConflictSchema),
  decisions: z.array(PrecomputedPolicyDecisionSchema),
  compilerVersion: z.string().regex(/^awkn-policy-compiler\/v\d+$/, 'compilerVersion must be awkn-policy-compiler/v<n>'),
  sourceVersions: z.record(z.string(), z.string().regex(SEMVER_PATTERN)),
  bundleHash: z.string().regex(SHA256_HEX_PATTERN),
  frozenAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  // 如果存在 UNRESOLVED 冲突，Bundle 必须标记为不可用（通过 empty decisions 表达）
  const hasUnresolved = value.conflicts.some((c) => c.resolution === 'UNRESOLVED');
  if (hasUnresolved && value.decisions.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['decisions'],
      message: 'Bundle with UNRESOLVED conflicts must not have precomputed decisions',
    });
  }
  // sourceVersions 必须覆盖所有 policies 的 policyId
  const policyIds = new Set(value.policies.map((p) => p.policyId));
  const sourceVersionKeys = new Set(Object.keys(value.sourceVersions));
  for (const policyId of policyIds) {
    if (!sourceVersionKeys.has(policyId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceVersions'],
        message: `sourceVersions missing policyId: ${policyId}`,
      });
    }
  }
});
export type CompiledPolicyBundle = z.infer<typeof CompiledPolicyBundleSchema>;

// ===== Bundle ID 生成 =====

/** Policy Bundle ID 前缀 */
export const POLICY_BUNDLE_ID_PREFIX = 'pb';

/**
 * 生成 Policy Bundle ID.
 *
 * @param contentHash 可选内容 Hash (SHA256 hex). 若提供，则基于内容 Hash 生成确定性 ID
 *   (相同内容产生相同 ID). 若不提供，则回退到随机 UUID.
 */
export function createPolicyBundleId(contentHash?: string): string {
  if (contentHash && /^[0-9a-f]{64}$/.test(contentHash)) {
    return `${POLICY_BUNDLE_ID_PREFIX}_${contentHash.slice(0, 32)}`;
  }
  return createAwknId('policyBundle');
}

// ===== Compiler Receipt（awkn-compiler-receipt/v1） =====

/**
 * Compiler Receipt Schema (awkn-compiler-receipt/v1)
 *
 * 设计文档第 12 章。Policy + Skill Compiler 共用同一个 Receipt。
 */
export const CompilerReceiptSchema = z.object({
  schema: z.literal('awkn-compiler-receipt/v1'),
  executionId: awknIdSchema('exec'),
  policyBundleId: z.string().min(1).regex(/^pb_[0-9a-f]{32}$/).optional(),
  skillBundleId: z.string().min(1).regex(/^sb_[0-9a-f]{32}$/).optional(),
  selectedPolicies: z.array(z.string().min(1)),
  selectedSkills: z.array(z.string().min(1)),
  conflicts: z.array(PolicyConflictSchema),
  preflightPassed: z.boolean(),
  bundleHash: z.string().regex(SHA256_HEX_PATTERN),
  compilerVersion: z.string().min(1),
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  // 至少要有一个 Bundle
  if (!value.policyBundleId && !value.skillBundleId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policyBundleId'],
      message: 'at least one of policyBundleId/skillBundleId must be present',
    });
  }
  // preflightPassed=false 时 conflicts 必须非空
  if (!value.preflightPassed && value.conflicts.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['conflicts'],
      message: 'preflightPassed=false requires at least one conflict',
    });
  }
});
export type CompilerReceipt = z.infer<typeof CompilerReceiptSchema>;

// ===== Bundle Hash 输入 =====

/**
 * Bundle Hash 计算输入（用于 stableHash）
 *
 * 排除 frozenAt（时间戳不影响内容 hash）
 */
export interface PolicyBundleHashInput {
  readonly schema: 'awkn-compiled-policy-bundle/v1';
  readonly bundleId: string;
  readonly executionId: string;
  readonly policies: readonly CompiledPolicy[];
  readonly conflicts: readonly PolicyConflict[];
  readonly decisions: readonly PrecomputedPolicyDecision[];
  readonly compilerVersion: string;
  readonly sourceVersions: Record<string, string>;
}
