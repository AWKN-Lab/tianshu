/**
 * PolicyCompiler (Phase 6 / C04 / WP-AOS-06)
 *
 * 设计文档: `docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 2 节编译主链
 *
 * 主流程:
 * ```text
 * IntentDecision + GoalSpec + ContextManifest
 * → Applicable Policy Discovery
 * → Conflict Detection
 * → Priority Resolution
 * → Preflight Evaluation
 * → Policy AST
 * → Bundle Hash
 * → Freeze
 * → Compiler Receipts
 * ```
 *
 * 设计原则:
 * - fail-closed: 未解冲突 → 阻断 (POLICY_CONFLICT)
 * - 版本冻结: bundleHash 由 stableHash(schemaId, value) 决定, 跨平台一致
 * - Registry 更新不改变运行中 Bundle (通过 Policy 引用副本保证)
 */

import type {
  CompiledPolicy,
  CompiledPolicyBundle,
  PolicyConflict,
  PrecomputedPolicyDecision,
} from '../contracts/policy.js';
import {
  computeContextFingerprint,
  computePolicyBundleHash,
} from '../contracts/policy.js';
import { createAwknId } from '../contracts/ids.js';
import { compilePolicyToAst, freezeConditionNode } from './ast.js';
import type { PolicyRegistry } from './registry.js';
import { detectConflict, resolvePolicyDecision } from './resolver.js';

// ===========================================================================
// Section 1: Compiler Errors
// ===========================================================================

export class PolicyCompilerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PolicyCompilerError';
  }
}

// ===========================================================================
// Section 2: Compiler Input
// ===========================================================================

export interface PolicyCompilerInput {
  executionId: string;
  registry: PolicyRegistry;
  /** 目标 taskProfile (用于 scope 筛选) */
  taskProfile: string;
  /** 目标 level (L1/L2/L3/L4) */
  level: 'L1' | 'L2' | 'L3' | 'L4';
  /** 预计算的上下文场景 (用于 PrecomputedPolicyDecision) */
  precomputeContexts: ReadonlyArray<Record<string, unknown>>;
  /** 编译器版本 */
  compilerVersion: string;
  /** 冻结时间戳 (UTC ISO-8601) */
  frozenAt: string;
}

// ===========================================================================
// Section 3: PolicyCompiler
// ===========================================================================

/**
 * PolicyCompiler 编译 Pipeline.
 *
 * 步骤:
 * 1. Discover: 从 Registry 获取所有 ACTIVE Policy
 * 2. Scope Filter: 按 taskProfile / level 筛选
 * 3. Compile: Policy → CompiledPolicy AST
 * 4. Precompute Decisions: 对预定义上下文预计算决策
 * 5. Detect Conflicts: 检测冲突
 * 6. Hash: 计算 bundleHash (排除 bundleHash / frozenAt)
 * 7. Freeze: 生成不可变 Bundle
 *
 * fail-closed:
 * - Registry 无 ACTIVE Policy → 抛错 (EMPTY_REGISTRY)
 * - Scope 筛选后无 Policy → 抛错 (NO_POLICY_IN_SCOPE)
 * - 有 UNRESOLVED 冲突 → 抛错 (UNRESOLVED_CONFLICT)
 */
export function compilePolicyBundle(input: PolicyCompilerInput): CompiledPolicyBundle {
  // 1. Discover
  const allActive = input.registry.snapshotActive();
  if (allActive.length === 0) {
    throw new PolicyCompilerError(
      'registry has no ACTIVE policy',
      'EMPTY_REGISTRY',
    );
  }

  // 2. Scope Filter
  const scoped = allActive.filter((policy) =>
    policy.scope.taskProfiles.includes('all') ||
    policy.scope.taskProfiles.includes(input.taskProfile)
  ).filter((policy) =>
    policy.scope.levels.includes(input.level)
  );

  if (scoped.length === 0) {
    throw new PolicyCompilerError(
      `no policy matches scope (taskProfile=${input.taskProfile}, level=${input.level})`,
      'NO_POLICY_IN_SCOPE',
    );
  }

  // 3. Compile to AST
  const compiledPolicies: CompiledPolicy[] = scoped.map((policy) => {
    const compiled = compilePolicyToAst(policy);
    // 冻结 AST 防止 Skill 文本改写
    freezeConditionNode(compiled.conditionAst);
    return compiled;
  });

  // 4. Precompute Decisions
  const decisions: PrecomputedPolicyDecision[] = [];
  for (const context of input.precomputeContexts) {
    const result = resolvePolicyDecision(compiledPolicies, context);
    decisions.push({
      schema: 'awkn-precomputed-policy-decision/v1',
      contextFingerprint: computeContextFingerprint(context),
      matchedPolicyIds: result.matchedPolicyIds,
      finalDecision: result.decision,
      requiredActions: result.requiredActions,
      prohibitedActions: result.prohibitedActions,
      evidenceRequirements: result.evidenceRequirements,
      reasonCodes: result.reasonCodes,
    });
  }

  // 5. Detect Conflicts (跨所有预计算上下文)
  const conflicts: PolicyConflict[] = [];
  for (const context of input.precomputeContexts) {
    for (let i = 0; i < compiledPolicies.length; i += 1) {
      for (let j = i + 1; j < compiledPolicies.length; j += 1) {
        const conflict = detectConflict(compiledPolicies[i], compiledPolicies[j], context);
        if (conflict && !conflicts.some((c) =>
          c.policyIds[0] === conflict.policyIds[0] &&
          c.policyIds[1] === conflict.policyIds[1] &&
          c.conflictType === conflict.conflictType
        )) {
          conflicts.push(conflict);
        }
      }
    }
  }

  // 6. Fail-closed: UNRESOLVED 冲突阻断
  const unresolvedConflicts = conflicts.filter((c) => c.resolution === 'UNRESOLVED' && c.blocked);
  if (unresolvedConflicts.length > 0) {
    throw new PolicyCompilerError(
      `unresolved policy conflicts detected: ${unresolvedConflicts.map((c) => c.policyIds.join(' vs ')).join('; ')}`,
      'UNRESOLVED_CONFLICT',
    );
  }

  // 7. Build Bundle (排除 bundleHash / frozenAt)
  const sourceVersions: Record<string, string> = {};
  for (const policy of scoped) {
    sourceVersions[`${policy.policyId}@${policy.version}`] =
      input.registry.getContentHash(policy.policyId, policy.version) ?? '';
  }

  const bundleId = createAwknId('policyBundle');
  const bundleWithoutHash: Omit<CompiledPolicyBundle, 'bundleHash' | 'frozenAt'> = {
    schema: 'awkn-compiled-policy-bundle/v1',
    bundleId,
    executionId: input.executionId,
    policies: compiledPolicies,
    conflicts,
    decisions,
    compilerVersion: input.compilerVersion,
    sourceVersions,
  };

  // 8. Hash & Freeze
  const bundleHash = computePolicyBundleHash(bundleWithoutHash);
  return {
    ...bundleWithoutHash,
    bundleHash,
    frozenAt: input.frozenAt,
  };
}

// ===========================================================================
// Section 4: Compiler Receipt (设计文档第 12 节)
// ===========================================================================

export interface PolicyCompilerReceipt {
  schema: 'awkn-policy-compiler-receipt/v1';
  executionId: string;
  policyBundleId: string;
  selectedPolicies: string[];
  conflicts: PolicyConflict[];
  preflightPassed: boolean;
  bundleHash: string;
  compilerVersion: string;
  frozenAt: string;
}

/**
 * 生成 PolicyCompiler Receipt (设计文档第 12 节).
 */
export function buildPolicyCompilerReceipt(
  bundle: CompiledPolicyBundle,
  compilerVersion: string,
): PolicyCompilerReceipt {
  return {
    schema: 'awkn-policy-compiler-receipt/v1',
    executionId: bundle.executionId,
    policyBundleId: bundle.bundleId,
    selectedPolicies: bundle.policies.map((p) => `${p.policyId}@${p.version}`),
    conflicts: bundle.conflicts,
    preflightPassed: bundle.conflicts.every((c) => c.resolution !== 'UNRESOLVED'),
    bundleHash: bundle.bundleHash,
    compilerVersion,
    frozenAt: bundle.frozenAt,
  };
}

// ===========================================================================
// Section 5: Bundle Stability Check
// ===========================================================================

/**
 * 检查两次编译是否产生相同 bundleHash (设计文档第 10 节 版本与冻结).
 *
 * 同一 Registry 状态下的两次编译必须产生相同 bundleHash.
 * Registry 更新不改变运行中 Bundle — 已编译 Bundle 持有 Policy 引用副本.
 */
export function isBundleHashStable(
  left: CompiledPolicyBundle,
  right: CompiledPolicyBundle,
): boolean {
  return left.bundleHash === right.bundleHash;
}

/**
 * 计算两个 Bundle 的差异 (用于 Registry 更新检测).
 *
 * 设计文档第 10 节: 运行中 Registry 更新不能改变已启动 Run.
 */
export interface BundleDiff {
  addedPolicies: string[];
  removedPolicies: string[];
  addedConflicts: number;
  removedConflicts: number;
  hashChanged: boolean;
}

export function diffBundles(
  old: CompiledPolicyBundle,
  current: CompiledPolicyBundle,
): BundleDiff {
  const oldIds = new Set(old.policies.map((p) => `${p.policyId}@${p.version}`));
  const currentIds = new Set(current.policies.map((p) => `${p.policyId}@${p.version}`));
  return {
    addedPolicies: [...currentIds].filter((id) => !oldIds.has(id)),
    removedPolicies: [...oldIds].filter((id) => !currentIds.has(id)),
    addedConflicts: Math.max(0, current.conflicts.length - old.conflicts.length),
    removedConflicts: Math.max(0, old.conflicts.length - current.conflicts.length),
    hashChanged: old.bundleHash !== current.bundleHash,
  };
}
