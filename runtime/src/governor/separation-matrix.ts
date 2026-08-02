/**
 * 职责隔离矩阵 — 强制角色分离
 *
 * 基于 INCOMPATIBLE_ROLES 矩阵，防止同一 actor 在同一 scope 下持有不相容角色。
 * STRICT 级别还要求 provider 不同（防止同模型自审/自批）。
 * 相同 actorId 或 sessionId 视为同一 agent（防止伪造多智能体绕过分离）。
 *
 * 对应契约: contracts/workflow.ts — SeparationCheckResultSchema
 */
import {
  INCOMPATIBLE_ROLES,
  type AgentInstance,
  type AgentRole,
  type ScopeLevel,
  type SeparationCheckResult,
} from '../contracts/workflow.js';

export interface SeparationScope {
  readonly type: ScopeLevel;
  readonly id: string;
}

/**
 * 判断 (priorRole, currentRole) 在 scopeLevel 下是否不相容。
 * 矩阵是有序对，但分离约束是双向的：任一方向都构成冲突。
 */
function isIncompatiblePair(
  priorRole: AgentRole,
  currentRole: AgentRole,
  scopeLevel: ScopeLevel,
): boolean {
  for (const [a, b, level] of INCOMPATIBLE_ROLES) {
    if (level !== scopeLevel) continue;
    if (
      (a === priorRole && b === currentRole) ||
      (a === currentRole && b === priorRole)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 强制职责分离检查。
 *
 * 遍历同一 scope 下的所有前置 agent 实例，检查当前实例的角色是否与任一前置角色不相容。
 * - 不相容 + 同 actorId/sessionId → 拒绝（伪造多智能体）
 * - 不相容 + STRICT + 同 provider → 拒绝（同模型自审）
 * - 不相容 + 不同 actor/session + (RELAXED 或 不同 provider) → 允许
 * - 不在矩阵中 → 允许（无分离要求）
 */
export function enforceSeparation(
  priorInstances: readonly AgentInstance[],
  currentInstance: AgentInstance,
  scope: SeparationScope,
): SeparationCheckResult {
  for (const prior of priorInstances) {
    if (!isIncompatiblePair(prior.profile.role, currentInstance.profile.role, scope.type)) {
      continue;
    }

    const sameActor = prior.actorId === currentInstance.actorId;
    const sameSession = prior.sessionId === currentInstance.sessionId;

    // 相同 actorId 或 sessionId = 实质同一 agent，拒绝
    if (sameActor || sameSession) {
      return {
        allowed: false,
        reason:
          `actor ${currentInstance.actorId} already held role ${prior.profile.role} ` +
          `in scope ${scope.type}:${scope.id}; cannot assume ${currentInstance.profile.role}`,
        conflictingActorId: prior.actorId,
        conflictingRole: prior.profile.role,
      };
    }

    // STRICT 级别还要求 provider 不同（防止同模型自审/自批）
    const requiresStrict =
      prior.profile.independenceLevel === 'STRICT' ||
      currentInstance.profile.independenceLevel === 'STRICT';
    if (requiresStrict && prior.provider === currentInstance.provider) {
      return {
        allowed: false,
        reason:
          `STRICT independence requires different provider: ` +
          `role ${prior.profile.role} (${prior.provider}) and ` +
          `${currentInstance.profile.role} (${currentInstance.provider}) share provider`,
        conflictingActorId: prior.actorId,
        conflictingRole: prior.profile.role,
      };
    }
  }

  return { allowed: true };
}
