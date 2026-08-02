/**
 * Separation Policy v2 — 20 不相容对 + 10 步判定
 *
 * 工程文档 7.2 节。基于 INCOMPATIBLE_PAIRS_V2 双向检查。
 * 纯策略函数：不访问 DB，仅依据 params 判定。
 *
 * 与 v1 separation-matrix 的区别：
 *   - 使用 INCOMPATIBLE_PAIRS_V2（20 对，无 scope level）
 *   - 10 步判定覆盖 profile 状态、specialty、授权继承、actor/session 分离、
 *     provider 多样性、工具权限、工作区策略、frozen target、lease/budget/concurrency。
 *
 * 对应契约: contracts/workflow-v2.ts — INCOMPATIBLE_PAIRS_V2
 */
import {
  INCOMPATIBLE_PAIRS_V2,
  WorkflowStageTypeSchema,
  type AgentInstanceV2,
  type AgentProfileV2,
} from '../contracts/workflow-v2.js';
import type { AgentRole } from '../contracts/workflow.js';

// ─── 公共类型 ─────────────────────────────────────────────

export interface SeparationCheckParams {
  readonly currentProfile: AgentProfileV2;
  readonly currentInstance: AgentInstanceV2;
  readonly priorInstances: readonly AgentInstanceV2[];
  readonly priorProfiles: readonly AgentProfileV2[];
  readonly authorizationEnvelopeId: string;
  readonly parentAuthorizationEnvelopeId?: string;
  readonly workspacePolicy: 'read_only' | 'read_write';
  readonly frozenInputHash: string;
  readonly stageFrozenHash: string;
  readonly availableBudget: number;
  readonly availableConcurrency: number;
}

export interface SeparationResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly step?: number;
  readonly conflictingActorId?: string;
  readonly conflictingRole?: AgentRole;
}

// ─── 常量 ─────────────────────────────────────────────────

const ACTIVE_PROFILE_STATUSES = new Set<AgentProfileV2['status']>(['ACTIVE', 'CANARY']);

/** 写入型角色：在 read_only 工作区中不应承载（会变更代码/制品/部署目标）。 */
const WRITE_CAPABLE_ROLES = new Set<AgentRole>([
  'Engineer',
  'Git',
  'Release',
  'Deploy',
  'Recovery',
]);

// ─── 辅助 ─────────────────────────────────────────────────

/**
 * 判断 (roleA, roleB) 是否为不相容对（双向）。
 * INCOMPATIBLE_PAIRS_V2 是有序对，但分离约束双向生效：A↔B 和 B↔A 都拦截。
 */
export function isIncompatiblePairV2(roleA: AgentRole, roleB: AgentRole): boolean {
  for (const [a, b] of INCOMPATIBLE_PAIRS_V2) {
    if ((a === roleA && b === roleB) || (a === roleB && b === roleA)) {
      return true;
    }
  }
  return false;
}

function deny(
  step: number,
  reason: string,
  conflictingActorId?: string,
  conflictingRole?: AgentRole,
): SeparationResult {
  return {
    allowed: false,
    reason,
    step,
    ...(conflictingActorId !== undefined ? { conflictingActorId } : {}),
    ...(conflictingRole !== undefined ? { conflictingRole } : {}),
  };
}

// ─── 主入口 ───────────────────────────────────────────────

/**
 * 强制 Separation Policy v2 — 10 步判定。
 *
 * 全部通过返回 { allowed: true }；任一步骤失败立即返回
 * { allowed: false, reason, step, conflictingActorId?, conflictingRole? }。
 */
export function enforceSeparationV2(params: SeparationCheckParams): SeparationResult {
  const { currentProfile, currentInstance } = params;

  // 1. Profile 必须是 ACTIVE 或 CANARY（不可为 DRAFT/SHADOW/QUARANTINED/RETIRED）
  if (!ACTIVE_PROFILE_STATUSES.has(currentProfile.status)) {
    return deny(
      1,
      `profile ${currentProfile.profileId} status is ${currentProfile.status}, must be ACTIVE or CANARY`,
    );
  }

  // 2. Stage specialty 与 profile specialty 一致（specialty 必须是合法 WorkflowStageType）
  //    完整的 stage-vs-profile specialty 匹配由调用方在分配 profile 到 stage 时保证；
  //    此处做完整性校验，防止伪造/漂移的 profile 进入分离判定。
  const specialtyParse = WorkflowStageTypeSchema.safeParse(currentProfile.specialty);
  if (!specialtyParse.success) {
    return deny(
      2,
      `profile ${currentProfile.profileId} specialty ${currentProfile.specialty} is not a valid WorkflowStageType`,
    );
  }

  // 3. 授权可继承且未扩张：若存在 parent，parent 必须非空且与当前 envelope 不同
  //    （当前为子集，非父级扩张）。完整子集校验需加载 envelope 内容，由 governor 保证。
  if (params.parentAuthorizationEnvelopeId !== undefined) {
    if (params.parentAuthorizationEnvelopeId.length === 0) {
      return deny(
        3,
        'parentAuthorizationEnvelopeId is provided but empty; parent envelope must exist',
      );
    }
    if (params.parentAuthorizationEnvelopeId === params.authorizationEnvelopeId) {
      return deny(
        3,
        `authorization envelope ${params.authorizationEnvelopeId} equals parent; ` +
          'current envelope must be a subset (not an expansion of the parent)',
      );
    }
  }

  // 4. actor 不可与不相容 stage 共享（INCOMPATIBLE_PAIRS_V2 双向 + actor/session 共享判定）
  const pairCount = Math.min(params.priorInstances.length, params.priorProfiles.length);
  for (let i = 0; i < pairCount; i++) {
    const priorInstance = params.priorInstances[i]!;
    const priorProfile = params.priorProfiles[i]!;
    if (!isIncompatiblePairV2(priorProfile.role, currentProfile.role)) {
      continue;
    }
    const sameActor = priorInstance.actorId === currentInstance.actorId;
    const sameSession = priorInstance.sessionId === currentInstance.sessionId;
    if (sameActor || sameSession) {
      return deny(
        4,
        `actor ${currentInstance.actorId} cannot assume role ${currentProfile.role} ` +
          `incompatible with prior role ${priorProfile.role} (actor ${priorInstance.actorId})`,
        priorInstance.actorId,
        priorProfile.role,
      );
    }
  }

  // 5. session 不可与任何前置实例共享（不论角色是否相容）
  for (let i = 0; i < params.priorInstances.length; i++) {
    const priorInstance = params.priorInstances[i]!;
    if (priorInstance.sessionId === currentInstance.sessionId) {
      return deny(
        5,
        `session ${currentInstance.sessionId} is shared with prior actor ${priorInstance.actorId}`,
        priorInstance.actorId,
        params.priorProfiles[i]?.role,
      );
    }
  }

  // 6. STRICT provider 必须与上游不同（providerPolicy 为 DIFFERENT_FROM_UPSTREAM 或 PINNED 时）
  if (
    currentProfile.providerPolicy === 'DIFFERENT_FROM_UPSTREAM' ||
    currentProfile.providerPolicy === 'PINNED'
  ) {
    for (let i = 0; i < params.priorInstances.length; i++) {
      const priorInstance = params.priorInstances[i]!;
      if (priorInstance.providerId === currentInstance.providerId) {
        return deny(
          6,
          `providerPolicy ${currentProfile.providerPolicy} requires different provider, ` +
            `but current provider ${currentInstance.providerId} matches prior actor ${priorInstance.actorId}`,
          priorInstance.actorId,
          params.priorProfiles[i]?.role,
        );
      }
    }
  }

  // 7. 工具权限必须是父级授权的严格子集
  //    纯策略函数无法加载父级 envelope 的工具范围；此处做结构校验：
  //    toolPolicyRef 与 permissionSnapshotHash 必须存在。完整子集校验由 governor
  //    在加载父级 envelope 后保证。
  if (currentProfile.toolPolicyRef.length === 0) {
    return deny(
      7,
      `profile ${currentProfile.profileId} has empty toolPolicyRef; cannot be a subset of parent authorization`,
    );
  }
  if (currentInstance.permissionSnapshotHash.length === 0) {
    return deny(
      7,
      `instance ${currentInstance.actorId} has empty permissionSnapshotHash; cannot verify tool permission subset`,
    );
  }

  // 8. 工作区策略必须匹配：read_only 工作区不可承载写入型角色
  if (params.workspacePolicy === 'read_only' && WRITE_CAPABLE_ROLES.has(currentProfile.role)) {
    return deny(
      8,
      `read_only workspace cannot host write-capable role ${currentProfile.role}`,
    );
  }

  // 9. Frozen target 必须与 stage input hash 一致
  if (params.frozenInputHash !== params.stageFrozenHash) {
    return deny(
      9,
      `frozen input hash ${params.frozenInputHash} does not match stage frozen hash ${params.stageFrozenHash}`,
    );
  }

  // 10. Lease、budget、concurrency 必须可用
  if (params.availableBudget <= 0) {
    return deny(10, `available budget ${params.availableBudget} must be positive`);
  }
  if (params.availableConcurrency <= 0) {
    return deny(10, `available concurrency ${params.availableConcurrency} must be positive`);
  }
  const leaseExpiry = new Date(currentInstance.leaseExpiresAt);
  if (leaseExpiry <= new Date()) {
    return deny(
      10,
      `actor lease expired at ${currentInstance.leaseExpiresAt}; cannot enforce separation`,
    );
  }

  return { allowed: true };
}
