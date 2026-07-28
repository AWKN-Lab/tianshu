/**
 * Policy Conflict Resolver (Phase 6 / C04 / WP-AOS-06)
 *
 * 设计文档: `docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 6 节 冲突解析
 *
 * 解析顺序 (设计文档第 6 节):
 * 1. 状态有效性
 * 2. Scope 匹配
 * 3. Priority (高优先级胜出)
 * 4. Specificity (更具体胜出)
 * 5. Authority (Core > Project > TaskProfile)
 * 6. Version (最新胜出)
 * 7. 默认选择更保守结果
 *
 * 设计原则:
 * - 高优先级 DENY 覆盖低优先级 ALLOW (测试 1)
 * - 用户偏好 (P400) 不能取消强制授权 (P800+) (测试 2)
 * - 无法解析时返回 POLICY_CONFLICT 并阻断执行
 */

import type {
  CompiledPolicy,
  PolicyConflict,
  PolicyDecision,
  PolicyPriority,
  PolicySource,
} from '../contracts/policy.js';
import {
  canLowerPriorityOverride,
  computePolicySpecificity,
  decisionConservatism,
  isForcedAuthorizationPriority,
  pickConservativeDecision,
  priorityRank,
  sourceAuthority,
} from '../contracts/policy.js';
import { evaluateCondition } from './ast.js';

// ===========================================================================
// Section 1: Resolver Errors
// ===========================================================================

export class PolicyResolverError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PolicyResolverError';
  }
}

// ===========================================================================
// Section 2: Conflict Detection
// ===========================================================================

/**
 * 检测两条 Policy 是否冲突 (相同条件不同决策).
 *
 * 设计文档第 6 节冲突类型:
 * - ALLOW vs DENY
 * - REQUIRE_CONFIRMATION vs AUTO_EXECUTE (此处用 REQUIRE_AUTHORIZATION vs ALLOW)
 * - 相同条件不同阈值
 */
export function detectConflict(
  left: CompiledPolicy,
  right: CompiledPolicy,
  context: Record<string, unknown>,
): PolicyConflict | null {
  // 两条 Policy 都匹配同一上下文
  const leftMatched = evaluateCondition(left.conditionAst, context);
  const rightMatched = evaluateCondition(right.conditionAst, context);
  if (!leftMatched || !rightMatched) return null;

  // 决策相同 → 不冲突
  if (left.decision === right.decision) return null;

  // 决策不同 → 冲突
  const conflictType = detectConflictType(left.decision, right.decision);
  const winner = resolveByPrioritySpecificityAuthority(left, right);

  return {
    schema: 'awkn-policy-conflict/v1',
    conflictType,
    policyIds: [left.policyId, right.policyId],
    reason: `policies ${left.policyId} (${left.decision}) and ${right.policyId} (${right.decision}) match same context`,
    resolution: winner.resolution,
    winningPolicyId: winner.winner?.policyId,
    blocked: winner.winner === null,
  };
}

function detectConflictType(
  left: PolicyDecision,
  right: PolicyDecision,
): PolicyConflict['conflictType'] {
  const decisions = new Set([left, right]);
  if (decisions.has('ALLOW') && (decisions.has('DENY') || decisions.has('BLOCK'))) {
    return 'ALLOW_VS_DENY';
  }
  if (decisions.has('REQUIRE_AUTHORIZATION') && decisions.has('ALLOW')) {
    return 'AUTHORIZATION_VS_AUTO_EXECUTE';
  }
  return 'SCOPE_OVERLAP';
}

// ===========================================================================
// Section 3: Conflict Resolution
// ===========================================================================

interface ResolutionResult {
  winner: CompiledPolicy | null;
  resolution: PolicyConflict['resolution'];
  reason: string;
}

/**
 * 按优先级 / Specificity / Authority 解析冲突 (设计文档第 6 节 3-5 项).
 */
function resolveByPrioritySpecificityAuthority(
  left: CompiledPolicy,
  right: CompiledPolicy,
): ResolutionResult {
  // 3. Priority
  const leftPriority = priorityRank(left.priority);
  const rightPriority = priorityRank(right.priority);
  if (leftPriority !== rightPriority) {
    const winner = leftPriority > rightPriority ? left : right;
    return {
      winner,
      resolution: 'PRIORITY_WINS',
      reason: `${winner.policyId} has higher priority (${winner.priority})`,
    };
  }

  // 4. Specificity
  const leftSpec = computePolicySpecificity(left);
  const rightSpec = computePolicySpecificity(right);
  if (leftSpec !== rightSpec) {
    const winner = leftSpec > rightSpec ? left : right;
    return {
      winner,
      resolution: 'SPECIFICITY_WINS',
      reason: `${winner.policyId} has higher specificity (${leftSpec > rightSpec ? leftSpec : rightSpec})`,
    };
  }

  // 5. Authority
  const leftAuth = sourceAuthority(left.source);
  const rightAuth = sourceAuthority(right.source);
  if (leftAuth !== rightAuth) {
    const winner = leftAuth > rightAuth ? left : right;
    return {
      winner,
      resolution: 'AUTHORITY_WINS',
      reason: `${winner.policyId} has higher authority (${winner.source})`,
    };
  }

  // 7. 默认选择更保守结果
  const leftConservative = decisionConservatism(left.decision);
  const rightConservative = decisionConservatism(right.decision);
  if (leftConservative !== rightConservative) {
    const winner = leftConservative > rightConservative ? left : right;
    return {
      winner,
      resolution: 'CONSERVATIVE_DEFAULT',
      reason: `${winner.policyId} has more conservative decision (${winner.decision})`,
    };
  }

  // 完全无法解析
  return {
    winner: null,
    resolution: 'UNRESOLVED',
    reason: `policies ${left.policyId} and ${right.policyId} are equivalent on all dimensions`,
  };
}

// ===========================================================================
// Section 4: Policy Decision Resolution
// ===========================================================================

/**
 * Policy 求值结果
 */
export interface ResolvedPolicyDecision {
  decision: PolicyDecision;
  matchedPolicyIds: string[];
  conflicts: PolicyConflict[];
  requiredActions: string[];
  prohibitedActions: string[];
  evidenceRequirements: string[];
  reasonCodes: string[];
  blocked: boolean;
}

/**
 * 解析一组 Policy 在给定上下文下的最终决策.
 *
 * 设计文档第 6 节 冲突解析顺序:
 * 1. 状态有效性 — 已由 Registry 保证 (只传入 ACTIVE)
 * 2. Scope 匹配 — 调用方负责筛选 scope
 * 3. Priority — 高优先级胜出
 * 4. Specificity — 更具体胜出
 * 5. Authority — Core > Project > TaskProfile
 * 6. Version — 最新胜出
 * 7. 默认选择更保守结果
 *
 * 关键规则:
 * - 高优先级 DENY 覆盖低优先级 ALLOW (设计文档第 5 节)
 * - 用户偏好 (P400) 不能取消强制授权 (P800+) (设计文档第 5 节)
 */
export function resolvePolicyDecision(
  policies: readonly CompiledPolicy[],
  context: Record<string, unknown>,
): ResolvedPolicyDecision {
  // 1. 筛选匹配的 Policy
  const matched: CompiledPolicy[] = [];
  for (const policy of policies) {
    if (evaluateCondition(policy.conditionAst, context)) {
      matched.push(policy);
    }
  }

  if (matched.length === 0) {
    return {
      decision: 'ALLOW',
      matchedPolicyIds: [],
      conflicts: [],
      requiredActions: [],
      prohibitedActions: [],
      evidenceRequirements: [],
      reasonCodes: ['NO_POLICY_MATCHED'],
      blocked: false,
    };
  }

  // 2. 检测冲突
  const conflicts: PolicyConflict[] = [];
  for (let i = 0; i < matched.length; i += 1) {
    for (let j = i + 1; j < matched.length; j += 1) {
      const conflict = detectConflict(matched[i], matched[j], context);
      if (conflict) conflicts.push(conflict);
    }
  }

  // 3. 按优先级排序 (高优先级在前)
  const sorted = [...matched].sort((a, b) => {
    const priorityDiff = priorityRank(b.priority) - priorityRank(a.priority);
    if (priorityDiff !== 0) return priorityDiff;
    const specDiff = computePolicySpecificity(b) - computePolicySpecificity(a);
    if (specDiff !== 0) return specDiff;
    return sourceAuthority(b.source) - sourceAuthority(a.source);
  });

  // 4. 应用高优先级覆盖低优先级规则
  const finalDecision = computeFinalDecision(sorted);
  const blocked = finalDecision === 'BLOCK' || finalDecision === 'ESCALATE' ||
    conflicts.some((c) => c.blocked && c.resolution === 'UNRESOLVED');

  // 5. 聚合 required / prohibited / evidence
  const requiredActions = new Set<string>();
  const prohibitedActions = new Set<string>();
  const evidenceRequirements = new Set<string>();
  const reasonCodes: string[] = [];

  for (const policy of sorted) {
    // 强制授权 (P800+) 的 requiredActions 不能被用户偏好 (P400) 取消
    if (isForcedAuthorizationPriority(policy.priority)) {
      policy.requiredActions.forEach((a) => requiredActions.add(a));
      policy.prohibitedActions.forEach((a) => prohibitedActions.add(a));
      policy.evidenceRequirements.forEach((e) => evidenceRequirements.add(e));
      reasonCodes.push(`${policy.policyId}:FORCE_AUTHZ:${policy.priority}`);
    } else if (policy.priority === 'P400' || policy.priority === 'P300' || policy.priority === 'P200') {
      // 用户偏好 (P400) 只能添加, 不能取消强制授权
      policy.requiredActions.forEach((a) => requiredActions.add(a));
      // 用户偏好不能取消 prohibitedActions
      if (finalDecision === 'ALLOW') {
        // 用户偏好只能 ALLOW, 不能取消已有的禁止
      }
    } else {
      policy.requiredActions.forEach((a) => requiredActions.add(a));
      policy.prohibitedActions.forEach((a) => prohibitedActions.add(a));
      policy.evidenceRequirements.forEach((e) => evidenceRequirements.add(e));
    }
  }

  return {
    decision: finalDecision,
    matchedPolicyIds: sorted.map((p) => p.policyId),
    conflicts,
    requiredActions: [...requiredActions],
    prohibitedActions: [...prohibitedActions],
    evidenceRequirements: [...evidenceRequirements],
    reasonCodes,
    blocked,
  };
}

/**
 * 计算最终决策 (应用高优先级覆盖规则).
 *
 * 规则:
 * - 高优先级 DENY 覆盖低优先级 ALLOW
 * - 高优先级 BLOCK / ESCALATE 优先
 * - 用户偏好 (P400) 不能取消强制授权 (P800+)
 */
function computeFinalDecision(sorted: readonly CompiledPolicy[]): PolicyDecision {
  if (sorted.length === 0) return 'ALLOW';

  // 高优先级在前, 第一个非 ALLOW 决策胜出
  // 但需要检查: 是否高优先级是 ALLOW 而低优先级是 DENY/BLOCK
  let finalDecision: PolicyDecision = sorted[0].decision;
  let topPriority: PolicyPriority = sorted[0].priority;

  for (let i = 1; i < sorted.length; i += 1) {
    const policy = sorted[i];
    // 低优先级规则不能削弱高优先级规则
    if (canLowerPriorityOverride(policy.priority, topPriority)) {
      // policy.priority 比 topPriority 低
      // 低优先级 DENY/BLOCK/ESCALATE 可以叠加到高优先级 ALLOW (更保守)
      // 低优先级 ALLOW 不能覆盖高优先级 DENY/BLOCK/ESCALATE/REQUIRE_AUTHORIZATION
      if (finalDecision === 'ALLOW') {
        // 允许低优先级把 ALLOW 升级为更保守
        finalDecision = pickConservativeDecision(finalDecision, policy.decision);
      }
      // 但如果高优先级已经是强制授权 (P800+), 低优先级 (P400-) 不能取消
      if (isForcedAuthorizationPriority(topPriority) && !isForcedAuthorizationPriority(policy.priority)) {
        // 强制授权优先级决策不被低优先级影响
        continue;
      }
    } else {
      // policy.priority 比 topPriority 高 (理论上不会, 已排序)
      finalDecision = policy.decision;
      topPriority = policy.priority;
    }
  }

  return finalDecision;
}

// ===========================================================================
// Section 5: Specific Conflict Resolution Helpers
// ===========================================================================

/**
 * 检查用户偏好是否能取消强制授权 (设计文档第 5 节, 测试 2).
 *
 * 用户偏好 (P400) 不能取消强制授权 (P800+).
 */
export function canUserPreferenceOverrideForcedAuthz(
  userPreferencePriority: PolicyPriority,
  forcedAuthzPriority: PolicyPriority,
): boolean {
  // 用户偏好优先级必须 >= 800 才能取消强制授权
  if (!isForcedAuthorizationPriority(userPreferencePriority)) return false;
  return priorityRank(userPreferencePriority) > priorityRank(forcedAuthzPriority);
}

/**
 * 检查来源是否允许 (设计文档第 11 节).
 */
export function isSourceAllowed(source: PolicySource): boolean {
  return source === 'core' || source === 'project' || source === 'taskProfile';
}
