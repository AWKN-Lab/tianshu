/**
 * PolicyRegistry (Phase 6 / C04 / WP-AOS-06)
 *
 * 设计文档: `docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 11 节 Registry 边界
 *
 * 职责:
 * - 注册 / 查询 / 版本管理天枢 Policy
 * - 强制 ACTIVE 单活 (同一 policyId 只能有一个 ACTIVE 版本)
 * - 来源校验: 只允许天枢 Core / Project / TaskProfile Policy
 * - 隔离业务仓库资产 (GUNDAM, value, hotel, mr-mont, annie, subtitle 等)
 * - Registry 更新不改变运行中 Bundle
 *
 * 设计原则:
 * - fail-closed: 多 ACTIVE 版本 / 来源非法 / 状态非法 → 抛错
 * - 版本冻结: 已编译 Bundle 不受 Registry 后续更新影响
 */

import type { Policy, PolicySource, PolicyStatus } from '../contracts/policy.js';
import { PolicySchema } from '../contracts/policy.js';

// ===========================================================================
// Section 1: Registry Errors
// ===========================================================================

export class PolicyRegistryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PolicyRegistryError';
  }
}

// ===========================================================================
// Section 2: Registry Storage
// ===========================================================================

interface PolicyRecord {
  policy: Policy;
  registeredAt: string;
  contentHash: string;
}

/**
 * Registry Key: policyId@version
 */
function recordKey(policyId: string, version: string): string {
  return `${policyId}@${version}`;
}

// ===========================================================================
// Section 3: Allowed Sources
// ===========================================================================

/**
 * 允许的 Policy 来源 (设计文档第 11.1 节)
 *
 * 允许注册:
 * - core: 天枢 Core Policy
 * - project: 天枢 Project Governance Policy
 * - taskProfile: 天枢 Task Profile Policy
 */
export const ALLOWED_POLICY_SOURCES: ReadonlySet<PolicySource> = new Set([
  'core',
  'project',
  'taskProfile',
]);

/**
 * 禁止的业务仓库 Policy 前缀 (设计文档第 11.2 节)
 *
 * 禁止注册:
 * - GUNDAM Policy
 * - Value 投资规则
 * - win 酒店规则
 * - Mr.Mont、annie、subtitle 等其他产品资产
 */
export const FORBIDDEN_POLICY_ID_PREFIXES: readonly string[] = [
  'gundam.',
  'value.',
  'win.',
  'hotel.',
  'mr-mont.',
  'annie.',
  'subtitle.',
];

// ===========================================================================
// Section 4: PolicyRegistry
// ===========================================================================

/**
 * Policy Registry (in-memory, 进程内一致)
 *
 * 设计文档第 10 节: 运行中 Registry 更新不能改变已启动 Run.
 * 实现: 通过 version snapshot 保证 — 已编译 Bundle 持有 Policy 引用,
 * Registry 后续更新不会影响这些引用.
 */
export class PolicyRegistry {
  private readonly records = new Map<string, PolicyRecord>();
  private readonly activeByPolicyId = new Map<string, string>(); // policyId → version

  /**
   * 注册 Policy.
   *
   * fail-closed:
   * - Schema 校验失败 → POLICY_SCHEMA_INVALID
   * - 来源非法 → SOURCE_FORBIDDEN
   * - policyId 前缀属于业务仓库 → SOURCE_FORBIDDEN
   * - 状态非法 → INVALID_STATUS
   * - 同 policyId 已有 ACTIVE 版本, 新 Policy 也是 ACTIVE → MULTI_ACTIVE_VERSION
   */
  register(policy: Policy, registeredAt: string, contentHash: string): Policy {
    // 1. Schema 校验
    const schemaResult = PolicySchema.safeParse(policy);
    if (!schemaResult.success) {
      throw new PolicyRegistryError(
        `policy schema invalid: ${schemaResult.error.message}`,
        'POLICY_SCHEMA_INVALID',
      );
    }

    // 2. 来源校验
    if (!ALLOWED_POLICY_SOURCES.has(policy.source)) {
      throw new PolicyRegistryError(
        `policy source '${policy.source}' not allowed (only core/project/taskProfile)`,
        'SOURCE_FORBIDDEN',
      );
    }

    // 3. policyId 前缀校验 (业务仓库资产)
    const lowerId = policy.policyId.toLowerCase();
    for (const forbidden of FORBIDDEN_POLICY_ID_PREFIXES) {
      if (lowerId.startsWith(forbidden)) {
        throw new PolicyRegistryError(
          `policyId '${policy.policyId}' belongs to forbidden business repo (prefix '${forbidden}')`,
          'SOURCE_FORBIDDEN',
        );
      }
    }

    // 4. ACTIVE 单活校验
    if (policy.status === 'ACTIVE') {
      const existingActiveVersion = this.activeByPolicyId.get(policy.policyId);
      if (existingActiveVersion !== undefined && existingActiveVersion !== policy.version) {
        throw new PolicyRegistryError(
          `policyId '${policy.policyId}' already has ACTIVE version ${existingActiveVersion}; ` +
          `cannot register another ACTIVE version ${policy.version} (multi-ACTIVE rejected)`,
          'MULTI_ACTIVE_VERSION',
        );
      }
    } else if (policy.status !== 'DRAFT' && policy.status !== 'VALIDATING' && policy.status !== 'APPROVED' && policy.status !== 'QUARANTINED' && policy.status !== 'RETIRED') {
      throw new PolicyRegistryError(
        `invalid policy status '${policy.status}'`,
        'INVALID_STATUS',
      );
    }

    // 5. 注册
    const key = recordKey(policy.policyId, policy.version);
    const record: PolicyRecord = { policy, registeredAt, contentHash };
    this.records.set(key, record);
    if (policy.status === 'ACTIVE') {
      this.activeByPolicyId.set(policy.policyId, policy.version);
    }

    return policy;
  }

  /**
   * 查询特定版本 Policy.
   */
  lookup(policyId: string, version: string): Policy | null {
    return this.records.get(recordKey(policyId, version))?.policy ?? null;
  }

  /**
   * 查询 ACTIVE 版本 Policy.
   */
  getActive(policyId: string): Policy | null {
    const version = this.activeByPolicyId.get(policyId);
    if (version === undefined) return null;
    return this.lookup(policyId, version);
  }

  /**
   * 列出所有 ACTIVE Policy.
   */
  listActive(): Policy[] {
    const result: Policy[] = [];
    for (const [policyId, version] of this.activeByPolicyId) {
      const policy = this.lookup(policyId, version);
      if (policy) result.push(policy);
    }
    return result;
  }

  /**
   * 列出所有版本 Policy (按 policyId 分组).
   */
  listAll(): Policy[] {
    return [...this.records.values()].map((r) => r.policy);
  }

  /**
   * 列出指定 policyId 的所有版本.
   */
  listVersions(policyId: string): Policy[] {
    return [...this.records.values()]
      .filter((r) => r.policy.policyId === policyId)
      .map((r) => r.policy)
      .sort((a, b) => a.version.localeCompare(b.version));
  }

  /**
   * 状态转换.
   *
   * 允许的转换 (设计文档第 14 节):
   *   DRAFT → VALIDATING → APPROVED → ACTIVE
   *   ACTIVE → QUARANTINED / RETIRED
   *   QUARANTINED → VALIDATING / RETIRED
   */
  transition(policyId: string, version: string, next: PolicyStatus): Policy {
    const policy = this.lookup(policyId, version);
    if (!policy) {
      throw new PolicyRegistryError(
        `policy ${policyId}@${version} not found`,
        'NOT_FOUND',
      );
    }
    if (!isStatusTransitionAllowed(policy.status, next)) {
      throw new PolicyRegistryError(
        `invalid status transition ${policy.status} → ${next} for ${policyId}@${version}`,
        'INVALID_TRANSITION',
      );
    }

    // ACTIVE 单活校验 (转 ACTIVE 时检查是否已有 ACTIVE)
    if (next === 'ACTIVE') {
      const existing = this.activeByPolicyId.get(policyId);
      if (existing !== undefined && existing !== version) {
        throw new PolicyRegistryError(
          `cannot activate ${policyId}@${version}: ACTIVE version ${existing} already exists`,
          'MULTI_ACTIVE_VERSION',
        );
      }
    }

    // 执行转换
    const updated: Policy = { ...policy, status: next };
    const record = this.records.get(recordKey(policyId, version))!;
    this.records.set(recordKey(policyId, version), { ...record, policy: updated });

    if (next === 'ACTIVE') {
      this.activeByPolicyId.set(policyId, version);
    } else if (policy.status === 'ACTIVE' && (next === 'QUARANTINED' || next === 'RETIRED')) {
      this.activeByPolicyId.delete(policyId);
    }

    return updated;
  }

  /**
   * Quarantine ACTIVE Policy (设计文档第 14 节: ACTIVE → QUARANTINED).
   *
   * Quarantine 后新 Run 不再使用该版本 (设计文档第 15 节 测试 10).
   */
  quarantine(policyId: string, version: string, _reason: string): Policy {
    return this.transition(policyId, version, 'QUARANTINED');
  }

  /**
   * 获取 Policy 的内容 Hash (用于 Bundle sourceVersions).
   */
  getContentHash(policyId: string, version: string): string | null {
    return this.records.get(recordKey(policyId, version))?.contentHash ?? null;
  }

  /**
   * 快照当前 ACTIVE Policy (用于 Bundle 冻结).
   *
   * 返回的是 Policy 的引用副本, 后续 Registry 更新不影响已返回的快照.
   */
  snapshotActive(): readonly Policy[] {
    return [...this.listActive()];
  }

  /**
   * 清空 Registry (主要用于测试).
   */
  clear(): void {
    this.records.clear();
    this.activeByPolicyId.clear();
  }
}

// ===========================================================================
// Section 5: Status Transitions
// ===========================================================================

const ALLOWED_TRANSITIONS: Record<PolicyStatus, PolicyStatus[]> = {
  DRAFT: ['VALIDATING', 'RETIRED'],
  VALIDATING: ['APPROVED', 'QUARANTINED', 'DRAFT'],
  APPROVED: ['ACTIVE', 'QUARANTINED', 'RETIRED'],
  ACTIVE: ['QUARANTINED', 'RETIRED'],
  QUARANTINED: ['VALIDATING', 'RETIRED'],
  RETIRED: [],
};

export function isStatusTransitionAllowed(from: PolicyStatus, to: PolicyStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ===========================================================================
// Section 6: Singleton Registry
// ===========================================================================

let defaultRegistry: PolicyRegistry | null = null;

export function getDefaultPolicyRegistry(): PolicyRegistry {
  if (!defaultRegistry) defaultRegistry = new PolicyRegistry();
  return defaultRegistry;
}

export function resetDefaultPolicyRegistry(): void {
  defaultRegistry = null;
}
