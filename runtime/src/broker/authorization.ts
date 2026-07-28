/**
 * Authorization Token Store (Phase 6 / C05 / WP-AOS-08)
 *
 * 设计文档: `docs/agent-os-3.0/06-Tool-Model-Broker.md` 第 6 节
 *
 * 规则:
 * - Token 绑定执行、工具、供应商和资源
 * - 不能跨用户、跨项目、跨目标复用
 * - 参数变化超出范围时重新授权
 * - 使用后更新次数和状态
 * - 用户撤销立即生效
 * - 环境变量长期授权逐步降级为开发兼容模式
 *
 * 状态机:
 *   ACTIVE → CONSUMED (usedCount === maxExecutions)
 *   ACTIVE → REVOKED  (用户撤销)
 *   ACTIVE → EXPIRED  (过期)
 */

import { createHash } from 'node:crypto';
import { type ActorRef } from '../contracts/actors.js';
import {
  type AuthorizationRequirement,
  type AuthorizationState,
  type AuthorizationToken,
  type ResourceScope,
} from '../contracts/broker.js';
import { createAwknId } from '../contracts/ids.js';

/** Authorization Store 错误 */
export class AuthorizationStoreError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'AuthorizationStoreError';
  }
}

/** Token 状态转换允许性 */
const ALLOWED_TRANSITIONS: Record<AuthorizationState, AuthorizationState[]> = {
  ACTIVE: ['CONSUMED', 'REVOKED', 'EXPIRED'],
  CONSUMED: [],
  REVOKED: [],
  EXPIRED: [],
};

function isStateTransitionAllowed(from: AuthorizationState, to: AuthorizationState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * 计算 Token 哈希 (排除 tokenHash / state / usedCount / revokedAt 以保证幂等)
 */
export function computeTokenHash(token: Omit<AuthorizationToken, 'tokenHash'>): string {
  // 使用稳定字段计算哈希: authorizationId + executionId + toolId + actor + maxExecutions + expiresAt
  const hash = createHash('sha256');
  hash.update(token.authorizationId);
  hash.update('|');
  hash.update(token.executionId);
  hash.update('|');
  hash.update(token.toolId);
  hash.update('|');
  hash.update(token.actor.actorId);
  hash.update('|');
  hash.update(token.actor.actorType);
  hash.update('|');
  hash.update(String(token.maxExecutions));
  hash.update('|');
  hash.update(token.expiresAt);
  return hash.digest('hex');
}

export interface IssueTokenInput {
  actor: ActorRef;
  executionId: string;
  requirement: AuthorizationRequirement;
  expiresAt: string;
  confirmationSourceRef: string;
  issuedAt: string;
}

/**
 * Authorization Token Store (in-memory)
 *
 * Mode 0: 不持久化, 进程内一致
 */
export class AuthorizationStore {
  private readonly tokens = new Map<string, AuthorizationToken>();

  /**
   * 签发 Authorization Token
   *
   * fail-closed:
   * - requirement.toolId 必须存在
   * - maxExecutions 必须 > 0
   * - expiresAt 必须 > issuedAt
   */
  issue(input: IssueTokenInput): AuthorizationToken {
    if (input.requirement.maxExecutions <= 0) {
      throw new AuthorizationStoreError(
        'maxExecutions must be positive',
        'INVALID_REQUIREMENT',
      );
    }
    if (input.expiresAt <= input.issuedAt) {
      throw new AuthorizationStoreError(
        'expiresAt must be after issuedAt',
        'INVALID_EXPIRY',
      );
    }

    const authorizationId = createAwknId('authorization');
    const tokenWithoutHash: Omit<AuthorizationToken, 'tokenHash'> = {
      schema: 'awkn-authorization-token/v1',
      authorizationId,
      actor: input.actor,
      executionId: input.executionId,
      toolId: input.requirement.toolId,
      providerId: input.requirement.providerId,
      allowedActions: input.requirement.requiredActions,
      resourceScopes: input.requirement.resourceScopes,
      dataScopes: input.requirement.dataScopes,
      maxExecutions: input.requirement.maxExecutions,
      usedCount: 0,
      expiresAt: input.expiresAt,
      confirmationSourceRef: input.confirmationSourceRef,
      state: 'ACTIVE',
      issuedAt: input.issuedAt,
    };
    const tokenHash = computeTokenHash(tokenWithoutHash);
    const token: AuthorizationToken = { ...tokenWithoutHash, tokenHash };
    this.tokens.set(authorizationId, token);
    return token;
  }

  /**
   * 消费 Token (执行工具时调用)
   *
   * fail-closed:
   * - Token 必须存在
   * - Token 必须为 ACTIVE
   * - toolId 必须匹配
   * - actor 必须匹配 (不可跨用户)
   * - executionId 必须匹配 (不可跨执行)
   * - resourceScopes 必须覆盖请求资源
   * - 未过期
   */
  consume(
    authorizationId: string,
    input: {
      actor: ActorRef;
      executionId: string;
      toolId: string;
      requestedResources: readonly ResourceScope[];
      requestedActions: readonly string[];
      consumedAt: string;
    },
  ): AuthorizationToken {
    const token = this.tokens.get(authorizationId);
    if (!token) {
      throw new AuthorizationStoreError(
        `authorization not found: ${authorizationId}`,
        'NOT_FOUND',
      );
    }

    // 跨用户/项目/目标复用检查
    if (token.actor.actorId !== input.actor.actorId) {
      throw new AuthorizationStoreError(
        `token actor mismatch: token=${token.actor.actorId}, request=${input.actor.actorId}`,
        'ACTOR_MISMATCH',
      );
    }
    if (token.executionId !== input.executionId) {
      throw new AuthorizationStoreError(
        `token executionId mismatch: token=${token.executionId}, request=${input.executionId}`,
        'EXECUTION_MISMATCH',
      );
    }
    if (token.toolId !== input.toolId) {
      throw new AuthorizationStoreError(
        `token toolId mismatch: token=${token.toolId}, request=${input.toolId}`,
        'TOOL_MISMATCH',
      );
    }

    // 状态检查
    if (token.state !== 'ACTIVE') {
      throw new AuthorizationStoreError(
        `token not active: state=${token.state}`,
        'INVALID_STATE',
      );
    }

    // 过期检查
    if (input.consumedAt >= token.expiresAt) {
      const expired: AuthorizationToken = { ...token, state: 'EXPIRED' };
      this.tokens.set(authorizationId, expired);
      throw new AuthorizationStoreError(
        `token expired at ${token.expiresAt}`,
        'EXPIRED',
      );
    }

    // 资源范围检查
    for (const requested of input.requestedResources) {
      const covered = token.resourceScopes.some(
        (scope) =>
          scope.resourceType === requested.resourceType &&
          scope.resourceId === requested.resourceId,
      );
      if (!covered) {
        throw new AuthorizationStoreError(
          `resource not covered by authorization: ${requested.resourceType}:${requested.resourceId}`,
          'SCOPE_EXCEEDED',
        );
      }
    }

    // 动作检查
    for (const action of input.requestedActions) {
      if (!token.allowedActions.includes(action)) {
        throw new AuthorizationStoreError(
          `action not allowed: ${action}`,
          'ACTION_NOT_ALLOWED',
        );
      }
    }

    // 使用次数检查
    const newUsedCount = token.usedCount + 1;
    const newState: AuthorizationState = newUsedCount >= token.maxExecutions ? 'CONSUMED' : 'ACTIVE';
    const updated: AuthorizationToken = {
      ...token,
      usedCount: newUsedCount,
      state: newState,
    };
    this.tokens.set(authorizationId, updated);
    return updated;
  }

  /**
   * 撤销 Token (用户撤销, 立即生效)
   */
  revoke(authorizationId: string, revokedAt: string): AuthorizationToken {
    const token = this.tokens.get(authorizationId);
    if (!token) {
      throw new AuthorizationStoreError(
        `authorization not found: ${authorizationId}`,
        'NOT_FOUND',
      );
    }
    if (!isStateTransitionAllowed(token.state, 'REVOKED')) {
      throw new AuthorizationStoreError(
        `cannot revoke token in state ${token.state}`,
        'INVALID_TRANSITION',
      );
    }
    const revoked: AuthorizationToken = {
      ...token,
      state: 'REVOKED',
      revokedAt,
    };
    this.tokens.set(authorizationId, revoked);
    return revoked;
  }

  /**
   * 检查参数变化是否超出授权范围
   */
  isParameterScopeExceeded(
    authorizationId: string,
    requestedResources: readonly ResourceScope[],
  ): boolean {
    const token = this.tokens.get(authorizationId);
    if (!token) return true; // fail-closed: 不存在视为超出
    for (const requested of requestedResources) {
      const covered = token.resourceScopes.some(
        (scope) =>
          scope.resourceType === requested.resourceType &&
          scope.resourceId === requested.resourceId,
      );
      if (!covered) return true;
    }
    return false;
  }

  /**
   * 查询 Token (不修改状态)
   */
  get(authorizationId: string): AuthorizationToken | undefined {
    return this.tokens.get(authorizationId);
  }

  /**
   * 标记过期 (定期调用)
   */
  expireStale(now: string): number {
    let count = 0;
    for (const [id, token] of this.tokens) {
      if (token.state === 'ACTIVE' && now >= token.expiresAt) {
        this.tokens.set(id, { ...token, state: 'EXPIRED' });
        count += 1;
      }
    }
    return count;
  }

  /** Token 总数 */
  size(): number {
    return this.tokens.size;
  }

  /** 按状态查询 */
  listByState(state: AuthorizationState): readonly AuthorizationToken[] {
    return Array.from(this.tokens.values()).filter((t) => t.state === state);
  }
}
