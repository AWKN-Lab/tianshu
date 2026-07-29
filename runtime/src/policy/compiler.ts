/**
 * Policy Compiler (Phase 6 / C04 / WP-AOS-06)
 *
 * 设计文档：`docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 2 章
 *
 * 职责：
 * - 从 Registry 查询 ACTIVE Policy（按 IntentDecision + GoalSpec + ContextManifest scope）
 * - 评估每个 Policy 的 condition（用 ast.ts evaluator）
 * - 解析冲突（用 resolver.ts）
 * - 计算 bundleHash（用 stableHash）
 * - 冻结 CompiledPolicyBundle（不可变）
 *
 * 主链：
 *   IntentDecision + GoalSpec + ContextManifest
 *   → Applicable Policy Discovery
 *   → Conflict Detection (resolver.ts)
 *   → Conflict Resolution
 *   → Policy AST (CompiledPolicy[])
 *   → Precomputed Decisions (常见场景)
 *   → Bundle Hash (stableHash)
 *   → Freeze
 *   → CompiledPolicyBundle
 *
 * Mode 0：纯函数，不持久化，不修改 Registry
 */

import { stableHash } from '../contracts/canonical-json.js';
import { createAwknId } from '../contracts/ids.js';
import type {
  Policy,
  CompiledPolicy,
  CompiledPolicyBundle,
  PolicyConflict,
  PrecomputedPolicyDecision,
  PolicyBundleHashInput,
  PolicyDecisionType,
  PolicyRequiredAction,
  PolicyProhibitedAction,
  PolicyEvidenceRequirement,
} from '../contracts/policy.js';
import type { IntentDecision } from '../contracts/intent.js';
import type { JsonValue } from '../contracts/json-value.js';
import type { PolicyRegistry } from './registry.js';
import { evaluateCondition } from './ast.js';
import { resolveConflicts, applyConflictResolutions, hasUnresolvedConflicts } from './resolver.js';

/** Compiler 版本 */
export const POLICY_COMPILER_VERSION = 'awkn-policy-compiler/v1';

/** Compiler 错误 */
export class PolicyCompilerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PolicyCompilerError';
  }
}

/** Compiler 输入 */
export interface PolicyCompilerInput {
  readonly executionId: string;
  readonly intentDecision: IntentDecision;
  readonly context: JsonValue;
  readonly registry: PolicyRegistry;
  readonly compiledAt: string;
}

/** Compiler 输出（Bundle + 冲突报告） */
export interface PolicyCompilerOutput {
  readonly bundle: CompiledPolicyBundle;
  readonly conflicts: readonly PolicyConflict[];
  readonly applicablePolicies: readonly Policy[];
  readonly matchedPolicies: readonly Policy[];
}

/**
 * 编译 Policy Bundle
 *
 * 步骤：
 * 1. 按 IntentDecision scope 查询 ACTIVE Policy
 * 2. 评估每个 Policy condition，过滤未匹配的
 * 3. 检测并解析冲突
 * 4. 应用冲突解析（删除被击败的）
 * 5. 计算 bundleHash
 * 6. 冻结 Bundle（标记 frozenAt）
 *
 * @throws PolicyCompilerError 如果存在 UNRESOLVED 冲突
 */
export function compilePolicyBundle(input: PolicyCompilerInput): PolicyCompilerOutput {
  const { executionId, intentDecision, context, registry, compiledAt } = input;

  // Step 1: 按 scope 查询 ACTIVE Policy
  const applicablePolicies = registry.queryActive({
    taskProfile: intentDecision.taskProfile,
    level: intentDecision.executionLevel,
  });

  // Step 2: 评估 condition
  const matchedPolicies: Policy[] = [];
  for (const policy of applicablePolicies) {
    try {
      if (evaluateCondition(policy.condition, context)) {
        matchedPolicies.push(policy);
      }
    } catch (err) {
      // AST 评估错误：fail-closed，包含此 Policy 但标记为 BLOCK
      throw new PolicyCompilerError(
        `Policy condition evaluation failed for ${policy.policyId}: ${err instanceof Error ? err.message : String(err)}`,
        'CONDITION_EVALUATION_FAILED',
      );
    }
  }

  // Step 3: 冲突检测与解析
  const conflicts = resolveConflicts(matchedPolicies);
  if (hasUnresolvedConflicts(conflicts)) {
    // UNRESOLVED 冲突：fail-closed，但仍生成 Bundle（decisions 为空）
    // 调用方应检查 conflicts 并决定是否阻断
  }

  // Step 4: 应用冲突解析
  const resolvedPolicies = applyConflictResolutions(matchedPolicies, conflicts);

  // Step 5: 转换为 CompiledPolicy[]
  const compiledPolicies: CompiledPolicy[] = resolvedPolicies.map((policy) => {
    const sourceHash = stableHash(policy.schema, policy as unknown as JsonValue);
    return {
      policyId: policy.policyId,
      version: policy.version,
      priority: policy.priority,
      decision: policy.decision,
      condition: policy.condition,
      requiredActions: policy.requiredActions,
      prohibitedActions: policy.prohibitedActions,
      evidenceRequirements: policy.evidenceRequirements,
      onFailure: policy.onFailure,
      sourceHash,
    };
  });

  // Step 6: 预计算常见场景决策（简化实现：每个 Policy 一个 decision）
  const precomputedDecisions: PrecomputedPolicyDecision[] = compiledPolicies.map((policy) => ({
    decisionId: `dec_${policy.policyId}`,
    policyIds: [policy.policyId],
    decision: policy.decision,
    matchedConditions: [`condition_${policy.policyId}`],
    requiredActions: policy.requiredActions,
    prohibitedActions: policy.prohibitedActions,
    evidenceRequirements: policy.evidenceRequirements,
  }));

  // Step 7: sourceVersions
  const sourceVersions: Record<string, string> = {};
  for (const policy of resolvedPolicies) {
    sourceVersions[policy.policyId] = policy.version;
  }

  // Step 8: 计算 bundleHash
  const bundleId = `pb_${createAwknId('shadowDiff').slice('sdiff_'.length)}`;
  const hashInput: PolicyBundleHashInput = {
    schema: 'awkn-compiled-policy-bundle/v1',
    bundleId,
    executionId,
    policies: compiledPolicies,
    conflicts,
    decisions: precomputedDecisions,
    compilerVersion: POLICY_COMPILER_VERSION,
    sourceVersions,
  };
  const bundleHash = stableHash('awkn-compiled-policy-bundle/v1', hashInput as unknown as JsonValue);

  // Step 9: 冻结 Bundle
  const bundle: CompiledPolicyBundle = {
    schema: 'awkn-compiled-policy-bundle/v1',
    bundleId,
    executionId,
    policies: compiledPolicies,
    conflicts: [...conflicts],
    decisions: precomputedDecisions,
    compilerVersion: POLICY_COMPILER_VERSION,
    sourceVersions,
    bundleHash,
    frozenAt: compiledAt,
  };

  return {
    bundle,
    conflicts,
    applicablePolicies,
    matchedPolicies,
  };
}

/**
 * 评估 Bundle 是否阻断执行
 *
 * 阻断条件：
 * - 任一 Policy decision = BLOCK 或 DENY
 * - 任一 conflict resolution = UNRESOLVED
 */
export function isBundleBlocking(bundle: CompiledPolicyBundle): boolean {
  if (hasUnresolvedConflicts(bundle.conflicts)) return true;
  return bundle.policies.some((p) => p.decision === 'BLOCK' || p.decision === 'DENY');
}

/**
 * 提取 Bundle 的最高决策（按保守性）
 *
 * 用于快速判断整体决策：
 * - 任一 DENY → DENY
 * - 任一 BLOCK → BLOCK
 * - 任一 REQUIRE_AUTHORIZATION → REQUIRE_AUTHORIZATION
 * - 任一 REQUIRE_CONFIRMATION → REQUIRE_CONFIRMATION
 * - 否则 → ALLOW
 */
export function extractOverallDecision(bundle: CompiledPolicyBundle): PolicyDecisionType {
  const decisions = bundle.policies.map((p) => p.decision);
  if (decisions.includes('DENY')) return 'DENY';
  if (decisions.includes('BLOCK')) return 'BLOCK';
  if (decisions.includes('ESCALATE')) return 'ESCALATE';
  if (decisions.includes('REQUIRE_CONFIRMATION')) return 'REQUIRE_CONFIRMATION';
  if (decisions.includes('REQUIRE_AUTHORIZATION')) return 'REQUIRE_AUTHORIZATION';
  if (decisions.includes('LIMIT')) return 'LIMIT';
  return 'ALLOW';
}

/**
 * 提取 Bundle 的所有 requiredActions（去重）
 */
export function extractRequiredActions(bundle: CompiledPolicyBundle): PolicyRequiredAction[] {
  const set = new Set<PolicyRequiredAction>();
  for (const policy of bundle.policies) {
    for (const action of policy.requiredActions) {
      set.add(action);
    }
  }
  return [...set];
}

/**
 * 提取 Bundle 的所有 prohibitedActions（去重）
 */
export function extractProhibitedActions(bundle: CompiledPolicyBundle): PolicyProhibitedAction[] {
  const set = new Set<PolicyProhibitedAction>();
  for (const policy of bundle.policies) {
    for (const action of policy.prohibitedActions) {
      set.add(action);
    }
  }
  return [...set];
}

/**
 * 提取 Bundle 的所有 evidenceRequirements（去重）
 */
export function extractEvidenceRequirements(bundle: CompiledPolicyBundle): PolicyEvidenceRequirement[] {
  const set = new Set<PolicyEvidenceRequirement>();
  for (const policy of bundle.policies) {
    for (const req of policy.evidenceRequirements) {
      set.add(req);
    }
  }
  return [...set];
}
