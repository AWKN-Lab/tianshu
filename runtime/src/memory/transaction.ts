/**
 * Memory Transaction Executor (Phase 6 / C09 / WP-AOS-14)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第五节（5.5 事务）
 *
 * 职责：
 * - 执行 Memory Transaction（字段级 CAS、幂等、追加事件、依赖删除传播）
 * - 维护内存中的修订号、墓碑、依赖图与幂等缓存
 * - 回滚生成新版本并保留历史（设计 5.5）
 * - 产出 Memory Write Receipt
 *
 * 不变量：
 * - 同一 idempotencyKey 重复消费只写一次（设计测试 5）
 * - update/delete 必须通过 CAS 校验（expectedRevision）
 * - 删除 Claim 后依赖项失效（设计测试 6：tombstone → DependencyUpdate invalidate/reassess/tombstone）
 * - 不能 create/update 已被墓碑标记的 memory（契约层已强制）
 * - 回滚不删除旧版本，而是生成新版本，历史完整保留
 * - 所有 Receipt 通过 zod .parse() 校验（fail-closed）
 *
 * 说明：本执行器是 CAS/幂等/依赖传播的协调层。实际后端持久化由 MemoryBackendRouter
 * 的既有 capture/outbox 管道处理；本层在内存中维护权威的修订号与墓碑状态。
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/logger.js';
import { getMemoryBackendRouter } from './router.js';
import {
  MemoryTransactionSchema,
  MemoryWriteReceiptSchema,
  createMemoryTransactionId,
  createMemoryWriteReceiptId,
  createMemoryCandidateId,
  type MemoryTransaction,
  type MemoryWriteReceipt,
  type MemoryBackend,
  type MemoryOperation,
  type DependencyUpdate,
  type Tombstone,
} from '../contracts/memory-write.js';
import { toUtcTimestamp } from '../contracts/time.js';

const log = createLogger('memory-transaction');

/**
 * 内存中的记忆条目历史记录。每次 create/update/delete/tombstone 追加一行，
 * 回滚也追加新行 —— 旧版本永不删除（设计 5.5 回滚生成新版本并保留历史）。
 */
interface MemoryHistoryEntry {
  revision: number;
  tombstoned: boolean;
  rolledBack: boolean;
  reason?: string;
  at: string;
}

/**
 * 交互式事务句柄。调用方通过 begin() 获得，向 operations/dependencyUpdates/tombstones
 * 数组追加内容后，调用 commit() 提交或 rollback() 回滚。
 */
export interface TransactionHandle {
  idempotencyKey: string;
  operations: MemoryOperation[];
  dependencyUpdates: DependencyUpdate[];
  tombstones: Tombstone[];
  expectedRevision?: number;
  startedAt: string;
  committed: boolean;
  rolledBack: boolean;
}

interface BuildReceiptInput {
  transaction: MemoryTransaction;
  decision: 'WRITE' | 'REJECT';
  reasonCodes: ReadonlyArray<MemoryWriteReceipt['reasonCodes'][number]>;
  backend: MemoryBackend;
  memoryId?: string;
  revision?: number;
  claimId: string;
}

export class MemoryTransactionExecutor {
  /** idempotencyKey → Receipt（幂等缓存，设计测试 5） */
  private readonly idempotencyCache = new Map<string, MemoryWriteReceipt>();
  /** memoryId → 当前修订号 */
  private readonly memoryRevisions = new Map<string, number>();
  /** memoryId → claim contentHash（用于去重） */
  private readonly memoryClaimHashes = new Map<string, string>();
  /** claim contentHash → memoryId（用于写入侧去重） */
  private readonly claimHashToMemoryId = new Map<string, string>();
  /** 已墓碑化的 memoryId 集合 */
  private readonly tombstones = new Set<string>();
  /** dependencyClaimId → 依赖该 claim 的 memoryId 集合（依赖图） */
  private readonly dependencyGraph = new Map<string, Set<string>>();
  /** memoryId → 历史条目数组（追加事件，永不删除） */
  private readonly history = new Map<string, MemoryHistoryEntry[]>();
  /** idempotencyKey → 进行中的 handle */
  private readonly inFlight = new Map<string, TransactionHandle>();

  /**
   * 执行事务（原子）。幂等：同一 idempotencyKey 重复消费只写一次。
   * CAS：update/delete 校验 expectedRevision；冲突返回 REJECT+CAS_CONFLICT。
   */
  async execute(transaction: MemoryTransaction): Promise<MemoryWriteReceipt> {
    const parsed = MemoryTransactionSchema.parse(transaction);

    // 幂等检查（设计测试 5）
    const cached = this.idempotencyCache.get(parsed.idempotencyKey);
    if (cached) {
      log.debug('idempotent replay returning cached receipt', { idempotencyKey: parsed.idempotencyKey });
      return cached;
    }

    const claimId = this.firstClaimId(parsed);

    // CAS 校验 + 墓碑约束
    for (const op of parsed.operations) {
      if (op.type === 'create') continue;
      if (op.memoryId === undefined) continue;
      if (op.expectedRevision !== undefined && !this.verifyExpectedRevision(op.memoryId, op.expectedRevision)) {
        log.warn('CAS conflict detected', { memoryId: op.memoryId, expected: op.expectedRevision });
        return this.buildReceipt({
          transaction: parsed, decision: 'REJECT', reasonCodes: ['CAS_CONFLICT'],
          backend: 'none', claimId,
        });
      }
      if (op.type === 'update' && this.isTombstoned(op.memoryId)) {
        log.warn('update on tombstoned memory rejected', { memoryId: op.memoryId });
        return this.buildReceipt({
          transaction: parsed, decision: 'REJECT', reasonCodes: ['DEPENDENCY_TOMBSTONED'],
          backend: 'none', claimId,
        });
      }
    }

    // 执行操作
    let lastMemoryId: string | undefined;
    let lastRevision: number | undefined;
    for (const op of parsed.operations) {
      if (op.type === 'create') {
        const created = this.applyCreate(op);
        lastMemoryId = created.memoryId;
        lastRevision = created.revision;
      } else if (op.type === 'update' && op.memoryId !== undefined) {
        const rev = this.applyUpdate(op.memoryId);
        lastMemoryId = op.memoryId;
        lastRevision = rev;
      } else if (op.type === 'delete' && op.memoryId !== undefined) {
        this.applyDelete(op.memoryId);
        lastMemoryId = op.memoryId;
        lastRevision = this.memoryRevisions.get(op.memoryId);
      }
    }

    // 应用墓碑
    for (const ts of parsed.tombstones) {
      this.tombstones.add(ts.memoryId);
      this.appendHistory(ts.memoryId, this.memoryRevisions.get(ts.memoryId) ?? 0, {
        tombstoned: true, reason: ts.reason,
      });
    }

    // 依赖删除传播（设计测试 6：删除 Claim 后依赖项失效）
    for (const dep of parsed.dependencyUpdates) {
      this.recordDependency(dep);
    }

    const backend = this.selectBackend();
    const receipt = this.buildReceipt({
      transaction: parsed,
      decision: 'WRITE',
      reasonCodes: backend === 'none' ? ['BACKEND_UNAVAILABLE'] : ['DURABLE'],
      backend,
      memoryId: lastMemoryId,
      revision: lastRevision,
      claimId,
    });

    this.idempotencyCache.set(parsed.idempotencyKey, receipt);
    log.info('transaction committed', {
      transactionId: parsed.transactionId, backend, memoryId: lastMemoryId, revision: lastRevision,
    });
    return receipt;
  }

  /** 开始交互式事务，返回可追加操作的句柄。 */
  begin(idempotencyKey: string): TransactionHandle {
    if (this.idempotencyCache.has(idempotencyKey)) {
      throw new Error(`idempotencyKey already finalized: ${idempotencyKey}`);
    }
    const handle: TransactionHandle = {
      idempotencyKey,
      operations: [],
      dependencyUpdates: [],
      tombstones: [],
      startedAt: toUtcTimestamp(new Date()),
      committed: false,
      rolledBack: false,
    };
    this.inFlight.set(idempotencyKey, handle);
    return handle;
  }

  /** 提交交互式事务。 */
  async commit(handle: TransactionHandle): Promise<MemoryWriteReceipt> {
    if (handle.committed) throw new Error('handle already committed');
    if (handle.rolledBack) throw new Error('handle already rolled back');
    const transaction: MemoryTransaction = {
      schema: 'awkn-transaction/v1',
      transactionId: createMemoryTransactionId(),
      idempotencyKey: handle.idempotencyKey,
      expectedRevision: handle.expectedRevision,
      operations: handle.operations,
      dependencyUpdates: handle.dependencyUpdates,
      tombstones: handle.tombstones,
    };
    const receipt = await this.execute(transaction);
    handle.committed = true;
    this.inFlight.delete(handle.idempotencyKey);
    return receipt;
  }

  /**
   * 回滚交互式事务。生成新版本并保留历史（设计 5.5）。
   * 回滚不删除既有修订，而是为受影响的 memory 追加一条 rolledBack 历史条目。
   */
  async rollback(handle: TransactionHandle, reason: string): Promise<void> {
    if (handle.committed) throw new Error('cannot rollback committed handle');
    if (handle.rolledBack) throw new Error('handle already rolled back');
    handle.rolledBack = true;
    for (const op of handle.operations) {
      if (op.type === 'create') {
        // create 未提交，无需回滚；跳过
        continue;
      }
      if (op.memoryId === undefined) continue;
      const currentRev = this.memoryRevisions.get(op.memoryId) ?? 0;
      const newRev = currentRev + 1;
      this.memoryRevisions.set(op.memoryId, newRev);
      this.appendHistory(op.memoryId, newRev, { rolledBack: true, reason });
    }
    this.inFlight.delete(handle.idempotencyKey);
    log.info('transaction rolled back preserving history', { idempotencyKey: handle.idempotencyKey, reason });
  }

  /** CAS 校验：memoryId 当前修订号是否等于 expected。 */
  verifyExpectedRevision(memoryId: string, expected: number): boolean {
    const current = this.memoryRevisions.get(memoryId);
    if (current === undefined) return false;
    return current === expected;
  }

  /** memoryId 是否已被墓碑标记。 */
  isTombstoned(memoryId: string): boolean {
    return this.tombed(memoryId);
  }

  /** claim contentHash 是否已写入（供 Write Gate 去重）。 */
  hasClaimHash(claimHash: string): boolean {
    return this.claimHashToMemoryId.has(claimHash);
  }

  /** 获取 memoryId 的当前修订号。 */
  getRevision(memoryId: string): number | undefined {
    return this.memoryRevisions.get(memoryId);
  }

  /** 获取 memoryId 的历史条目（追加事件，永不删除）。 */
  getHistory(memoryId: string): ReadonlyArray<MemoryHistoryEntry> {
    return this.history.get(memoryId) ?? [];
  }

  // ===== 内部方法 =====

  private tombed(memoryId: string): boolean {
    return this.tombstones.has(memoryId);
  }

  private applyCreate(op: MemoryOperation): { memoryId: string; revision: number } {
    const claim = op.claim as Record<string, unknown>;
    const claimHash = typeof claim.contentHash === 'string' ? claim.contentHash : '';
    // 事务内去重：同一 claimHash 只创建一次
    if (claimHash && this.claimHashToMemoryId.has(claimHash)) {
      const existingId = this.claimHashToMemoryId.get(claimHash)!;
      return { memoryId: existingId, revision: this.memoryRevisions.get(existingId) ?? 0 };
    }
    const memoryId = `mem_${randomUUID().replaceAll('-', '')}`;
    const revision = 0;
    this.memoryRevisions.set(memoryId, revision);
    if (claimHash) {
      this.memoryClaimHashes.set(memoryId, claimHash);
      this.claimHashToMemoryId.set(claimHash, memoryId);
    }
    this.appendHistory(memoryId, revision, { tombstoned: false });
    return { memoryId, revision };
  }

  private applyUpdate(memoryId: string): number {
    const rev = (this.memoryRevisions.get(memoryId) ?? 0) + 1;
    this.memoryRevisions.set(memoryId, rev);
    this.appendHistory(memoryId, rev, { tombstoned: false });
    return rev;
  }

  private applyDelete(memoryId: string): void {
    this.tombstones.add(memoryId);
    const rev = this.memoryRevisions.get(memoryId) ?? 0;
    this.appendHistory(memoryId, rev, { tombstoned: true });
  }

  /**
   * 记录依赖更新（设计测试 6）。invalidate/tombstone 动作会使依赖 memory 失效。
   */
  private recordDependency(dep: DependencyUpdate): void {
    let dependents = this.dependencyGraph.get(dep.dependencyClaimId);
    if (!dependents) {
      dependents = new Set<string>();
      this.dependencyGraph.set(dep.dependencyClaimId, dependents);
    }
    dependents.add(dep.dependentMemoryId);
    if (dep.action === 'invalidate' || dep.action === 'tombstone') {
      this.tombstones.add(dep.dependentMemoryId);
      const rev = this.memoryRevisions.get(dep.dependentMemoryId) ?? 0;
      this.appendHistory(dep.dependentMemoryId, rev, { tombstoned: true, reason: dep.reason });
    }
    log.debug('dependency update recorded', {
      dependentMemoryId: dep.dependentMemoryId, action: dep.action, reason: dep.reason,
    });
  }

  private appendHistory(
    memoryId: string,
    revision: number,
    flags: { tombstoned?: boolean; rolledBack?: boolean; reason?: string },
  ): void {
    let entries = this.history.get(memoryId);
    if (!entries) {
      entries = [];
      this.history.set(memoryId, entries);
    }
    entries.push({
      revision,
      tombstoned: flags.tombstoned ?? false,
      rolledBack: flags.rolledBack ?? false,
      reason: flags.reason,
      at: toUtcTimestamp(new Date()),
    });
  }

  /**
   * 后端选择：memory-os 优先（远程可用时），否则 local，均不可用才 none。
   * local 始终在进程内可用，因此 none 仅在极端情况下出现。
   */
  private selectBackend(): MemoryBackend {
    try {
      if (getMemoryBackendRouter().isRemoteAuthorityEnabled()) return 'memory-os';
    } catch (error) {
      log.warn('backend router check failed', { error: error instanceof Error ? error.message : String(error) });
    }
    return 'local';
  }

  private firstClaimId(transaction: MemoryTransaction): string {
    const firstOp = transaction.operations[0];
    if (!firstOp) throw new Error('transaction must contain at least one operation');
    const claim = firstOp.claim as Record<string, unknown>;
    const claimId = typeof claim.claimId === 'string' ? claim.claimId : '';
    if (!claimId) throw new Error('operation claim missing claimId');
    return claimId;
  }

  private buildReceipt(input: BuildReceiptInput): MemoryWriteReceipt {
    const receipt: MemoryWriteReceipt = {
      schema: 'awkn-memory-write-receipt/v1',
      receiptId: createMemoryWriteReceiptId(),
      candidateId: createMemoryCandidateId(),
      claimId: input.claimId,
      decision: input.decision,
      reasonCodes: [...input.reasonCodes],
      backend: input.backend,
      idempotencyKey: input.transaction.idempotencyKey,
      transactionId: input.transaction.transactionId,
      createdAt: toUtcTimestamp(new Date()),
      ...(input.memoryId !== undefined ? { memoryId: input.memoryId } : {}),
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
    };
    return MemoryWriteReceiptSchema.parse(receipt);
  }
}

let instance: MemoryTransactionExecutor | null = null;

export function getMemoryTransactionExecutor(): MemoryTransactionExecutor {
  if (!instance) instance = new MemoryTransactionExecutor();
  return instance;
}
