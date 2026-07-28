/**
 * Policy Registry (Phase 6 / C04 / WP-AOS-06)
 *
 * 设计文档：`docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 11 章
 *
 * 职责：
 * - 注册 Policy（仅天枢 core/project/task_profile/evolve_candidate 来源）
 * - 查询 ACTIVE Policy（按 scope、priority）
 * - ACTIVE 状态保持单活（同一 policyId 仅一个 ACTIVE 版本）
 * - 拒绝注册 GUNDAM/Value/win/Mr.Mont/annie/subtitle 等外部业务项目 Policy
 *
 * 不变量：
 * - Registry 是 in-memory（Mode 0，不持久化）
 * - 同一 policyId 多次注册：新版本必须 >旧版本，且 ACTIVE 时旧版本自动 RETIRED
 * - QUARANTINED Policy 不被查询返回
 */

import type {
  Policy,
  PolicyScope,
  PolicyStatus,
  PolicyTaskProfile,
  PolicyExecutionLevel,
  PolicyType,
} from '../contracts/policy.js';
import { stableHash } from '../contracts/canonical-json.js';
import type { JsonValue } from '../contracts/json-value.js';
import { FORBIDDEN_POLICY_ID_PREFIXES } from './resolver.js';

/** Registry 错误 */
export class PolicyRegistryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PolicyRegistryError';
  }
}

/** Registry 项（Policy + 注册时间 + 内容 Hash） */
interface RegistryEntry {
  policy: Policy;
  registeredAt: string;
  contentHash: string;
}

/** 允许的 Policy 来源 */
const ALLOWED_SOURCES = ['core', 'project', 'task_profile', 'evolve_candidate'];

/**
 * Policy Registry（in-memory）
 *
 * Mode 0：不持久化，进程重启后丢失。
 * 持久化由后续 Bundle Store 提供（bundle-store.ts）。
 */
export class PolicyRegistry {
  private readonly policies = new Map<string, RegistryEntry>();
  /** policyId → ACTIVE 版本号 */
  private readonly activeVersions = new Map<string, string>();

  /**
   * 注册 Policy
   *
   * @param contentHash 可选内容 Hash；未提供时由 Registry 基于 Policy 内容计算
   * @throws PolicyRegistryError 如果来源不允许、policyId 命中禁用前缀、版本冲突
   */
  register(policy: Policy, registeredAt: string, contentHash?: string): void {
    // 校验来源
    if (!ALLOWED_SOURCES.includes(policy.source)) {
      throw new PolicyRegistryError(
        `source not allowed: ${policy.source}`,
        'SOURCE_NOT_ALLOWED',
      );
    }

    // 校验 policyId 前缀
    const lowerId = policy.policyId.toLowerCase();
    for (const forbidden of FORBIDDEN_POLICY_ID_PREFIXES) {
      if (lowerId.startsWith(forbidden)) {
        throw new PolicyRegistryError(
          `policyId forbidden (external business project): ${policy.policyId}`,
          'FORBIDDEN_POLICY_ID',
        );
      }
    }

    // 校验版本冲突
    const existing = this.policies.get(policy.policyId);
    if (existing && existing.policy.version === policy.version) {
      throw new PolicyRegistryError(
        `policyId ${policy.policyId} version ${policy.version} already registered`,
        'VERSION_CONFLICT',
      );
    }

    // ACTIVE 状态保持单活
    if (policy.status === 'ACTIVE') {
      this.activeVersions.set(policy.policyId, policy.version);
    }

    const hash = contentHash ?? stableHash(policy.schema, policy as unknown as JsonValue);
    this.policies.set(policy.policyId, {
      policy,
      registeredAt,
      contentHash: hash,
    });
  }

  /** 注销 Policy */
  unregister(policyId: string): boolean {
    this.activeVersions.delete(policyId);
    return this.policies.delete(policyId);
  }

  /** 查询 ACTIVE Policy（按 scope） */
  queryActive(scope: {
    taskProfile: PolicyTaskProfile;
    level: PolicyExecutionLevel;
    type?: PolicyType;
  }): Policy[] {
    const results: Policy[] = [];
    for (const entry of this.policies.values()) {
      const policy = entry.policy;
      if (policy.status !== 'ACTIVE') continue;
      if (this.activeVersions.get(policy.policyId) !== policy.version) continue;
      if (!this.matchesScope(policy.scope, scope)) continue;
      if (scope.type && policy.type !== scope.type) continue;
      results.push(policy);
    }
    // 按 priority 降序（高优先级在前）
    return results.sort((a, b) => b.priority - a.priority);
  }

  /** 按 policyId 获取 ACTIVE Policy */
  getActive(policyId: string): Policy | undefined {
    const entry = this.policies.get(policyId);
    if (!entry) return undefined;
    if (entry.policy.status !== 'ACTIVE') return undefined;
    if (this.activeVersions.get(policyId) !== entry.policy.version) return undefined;
    return entry.policy;
  }

  /** 列出所有 Policy（含非 ACTIVE，用于审计） */
  listAll(): readonly Policy[] {
    return Array.from(this.policies.values()).map((e) => e.policy);
  }

  /** 更新 Policy 状态（仅允许 DRAFT→VALIDATING→APPROVED→ACTIVE 路径） */
  transitionStatus(policyId: string, newStatus: PolicyStatus): void {
    const entry = this.policies.get(policyId);
    if (!entry) {
      throw new PolicyRegistryError(`policyId not found: ${policyId}`, 'NOT_FOUND');
    }
    const currentStatus: PolicyStatus = entry.policy.status;
    const wasActive: boolean = currentStatus === 'ACTIVE';
    const allowedTransitions: Record<PolicyStatus, PolicyStatus[]> = {
      DRAFT: ['VALIDATING', 'RETIRED'],
      VALIDATING: ['APPROVED', 'QUARANTINED', 'DRAFT'],
      APPROVED: ['ACTIVE', 'QUARANTINED'],
      ACTIVE: ['QUARANTINED', 'RETIRED'],
      QUARANTINED: ['RETIRED', 'VALIDATING'],
      RETIRED: [],
    };
    const allowed = allowedTransitions[currentStatus];
    if (!allowed.includes(newStatus)) {
      throw new PolicyRegistryError(
        `status transition not allowed: ${currentStatus} → ${newStatus}`,
        'INVALID_TRANSITION',
      );
    }
    if (newStatus === 'ACTIVE') {
      this.activeVersions.set(policyId, entry.policy.version);
    } else if (wasActive) {
      this.activeVersions.delete(policyId);
    }
    entry.policy = { ...entry.policy, status: newStatus };
  }

  /** Registry 大小 */
  size(): number {
    return this.policies.size;
  }

  /** ACTIVE Policy 数量 */
  activeCount(): number {
    return this.activeVersions.size;
  }

  /** 检查 scope 是否匹配 */
  private matchesScope(
    policyScope: PolicyScope,
    query: { taskProfile: PolicyTaskProfile; level: PolicyExecutionLevel },
  ): boolean {
    const profileMatch = policyScope.taskProfiles.includes('all')
      || policyScope.taskProfiles.includes(query.taskProfile);
    const levelMatch = policyScope.levels.includes('all')
      || policyScope.levels.includes(query.level);
    return profileMatch && levelMatch;
  }

  /**
   * Quarantine ACTIVE Policy (设计文档第 14 节: ACTIVE → QUARANTINED).
   *
   * Quarantine 后新 Run 不再使用该版本.
   */
  quarantine(policyId: string, reason: string): void {
    void reason; // reason 仅用于审计日志，Mode 0 不持久化
    this.transitionStatus(policyId, 'QUARANTINED');
  }

  /**
   * 获取 Policy 的内容 Hash (用于 Bundle sourceVersions).
   */
  getContentHash(policyId: string): string | undefined {
    return this.policies.get(policyId)?.contentHash;
  }

  /**
   * 快照当前 ACTIVE Policy (用于 Bundle 冻结).
   *
   * 返回的是 Policy 的引用副本, 后续 Registry 更新不影响已返回的快照.
   */
  snapshotActive(): readonly Policy[] {
    const results: Policy[] = [];
    for (const [policyId, version] of this.activeVersions) {
      const entry = this.policies.get(policyId);
      if (entry && entry.policy.version === version) {
        results.push(entry.policy);
      }
    }
    return results;
  }

  /**
   * 列出指定 policyId 的所有版本（按 version 升序）.
   *
   * 注意：clean 基线中同一 policyId 仅保留最新注册的版本（覆盖语义）.
   * 如需多版本共存，请使用 register 时传入不同 policyId 或扩展 Registry.
   */
  listVersions(policyId: string): readonly Policy[] {
    const entry = this.policies.get(policyId);
    return entry ? [entry.policy] : [];
  }

  /** 清空 Registry (主要用于测试) */
  clear(): void {
    this.policies.clear();
    this.activeVersions.clear();
  }
}

// ===========================================================================
// Section: Status Transition Helpers (导出供外部使用)
// ===========================================================================

/** 允许的状态转换映射（设计文档第 14 章） */
export const POLICY_STATUS_TRANSITIONS: Readonly<Record<PolicyStatus, readonly PolicyStatus[]>> = {
  DRAFT: ['VALIDATING', 'RETIRED'],
  VALIDATING: ['APPROVED', 'QUARANTINED', 'DRAFT'],
  APPROVED: ['ACTIVE', 'QUARANTINED'],
  ACTIVE: ['QUARANTINED', 'RETIRED'],
  QUARANTINED: ['RETIRED', 'VALIDATING'],
  RETIRED: [],
};

/** 检查状态转换是否允许 */
export function isStatusTransitionAllowed(from: PolicyStatus, to: PolicyStatus): boolean {
  return POLICY_STATUS_TRANSITIONS[from].includes(to);
}
