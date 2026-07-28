/**
 * Policy Bundle Store (Phase 6 / C04 / WP-AOS-06)
 *
 * 设计文档：`docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 10 章
 *
 * 职责：
 * - 存储 CompiledPolicyBundle（运行中 Run 不能被 Registry 更新影响）
 * - 按 executionId / bundleId 查询 Bundle
 * - 记录 Bundle 历史（用于审计与重放）
 *
 * Mode 0：in-memory，不持久化
 * Mode 0+：可后续扩展为 SQLite Bundle Store（持久化）
 */

import type { CompiledPolicyBundle } from '../contracts/policy.js';

/** Bundle Store 错误 */
export class PolicyBundleStoreError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PolicyBundleStoreError';
  }
}

/** Bundle Store 项（Bundle + 存储时间） */
interface StoreEntry {
  bundle: CompiledPolicyBundle;
  storedAt: string;
}

/**
 * Policy Bundle Store（in-memory）
 *
 * 不变量：
 * - 同一 bundleId 只能存储一次（immutable）
 * - 同一 executionId 可能有多个 Bundle（如重试场景）
 * - 运行中 Registry 更新不能影响已存储的 Bundle
 */
export class PolicyBundleStore {
  private readonly byBundleId = new Map<string, StoreEntry>();
  private readonly byExecutionId = new Map<string, Set<string>>();

  /** 存储 Bundle（不可变） */
  store(bundle: CompiledPolicyBundle, storedAt: string): void {
    if (this.byBundleId.has(bundle.bundleId)) {
      throw new PolicyBundleStoreError(
        `bundleId already exists: ${bundle.bundleId}`,
        'BUNDLE_ID_EXISTS',
      );
    }
    this.byBundleId.set(bundle.bundleId, { bundle, storedAt });
    const bundleIds = this.byExecutionId.get(bundle.executionId) ?? new Set<string>();
    bundleIds.add(bundle.bundleId);
    this.byExecutionId.set(bundle.executionId, bundleIds);
  }

  /** 按 bundleId 查询 */
  getByBundleId(bundleId: string): CompiledPolicyBundle | undefined {
    return this.byBundleId.get(bundleId)?.bundle;
  }

  /** 按 executionId 查询所有 Bundle */
  getByExecutionId(executionId: string): readonly CompiledPolicyBundle[] {
    const bundleIds = this.byExecutionId.get(executionId);
    if (!bundleIds) return [];
    return [...bundleIds]
      .map((id) => this.byBundleId.get(id)!)
      .sort((a, b) => a.storedAt.localeCompare(b.storedAt))
      .map((entry) => entry.bundle);
  }

  /** 获取最新 Bundle（按 executionId） */
  getLatestByExecutionId(executionId: string): CompiledPolicyBundle | undefined {
    const bundles = this.getByExecutionId(executionId);
    return bundles[bundles.length - 1];
  }

  /** Store 大小 */
  size(): number {
    return this.byBundleId.size;
  }

  /** 清空 Store */
  clear(): void {
    this.byBundleId.clear();
    this.byExecutionId.clear();
  }

  /** 校验 Bundle 完整性（hash 一致） */
  verifyIntegrity(bundleId: string, expectedHash: string): boolean {
    const bundle = this.getByBundleId(bundleId);
    if (!bundle) return false;
    return bundle.bundleHash === expectedHash;
  }
}
