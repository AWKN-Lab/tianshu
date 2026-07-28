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

/** Registry 错误 */
export class PolicyRegistryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PolicyRegistryError';
  }
}

/** Registry 项（Policy + 注册时间） */
interface RegistryEntry {
  policy: Policy;
  registeredAt: string;
}

/** 禁止注册的业务项目 Policy 前缀（设计文档第 11.2 章） */
const FORBIDDEN_POLICY_PREFIXES = [
  'gundam.',
  'value.',
  'win.',
  'mr.mont.',
  'annie.',
  'subtitle.',
  'coze.',
  'project.annie',
];

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
   * @throws PolicyRegistryError 如果来源不允许、policyId 命中禁用前缀、版本冲突
   */
  register(policy: Policy, registeredAt: string): void {
    // 校验来源
    if (!ALLOWED_SOURCES.includes(policy.source)) {
      throw new PolicyRegistryError(
        `source not allowed: ${policy.source}`,
        'SOURCE_NOT_ALLOWED',
      );
    }

    // 校验 policyId 前缀
    const lowerId = policy.policyId.toLowerCase();
    for (const forbidden of FORBIDDEN_POLICY_PREFIXES) {
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

    this.policies.set(policy.policyId, {
      policy,
      registeredAt,
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
}
