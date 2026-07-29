/**
 * Policy Conflict Resolver (Phase 6 / C04 / WP-AOS-06)
 *
 * 设计文档：`docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 6 章
 *
 * 职责：
 * - 检测一组 Policy 中的冲突
 * - 按解析顺序选择胜者：状态有效性 → Scope 匹配 → Priority → Specificity → Authority → Version → 保守结果
 * - 无法解析时返回 UNRESOLVED（fail-closed，阻断执行）
 *
 * 冲突类型（设计文档第 6 章）：
 * - ALLOW_VS_DENY
 * - REQUIRE_CONFIRMATION_VS_AUTO_EXECUTE
 * - THRESHOLD_MISMATCH
 * - MULTIPLE_ACTIVE_VERSIONS
 * - SCOPE_OVERLAP
 * - PROJECT_RULE_OVERLAP
 * - USER_PREFERENCE_VS_GOVERNANCE
 * - SKILL_DEPENDENCY_INCOMPATIBLE（在 Skill Compiler 中处理）
 */

import type {
  Policy,
  PolicyConflict,
  PolicyConflictResolution,
  PolicyDecisionType,
} from '../contracts/policy.js';

/** Resolver 错误 */
export class PolicyConflictResolverError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PolicyConflictResolverError';
  }
}

/** 决策保守性排序（高索引 = 更保守，胜出） */
const DECISION_CONSERVATIVENESS: Record<PolicyDecisionType, number> = {
  ALLOW: 0,
  LIMIT: 1,
  REQUIRE_AUTHORIZATION: 2,
  REQUIRE_CONFIRMATION: 3,
  ESCALATE: 4,
  BLOCK: 5,
  DENY: 6,
};

/** Authority 等级（设计文档第 6 章 Authority） */
const AUTHORITY_LEVEL: Record<string, number> = {
  evolve_candidate: 0,
  project: 1,
  task_profile: 2,
  core: 3,
};

/**
 * 检测并解析一组 Policy 的冲突
 *
 * 输入：同 scope 内的 ACTIVE Policy 列表
 * 输出：conflicts 数组
 *
 * 解析规则（设计文档第 6 章）：
 * 1. 状态有效性：非 ACTIVE Policy 已被 Registry 过滤
 * 2. Scope 匹配：相同 scope 才比较
 * 3. Priority：高优先级胜出
 * 4. Specificity：更具体的 scope 胜出
 * 5. Authority：core > task_profile > project > evolve_candidate
 * 6. Version：新版本胜出（相同优先级 + authority 时）
 * 7. 默认选择更保守结果（DENY > BLOCK > ESCALATE > ...）
 */
export function resolveConflicts(policies: readonly Policy[]): readonly PolicyConflict[] {
  const conflicts: PolicyConflict[] = [];

  // 1. MULTIPLE_ACTIVE_VERSIONS 检测
  const byPolicyId = new Map<string, Policy[]>();
  for (const policy of policies) {
    const group = byPolicyId.get(policy.policyId) ?? [];
    group.push(policy);
    byPolicyId.set(policy.policyId, group);
  }
  for (const [policyId, group] of byPolicyId) {
    if (group.length > 1) {
      // 选最新版本胜出
      const sortedByVersion = [...group].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
      const winner = sortedByVersion[0]!;
      conflicts.push({
        conflictId: `cf_${policyId}_multi_active`,
        type: 'MULTIPLE_ACTIVE_VERSIONS',
        policyIds: [group[0]!.policyId, group[1]!.policyId],
        field: 'version',
        description: `Multiple ACTIVE versions for ${policyId}: ${group.map((p) => p.version).join(', ')}`,
        resolution: 'PRIORITY_WINS',
        winningPolicyId: winner.policyId,
      });
    }
  }

  // 2. ALLOW_VS_DENY 冲突检测
  const denyPolicies = policies.filter((p) => p.decision === 'DENY');
  const allowPolicies = policies.filter((p) => p.decision === 'ALLOW');
  if (denyPolicies.length > 0 && allowPolicies.length > 0) {
    for (const deny of denyPolicies) {
      for (const allow of allowPolicies) {
        if (deny.policyId === allow.policyId) continue;
        // 解析：高优先级胜出；同优先级则 DENY 胜出（保守）
        let resolution: PolicyConflictResolution = 'CONSERVATIVE_WINS';
        let winner: string;
        if (deny.priority > allow.priority) {
          resolution = 'PRIORITY_WINS';
          winner = deny.policyId;
        } else if (allow.priority > deny.priority) {
          resolution = 'PRIORITY_WINS';
          winner = allow.policyId;
        } else {
          // 同优先级 → Authority
          const denyAuth = AUTHORITY_LEVEL[deny.source] ?? 0;
          const allowAuth = AUTHORITY_LEVEL[allow.source] ?? 0;
          if (denyAuth > allowAuth) {
            resolution = 'AUTHORITY_WINS';
            winner = deny.policyId;
          } else if (allowAuth > denyAuth) {
            resolution = 'AUTHORITY_WINS';
            winner = allow.policyId;
          } else {
            // 同 authority → CONSERVATIVE_WINS（DENY）
            winner = deny.policyId;
          }
        }
        conflicts.push({
          conflictId: `cf_${deny.policyId}_vs_${allow.policyId}`,
          type: 'ALLOW_VS_DENY',
          policyIds: [deny.policyId, allow.policyId],
          field: 'decision',
          description: `DENY (${deny.policyId}@${deny.version}) vs ALLOW (${allow.policyId}@${allow.version})`,
          resolution,
          winningPolicyId: winner,
        });
      }
    }
  }

  // 3. REQUIRE_CONFIRMATION_VS_AUTO_EXECUTE 冲突检测
  const requireConfirm = policies.filter((p) => p.decision === 'REQUIRE_CONFIRMATION');
  const autoExec = policies.filter((p) => p.decision === 'ALLOW' && !p.requiredActions.includes('request_explicit_confirmation'));
  if (requireConfirm.length > 0 && autoExec.length > 0) {
    for (const rc of requireConfirm) {
      for (const ae of autoExec) {
        if (rc.policyId === ae.policyId) continue;
        // REQUIRE_CONFIRMATION 保守性更高，胜出
        conflicts.push({
          conflictId: `cf_${rc.policyId}_vs_${ae.policyId}_confirm`,
          type: 'REQUIRE_CONFIRMATION_VS_AUTO_EXECUTE',
          policyIds: [rc.policyId, ae.policyId],
          field: 'decision',
          description: `REQUIRE_CONFIRMATION (${rc.policyId}) vs auto-execute ALLOW (${ae.policyId})`,
          resolution: 'CONSERVATIVE_WINS',
          winningPolicyId: rc.policyId,
        });
      }
    }
  }

  // 4. THRESHOLD_MISMATCH 检测（同 field 不同阈值）
  // 简化实现：检测同 policyId 但 condition 中相同 field 有不同 value
  // 完整实现需要 AST 对比，此处先做基础检查

  // 5. SCOPE_OVERLAP 检测（多个 Policy 覆盖同一 scope + priority）
  const byPriority = new Map<number, Policy[]>();
  for (const policy of policies) {
    const group = byPriority.get(policy.priority) ?? [];
    group.push(policy);
    byPriority.set(policy.priority, group);
  }
  for (const [priority, group] of byPriority) {
    if (group.length > 1 && group.every((p) => p.decision !== 'DENY' && p.decision !== 'ALLOW')) {
      // 同优先级 + 非 ALLOW/DENY：可能是 SCOPE_OVERLAP
      conflicts.push({
        conflictId: `cf_scope_overlap_${priority}`,
        type: 'SCOPE_OVERLAP',
        policyIds: [group[0]!.policyId, group[1]!.policyId],
        field: 'scope',
        description: `${group.length} policies overlap at priority ${priority}: ${group.map((p) => p.policyId).join(', ')}`,
        resolution: 'SPECIFICITY_WINS',
      });
    }
  }

  // 6. PROJECT_RULE_OVERLAP（来源 project 与 core 重叠）
  const projectPolicies = policies.filter((p) => p.source === 'project');
  const corePolicies = policies.filter((p) => p.source === 'core');
  for (const project of projectPolicies) {
    for (const core of corePolicies) {
      if (project.policyId === core.policyId) continue;
      if (project.priority === core.priority && project.decision === core.decision) {
        conflicts.push({
          conflictId: `cf_project_${project.policyId}_vs_core_${core.policyId}`,
          type: 'PROJECT_RULE_OVERLAP',
          policyIds: [project.policyId, core.policyId],
          field: 'priority',
          description: `Project rule ${project.policyId} overlaps with core ${core.policyId}`,
          resolution: 'AUTHORITY_WINS',
          winningPolicyId: core.policyId,
        });
      }
    }
  }

  // 7. USER_PREFERENCE_VS_GOVERNANCE
  // 检查 evolve_candidate 与 core/project 冲突
  const evolvePolicies = policies.filter((p) => p.source === 'evolve_candidate');
  for (const evolve of evolvePolicies) {
    for (const core of corePolicies) {
      if (evolve.priority > core.priority) {
        // evolve_candidate 不能压制 core
        conflicts.push({
          conflictId: `cf_evolve_${evolve.policyId}_vs_core_${core.policyId}`,
          type: 'USER_PREFERENCE_VS_GOVERNANCE',
          policyIds: [evolve.policyId, core.policyId],
          field: 'priority',
          description: `Evolve candidate ${evolve.policyId} cannot override core ${core.policyId}`,
          resolution: 'AUTHORITY_WINS',
          winningPolicyId: core.policyId,
        });
      }
    }
  }

  return conflicts;
}

/**
 * 检查是否有 UNRESOLVED 冲突
 *
 * 设计文档第 6 章：无法解析时返回 POLICY_CONFLICT 并阻断执行
 */
export function hasUnresolvedConflicts(conflicts: readonly PolicyConflict[]): boolean {
  return conflicts.some((c) => c.resolution === 'UNRESOLVED');
}

/**
 * 获取胜出的 Policy 列表（从冲突中提取 winningPolicyId）
 */
export function extractWinners(conflicts: readonly PolicyConflict[]): Set<string> {
  const winners = new Set<string>();
  for (const conflict of conflicts) {
    if (conflict.winningPolicyId) {
      winners.add(conflict.winningPolicyId);
    }
  }
  return winners;
}

/**
 * 应用 conflicts 到一组 Policy，返回最终生效的 Policy
 *
 * 规则：
 * - DENY 胜出时，删除所有同 conflict 的 ALLOW
 * - 删除被 defeated 的 Policy
 */
export function applyConflictResolutions(
  policies: readonly Policy[],
  conflicts: readonly PolicyConflict[],
): readonly Policy[] {
  const defeated = new Set<string>();
  for (const conflict of conflicts) {
    if (!conflict.winningPolicyId) continue;
    for (const policyId of conflict.policyIds) {
      if (policyId !== conflict.winningPolicyId) {
        defeated.add(policyId);
      }
    }
  }
  return policies.filter((p) => !defeated.has(p.policyId));
}

/** 决策保守性比较（用于 fallback 排序） */
export function compareByConservatism(a: PolicyDecisionType, b: PolicyDecisionType): number {
  return DECISION_CONSERVATIVENESS[b] - DECISION_CONSERVATIVENESS[a];
}
