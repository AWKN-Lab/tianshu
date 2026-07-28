/**
 * Policy 契约 (Phase 6 / C04 / WP-AOS-06)
 *
 * 设计文档: `docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 3, 5, 6, 7 节
 *
 * 职责:
 * - 声明 Policy / CompiledPolicyBundle / PolicyConflict / PrecomputedPolicyDecision schema
 * - 计算 Bundle 稳定哈希 (排除 bundleHash / frozenAt, stripUndefined)
 *
 * 设计原则:
 * - fail-closed: 多 ACTIVE 版本 / 冲突未解 → 阻断执行
 * - 版本冻结: bundleHash 由 stableHash(schemaId, value) 决定, 跨平台一致
 * - 优先级单调: 低优先级规则不能削弱高优先级规则
 * - 保守默认: 无法解析时返回 POLICY_CONFLICT 并阻断
 */

import { z } from 'zod';
import { stableHash } from './canonical-json.js';
import { awknIdSchema } from './ids.js';
import type { JsonValue } from './json-value.js';
import { JsonValueSchema } from './json-value.js';
import { SafeNonNegativeIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ===========================================================================
// Section 1: Policy Status & Priority & Decision
// ===========================================================================

/**
 * Policy 状态机 (设计文档第 14 节)
 *
 *   DRAFT → VALIDATING → APPROVED → ACTIVE → QUARANTINED / RETIRED
 *
 * ACTIVE 条件:
 * - Schema 合法
 * - 冲突检查通过
 * - 基线回放无安全回归
 * - 高影响项目规则经过人工批准
 */
export const PolicyStatusSchema = z.enum([
  'DRAFT',
  'VALIDATING',
  'APPROVED',
  'ACTIVE',
  'QUARANTINED',
  'RETIRED',
]);
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

/**
 * Policy 优先级 (设计文档第 5 节)
 *
 * | 等级 | 用途 |
 * |---|---|
 * | P1000 | Core Constitution |
 * | P900  | Security / Privacy / Identity |
 * | P800  | Authorization / Tool / External Side Effect |
 * | P700  | Tianshu Project Governance |
 * | P600  | Task Profile Rules |
 * | P500  | Goal-specific Policies |
 * | P400  | User Preferences |
 * | P300  | Skill Defaults |
 * | P200  | Model Suggestions |
 *
 * 低优先级规则不能削弱高优先级规则.
 */
export const PolicyPrioritySchema = z.enum([
  'P1000',
  'P900',
  'P800',
  'P700',
  'P600',
  'P500',
  'P400',
  'P300',
  'P200',
]);
export type PolicyPriority = z.infer<typeof PolicyPrioritySchema>;

/**
 * Policy 决策类型 (设计文档第 3 节)
 *
 * - ALLOW: 允许执行
 * - DENY: 拒绝执行
 * - REQUIRE_AUTHORIZATION: 要求显式授权
 * - BLOCK: 阻断执行并停止后续步骤
 * - ESCALATE: 升级到更高权威
 */
export const PolicyDecisionSchema = z.enum([
  'ALLOW',
  'DENY',
  'REQUIRE_AUTHORIZATION',
  'BLOCK',
  'ESCALATE',
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/**
 * Policy 失败处理策略 (设计文档第 3 节 onFailure)
 */
export const PolicyOnFailureSchema = z.enum(['BLOCK', 'ESCALATE', 'RETRY']);
export type PolicyOnFailure = z.infer<typeof PolicyOnFailureSchema>;

// ===========================================================================
// Section 2: Policy Condition AST (设计文档第 3 节 condition)
// ===========================================================================

/**
 * Policy 条件 AST 叶子节点操作符
 *
 * - field: 上下文路径 (支持点号分隔, 如 `action.sideEffect`)
 * - equals: 字段值等于指定值
 * - notEquals: 字段值不等于指定值
 * - in: 字段值在指定集合中
 * - gt: 字段值大于指定数值
 * - lt: 字段值小于指定数值
 */
export const PolicyConditionLeafSchema = z.object({
  field: z.string().min(1),
  equals: JsonValueSchema.optional(),
  notEquals: JsonValueSchema.optional(),
  in: z.array(JsonValueSchema).min(1).optional(),
  gt: z.number().finite().optional(),
  lt: z.number().finite().optional(),
}).strict().superRefine((value, context) => {
  const operators = ['equals', 'notEquals', 'in', 'gt', 'lt']
    .filter((op) => value[op as keyof typeof value] !== undefined);
  if (operators.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['field'],
      message: 'condition leaf must specify exactly one operator (equals/notEquals/in/gt/lt)',
    });
  }
  if (operators.length > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['field'],
      message: `condition leaf must specify exactly one operator, got ${operators.length}`,
    });
  }
});

export type PolicyConditionLeaf = z.infer<typeof PolicyConditionLeafSchema>;

/**
 * Policy 条件 AST 节点 (递归)
 *
 * - { all: [...] }: 所有子条件都满足
 * - { any: [...] }: 任一子条件满足
 * - 叶子节点: { field, equals/notEquals/in/gt/lt }
 */
export type PolicyConditionNode =
  | { all: PolicyConditionNode[] }
  | { any: PolicyConditionNode[] }
  | PolicyConditionLeaf;

// 手写的 lazy schema: zod 不支持直接递归 union
export const PolicyConditionNodeSchema: z.ZodType<PolicyConditionNode> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(z.lazy(() => PolicyConditionNodeSchema)).min(1) }).strict(),
    z.object({ any: z.array(z.lazy(() => PolicyConditionNodeSchema)).min(1) }).strict(),
    PolicyConditionLeafSchema,
  ]),
);

// ===========================================================================
// Section 3: Policy Schema (设计文档第 3 节)
// ===========================================================================

export const POLICY_SCHEMA_ID = 'awkn-policy/v1';

/**
 * Policy Scope (设计文档第 3 节 scope)
 */
export const PolicyScopeSchema = z.object({
  taskProfiles: z.array(z.string().min(1)).min(1),
  levels: z.array(z.enum(['L1', 'L2', 'L3', 'L4'])).min(1),
}).strict();
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

/**
 * Policy 来源类型 (设计文档第 11 节 Registry 边界)
 *
 * 允许注册:
 * - core: 天枢 Core Policy
 * - project: 天枢 Project Governance Policy
 * - taskProfile: 天枢 Task Profile Policy
 *
 * 禁止注册: gundam, value, hotel, mr-mont, annie, subtitle 等其他业务项目
 */
export const PolicySourceSchema = z.enum(['core', 'project', 'taskProfile']);
export type PolicySource = z.infer<typeof PolicySourceSchema>;

/**
 * Policy Schema (awkn-policy/v1)
 */
export const PolicySchema = z.object({
  schema: z.literal(POLICY_SCHEMA_ID),
  policyId: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver x.y.z'),
  status: PolicyStatusSchema,
  source: PolicySourceSchema,
  scope: PolicyScopeSchema,
  priority: PolicyPrioritySchema,
  condition: PolicyConditionNodeSchema,
  decision: PolicyDecisionSchema,
  requiredActions: z.array(z.string().min(1)),
  prohibitedActions: z.array(z.string().min(1)),
  evidenceRequirements: z.array(z.string().min(1)),
  onFailure: PolicyOnFailureSchema,
}).strict();
export type Policy = z.infer<typeof PolicySchema>;

// ===========================================================================
// Section 4: Compiled Policy (设计文档第 7.1 节)
// ===========================================================================

/**
 * 已编译 Policy (AST 形式, 便于运行时求值)
 */
export const CompiledPolicySchema = z.object({
  schema: z.literal('awkn-compiled-policy/v1'),
  policyId: z.string().min(1),
  version: z.string().min(1),
  source: PolicySourceSchema,
  priority: PolicyPrioritySchema,
  decision: PolicyDecisionSchema,
  conditionAst: PolicyConditionNodeSchema,
  requiredActions: z.array(z.string().min(1)),
  prohibitedActions: z.array(z.string().min(1)),
  evidenceRequirements: z.array(z.string().min(1)),
  onFailure: PolicyOnFailureSchema,
}).strict();
export type CompiledPolicy = z.infer<typeof CompiledPolicySchema>;

/**
 * Policy 冲突描述 (设计文档第 6 节)
 */
export const PolicyConflictTypeSchema = z.enum([
  'ALLOW_VS_DENY',
  'AUTHORIZATION_VS_AUTO_EXECUTE',
  'THRESHOLD_MISMATCH',
  'MULTI_ACTIVE_VERSION',
  'SCOPE_OVERLAP',
  'USER_PREF_VS_GOVERNANCE',
  'PROJECT_RULE_VS_CORE_POLICY',
]);
export type PolicyConflictType = z.infer<typeof PolicyConflictTypeSchema>;

export const PolicyConflictSchema = z.object({
  schema: z.literal('awkn-policy-conflict/v1'),
  conflictType: PolicyConflictTypeSchema,
  policyIds: z.array(z.string().min(1)).min(2),
  reason: z.string().min(1),
  resolution: z.enum(['UNRESOLVED', 'PRIORITY_WINS', 'SPECIFICITY_WINS', 'AUTHORITY_WINS', 'CONSERVATIVE_DEFAULT']),
  winningPolicyId: z.string().min(1).optional(),
  blocked: z.boolean(),
}).strict();
export type PolicyConflict = z.infer<typeof PolicyConflictSchema>;

/**
 * 预计算 Policy 决策 (针对特定上下文)
 */
export const PrecomputedPolicyDecisionSchema = z.object({
  schema: z.literal('awkn-precomputed-policy-decision/v1'),
  contextFingerprint: z.string().min(1),
  matchedPolicyIds: z.array(z.string().min(1)),
  finalDecision: PolicyDecisionSchema,
  requiredActions: z.array(z.string().min(1)),
  prohibitedActions: z.array(z.string().min(1)),
  evidenceRequirements: z.array(z.string().min(1)),
  reasonCodes: z.array(z.string().min(1)),
}).strict();
export type PrecomputedPolicyDecision = z.infer<typeof PrecomputedPolicyDecisionSchema>;

// ===========================================================================
// Section 5: Compiled Policy Bundle (设计文档第 7.1 节)
// ===========================================================================

export const COMPILED_POLICY_BUNDLE_SCHEMA_ID = 'awkn-compiled-policy-bundle/v1';

export const CompiledPolicyBundleSchema = z.object({
  schema: z.literal(COMPILED_POLICY_BUNDLE_SCHEMA_ID),
  bundleId: awknIdSchema('pb'),
  executionId: awknIdSchema('exec'),
  policies: z.array(CompiledPolicySchema),
  conflicts: z.array(PolicyConflictSchema),
  decisions: z.array(PrecomputedPolicyDecisionSchema),
  compilerVersion: z.string().min(1),
  sourceVersions: z.record(z.string().min(1), z.string().min(1)),
  bundleHash: z.string().regex(SHA256_HEX_PATTERN),
  frozenAt: UtcTimestampSchema,
}).strict();
export type CompiledPolicyBundle = z.infer<typeof CompiledPolicyBundleSchema>;

// ===========================================================================
// Section 6: Bundle Hash (设计文档第 10 节 版本与冻结)
// ===========================================================================

/**
 * 深度剥离 undefined 字段 (递归处理对象和数组).
 *
 * canonical JSON 不允许 undefined 字段, 而 Policy Bundle 中有 optional 字段
 * (如 conflict.winningPolicyId / condition leaf 操作符). 在哈希前剥离它们
 * 以保证哈希稳定且不抛错.
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
 * 计算 CompiledPolicyBundle 的稳定哈希 (跨平台一致).
 *
 * 排除 bundleHash / frozenAt 以保证幂等性 — 同一 bundle 的两次构建必须
 * 产生相同的哈希, 否则 freeze 不可重现.
 *
 * 在哈希前剥离 undefined optional 字段以符合 canonical JSON 规范.
 */
export function computePolicyBundleHash(
  bundle: Omit<CompiledPolicyBundle, 'bundleHash' | 'frozenAt'>,
): string {
  const stripped = stripUndefined(bundle as unknown as JsonValue);
  return stableHash(COMPILED_POLICY_BUNDLE_SCHEMA_ID, stripped);
}

// ===========================================================================
// Section 7: Policy Evaluator Adapter (设计文档第 13 节 REUSE/UPGRADE)
// ===========================================================================

/**
 * Policy Evaluator Adapter Input
 *
 * ToolPolicy (src/tools/policy.ts) 升级为 Policy Evaluator Adapter,
 * 输出符合 PolicyDecision 的统一格式, 由 PolicyCompiler 使用.
 */
export const PolicyEvaluatorInputSchema = z.object({
  schema: z.literal('awkn-policy-evaluator-input/v1'),
  toolId: z.string().min(1),
  args: z.record(JsonValueSchema),
  workspaceRoot: z.string().min(1),
  approvedToolNames: z.array(z.string().min(1)),
  allowOutsideWorkspace: z.boolean(),
  allowSensitivePaths: z.boolean(),
});
export type PolicyEvaluatorInput = z.infer<typeof PolicyEvaluatorInputSchema>;

export const PolicyEvaluatorOutputSchema = z.object({
  schema: z.literal('awkn-policy-evaluator-output/v1'),
  decision: PolicyDecisionSchema,
  reason: z.string().min(1),
  resolvedPaths: z.array(z.string().min(1)),
  reasonCodes: z.array(z.string().min(1)),
});
export type PolicyEvaluatorOutput = z.infer<typeof PolicyEvaluatorOutputSchema>;

// ===========================================================================
// Section 8: Policy Priority Helpers
// ===========================================================================

const PRIORITY_RANK: Record<PolicyPriority, number> = {
  P1000: 1000,
  P900: 900,
  P800: 800,
  P700: 700,
  P600: 600,
  P500: 500,
  P400: 400,
  P300: 300,
  P200: 200,
};

export function priorityRank(priority: PolicyPriority): number {
  return PRIORITY_RANK[priority];
}

/**
 * 判断 low 优先级是否不能削弱 high 优先级 (设计文档第 5 节)
 *
 * 用户偏好 (P400) 不能取消强制授权 (P800+).
 */
export function canLowerPriorityOverride(
  low: PolicyPriority,
  high: PolicyPriority,
): boolean {
  // 低优先级 DENY 可以叠加到高优先级 ALLOW (更保守), 但不能反过来.
  // 低优先级 ALLOW 不能覆盖高优先级 DENY / REQUIRE_AUTHORIZATION / BLOCK / ESCALATE.
  return priorityRank(low) > priorityRank(high);
}

/**
 * 强制授权优先级阈值 (P800 及以上).
 *
 * 用户偏好 (P400) 不能取消此优先级的决策.
 */
export const FORCED_AUTHORIZATION_PRIORITY_RANK = 800;

export function isForcedAuthorizationPriority(priority: PolicyPriority): boolean {
  return priorityRank(priority) >= FORCED_AUTHORIZATION_PRIORITY_RANK;
}

// ===========================================================================
// Section 9: Specificity (设计文档第 6 节 冲突解析顺序)
// ===========================================================================

/**
 * 计算 Policy 条件 AST 的 specificity 分数.
 *
 * specificity 越高表示条件越具体 (匹配范围越窄):
 * - 叶子节点: 1
 * - all 节点: sum(children) + 1
 * - any 节点: max(children) + 1
 *
 * 冲突解析时, 更具体的规则胜出 (设计文档第 6 节 第 4 项).
 */
export function computeConditionSpecificity(node: PolicyConditionNode): number {
  if ('all' in node) {
    return node.all.reduce((sum, child) => sum + computeConditionSpecificity(child), 0) + 1;
  }
  if ('any' in node) {
    return Math.max(...node.any.map((child) => computeConditionSpecificity(child))) + 1;
  }
  return 1;
}

/**
 * 计算 Policy 的 specificity 分数 (基于条件 AST).
 *
 * Policy.condition 和 CompiledPolicy.conditionAst 都指向同一条件 AST,
 * 但字段名不同, 此处统一处理.
 */
export function computePolicySpecificity(policy: CompiledPolicy | Policy): number {
  const condition = 'conditionAst' in policy ? policy.conditionAst : policy.condition;
  return computeConditionSpecificity(condition);
}

// ===========================================================================
// Section 10: Authority (设计文档第 6 节 冲突解析顺序)
// ===========================================================================

const SOURCE_AUTHORITY: Record<PolicySource, number> = {
  core: 100,
  project: 80,
  taskProfile: 60,
};

export function sourceAuthority(source: PolicySource): number {
  return SOURCE_AUTHORITY[source];
}

// ===========================================================================
// Section 11: Conservative Default (设计文档第 6 节 第 7 项)
// ===========================================================================

/**
 * 保守决策排序 (越靠前越保守).
 *
 * BLOCK > ESCALATE > DENY > REQUIRE_AUTHORIZATION > ALLOW
 */
const DECISION_CONSERVATIVENESS: Record<PolicyDecision, number> = {
  BLOCK: 5,
  ESCALATE: 4,
  DENY: 3,
  REQUIRE_AUTHORIZATION: 2,
  ALLOW: 1,
};

export function decisionConservatism(decision: PolicyDecision): number {
  return DECISION_CONSERVATIVENESS[decision];
}

/**
 * 选择更保守的决策 (设计文档第 6 节 第 7 项 默认选择更保守结果).
 */
export function pickConservativeDecision(
  left: PolicyDecision,
  right: PolicyDecision,
): PolicyDecision {
  return DECISION_CONSERVATIVENESS[left] >= DECISION_CONSERVATIVENESS[right]
    ? left
    : right;
}

// ===========================================================================
// Section 12: Context Fingerprint (用于 PrecomputedPolicyDecision)
// ===========================================================================

/**
 * 计算上下文指纹 (用于预计算决策的 cache key).
 *
 * 使用 stableHash 保证跨平台一致.
 */
export function computeContextFingerprint(context: Record<string, unknown>): string {
  const stripped = stripUndefined(context as JsonValue) as JsonValue;
  return stableHash('awkn-policy-context/v1', stripped);
}

// ===========================================================================
// Section 13: Schema IDs 常量
// ===========================================================================

export const POLICY_CONFLICT_SCHEMA_ID = 'awkn-policy-conflict/v1';
export const PRECOMPUTED_POLICY_DECISION_SCHEMA_ID = 'awkn-precomputed-policy-decision/v1';
export const COMPILED_POLICY_SCHEMA_ID = 'awkn-compiled-policy/v1';
export const POLICY_EVALUATOR_INPUT_SCHEMA_ID = 'awkn-policy-evaluator-input/v1';
export const POLICY_EVALUATOR_OUTPUT_SCHEMA_ID = 'awkn-policy-evaluator-output/v1';

// Re-export 用于类型推断的辅助类型
export type { SafeNonNegativeIntegerSchema };
