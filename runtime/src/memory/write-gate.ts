/**
 * Memory Write Gate (Phase 6 / C09 / WP-AOS-14)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第五、六节
 *
 * 主流程（设计 5.1）：
 *   Execution + Claims + Outcome
 *   → Memory Candidate Extraction
 *   → Source Verification
 *   → Durability Test
 *   → Sensitivity Test
 *   → Decision Impact Test
 *   → Duplicate/Conflict Check
 *   → Consent Policy
 *   → Backend Selection
 *   → CAS Transaction
 *   → Memory Write Receipt
 *
 * 决策逻辑（设计 5.4）：
 * - WRITE：来源已验证 + 耐久 +（高未来效用 OR 人类确认）+ 敏感性允许
 * - REJECT：模型推断 / 未确认建议 / 外部检索作为用户属性 / 临时状态 / 无未来效用 /
 *           无来源摘要 / 跨项目运行时 / 重复 / 冲突 / 敏感性 blocked
 * - DEFER：需要确认（governance 类、assistant 提议的 decision claim）
 * - BACKEND_UNAVAILABLE：memory-os 不可达时仍发回执，backend 为 none
 *
 * 不变量：
 * - governance 记忆必须确认才能写入（契约层强制）
 * - blocked 敏感性不能写入 memory-os 后端（契约层强制）
 * - assistant 提议的 decision 类型 claim 必须确认（契约层强制，设计测试 4）
 * - 缺少 sourceRefs 的候选直接 REJECT（设计测试 3）
 * - 所有 Receipt 通过 zod .parse() 校验（fail-closed）
 */

import { createLogger } from '../core/logger.js';
import { getMemoryBackendRouter } from './router.js';
import { getMemoryTransactionExecutor } from './transaction.js';
import {
  MemoryCandidateSchema,
  MemoryWriteReceiptSchema,
  createMemoryTransactionId,
  createMemoryWriteReceiptId,
  type MemoryCandidate,
  type MemoryTransaction,
  type MemoryWriteReceipt,
  type MemoryWriteReasonCode,
  type MemoryBackend,
} from '../contracts/memory-write.js';
import { toUtcTimestamp } from '../contracts/time.js';

const log = createLogger('memory-write-gate');

/**
 * Claim 的最小可观察形状。MemoryCandidate.claim 在契约层是 z.any()，
 * 此处仅按需读取字段，不与 claim.ts 形成循环依赖。
 */
interface ClaimLike {
  schema: string;
  claimId: string;
  originator: string;
  speaker: string;
  claimType: string;
  epistemicStatus: string;
  confirmationLevel: string;
  sourceRefs: ReadonlyArray<{ sourceKind?: string }>;
  contentHash?: string;
  projectId?: string;
}

interface GateResult {
  readonly pass: boolean;
  readonly reasonCode: MemoryWriteReasonCode;
}

function asClaim(claim: unknown): ClaimLike {
  return claim as ClaimLike;
}

function currentProjectId(): string {
  return process.env.AWKN_PROJECT_ID ?? process.env.npm_package_name ?? 'default-project';
}

export class MemoryWriteGate {
  /** 已写入的 claim contentHash 集合（去重，设计 5.1 Duplicate/Conflict Check） */
  private readonly writtenClaimHashes = new Set<string>();

  /**
   * 评估候选：运行所有 Gate 并产出决策回执。
   *
   * WRITE：来源验证 + 耐久 +（高未来效用 OR 人类确认）+ 敏感性允许 + 后端可用
   * REJECT：命中任一默认拒绝规则
   * DEFER：requiresConfirmation（governance / assistant decision）
   */
  async evaluateCandidate(candidate: MemoryCandidate): Promise<MemoryWriteReceipt> {
    // fail-closed：契约层校验
    const parsed = MemoryCandidateSchema.parse(candidate);
    const claim = asClaim(parsed.claim);
    const claimHash = typeof claim.contentHash === 'string' ? claim.contentHash : '';

    // Gate 1: Source Verification（设计测试 3）
    const source = this.verifySource(parsed);
    if (!source.pass) {
      return this.reject(parsed, claim.claimId, source.reasonCode);
    }

    // Gate 2: Durability Test
    const durability = this.testDurability(parsed);
    if (!durability.pass) {
      return this.reject(parsed, claim.claimId, durability.reasonCode);
    }

    // Gate 3: Decision Impact + Consent —— 需要确认则 DEFER
    const consent = this.checkConsent(parsed);
    if (consent.requiresDefer) {
      return this.defer(parsed, claim.claimId);
    }

    // Gate 4: Sensitivity Test（blocked 不能 memory-os）
    const sensitivity = this.testSensitivity(parsed);
    if (!sensitivity.pass) {
      return this.reject(parsed, claim.claimId, sensitivity.reasonCode);
    }

    // Gate 5: 默认拒绝规则（设计 5.4）
    const rejectRule = this.checkRejectRules(parsed);
    if (rejectRule) {
      return this.reject(parsed, claim.claimId, rejectRule);
    }

    // Gate 6: Duplicate/Conflict Check
    if (claimHash && this.checkDuplicate(claimHash)) {
      return this.reject(parsed, claim.claimId, 'DUPLICATE');
    }

    // 累积正向 reasonCodes
    const reasonCodes = this.collectPositiveReasonCodes(parsed);

    // Gate 7: Backend Selection
    const backend = this.selectBackend(parsed);
    if (backend === 'none') {
      // 后端不可用：仍发回执，backend=none，无 memoryId（设计测试 7 不伪装成功）
      return this.writeUnavailable(parsed, claim.claimId, reasonCodes);
    }

    // Gate 8: CAS Transaction
    const transaction = this.buildTransaction(parsed);
    const execReceipt = await getMemoryTransactionExecutor().execute(transaction);
    const memoryId = execReceipt.memoryId;
    const revision = execReceipt.revision;

    // 用真实 candidateId / 选定 backend / 正向 reasonCodes 重建回执
    const receipt = this.buildReceipt({
      candidateId: parsed.candidateId,
      claimId: claim.claimId,
      decision: 'WRITE',
      reasonCodes,
      backend,
      idempotencyKey: transaction.idempotencyKey,
      transactionId: transaction.transactionId,
      memoryId,
      revision,
    });

    if (claimHash) this.writtenClaimHashes.add(claimHash);
    log.info('candidate written', {
      candidateId: parsed.candidateId, backend, memoryId, revision,
    });
    return receipt;
  }

  /**
   * 提交候选以待确认（DEFER）。用于 governance 类或 assistant 提议的 decision claim。
   */
  submitForConfirmation(candidate: MemoryCandidate): MemoryWriteReceipt {
    const parsed = MemoryCandidateSchema.parse(candidate);
    return this.defer(parsed, this.extractClaimId(parsed));
  }

  /**
   * 执行裸事务（不经过 Gate 评估）。返回执行器回执。
   */
  async executeTransaction(transaction: MemoryTransaction): Promise<MemoryWriteReceipt> {
    return getMemoryTransactionExecutor().execute(transaction);
  }

  /**
   * 检查 claim contentHash 是否已写入。
   */
  checkDuplicate(claimHash: string): boolean {
    return this.writtenClaimHashes.has(claimHash)
      || getMemoryTransactionExecutor().hasClaimHash(claimHash);
  }

  // ===== Gate 实现 =====

  /**
   * 来源验证（设计 5.4 测试 3）。claim 必须有至少一个 sourceRef。
   * 契约层已强制，此处为 belt-and-suspenders 并产出 reasonCode。
   */
  verifySource(candidate: MemoryCandidate): GateResult {
    const claim = asClaim(candidate.claim);
    if (!Array.isArray(claim.sourceRefs) || claim.sourceRefs.length === 0) {
      return { pass: false, reasonCode: 'UNSOURCED_SUMMARY' };
    }
    return { pass: true, reasonCode: 'SOURCE_VERIFIED' };
  }

  /**
   * 耐久测试。durabilityScore >= 0.5 视为耐久；否则为临时状态。
   */
  testDurability(candidate: MemoryCandidate): GateResult {
    if (candidate.durabilityScore < 0.5) {
      return { pass: false, reasonCode: 'TRANSIENT_STATE' };
    }
    return { pass: true, reasonCode: 'DURABLE' };
  }

  /**
   * 敏感性测试。blocked 敏感性不能写入 memory-os 后端（契约层已强制）。
   * 此处对 blocked + memory-os 组合直接拒绝（defense in depth）。
   */
  testSensitivity(candidate: MemoryCandidate): GateResult {
    if (candidate.sensitivityDecision === 'blocked' && candidate.targetBackend === 'memory-os') {
      // 契约层应已拒绝此组合；若到达此处则 fail-closed
      return { pass: false, reasonCode: 'TRANSIENT_STATE' };
    }
    return { pass: true, reasonCode: 'SOURCE_VERIFIED' };
  }

  /**
   * 决策影响测试。governance 类记忆必须要求确认。
   * 契约层已强制 governance → requiresConfirmation；此处确认是否需要 DEFER。
   */
  testDecisionImpact(candidate: MemoryCandidate): { requiresDefer: boolean } {
    if (candidate.proposedMemoryClass === 'governance') {
      return { requiresDefer: true };
    }
    const claim = asClaim(candidate.claim);
    if (claim.originator === 'assistant' && claim.claimType === 'decision') {
      return { requiresDefer: true };
    }
    return { requiresDefer: candidate.requiresConfirmation };
  }

  /**
   * 同意策略。governance 与 requiresConfirmation 候选需要显式确认。
   */
  checkConsent(candidate: MemoryCandidate): { requiresDefer: boolean } {
    return this.testDecisionImpact(candidate);
  }

  /**
   * 后端选择（设计 5.1 Backend Selection）。
   * - memory-os 目标：远程可用 → memory-os；不可用 → local 兜底；blocked → none
   * - local 目标 → local
   * - none 目标 → none
   */
  selectBackend(candidate: MemoryCandidate): MemoryBackend {
    if (candidate.targetBackend === 'none') return 'none';
    if (candidate.targetBackend === 'local') return 'local';
    // targetBackend === 'memory-os'
    if (candidate.sensitivityDecision === 'blocked') return 'none';
    try {
      if (getMemoryBackendRouter().isRemoteAuthorityEnabled()) return 'memory-os';
    } catch (error) {
      log.warn('backend router check failed', { error: error instanceof Error ? error.message : String(error) });
    }
    // memory-os 不可用时兜底到 local（诚实标注 backend=local，不伪装 memory-os）
    return 'local';
  }

  // ===== 内部方法 =====

  /**
   * 默认拒绝规则（设计 5.4）。返回命中的 reasonCode，未命中返回 undefined。
   */
  private checkRejectRules(candidate: MemoryCandidate): MemoryWriteReasonCode | undefined {
    const claim = asClaim(candidate.claim);

    // 模型推断
    if (claim.originator === 'assistant' && claim.epistemicStatus === 'proposed'
      && (claim.claimType === 'prediction' || claim.claimType === 'hypothesis')) {
      return 'MODEL_INFERENCE';
    }

    // 未确认建议
    if (claim.originator === 'assistant' && claim.claimType === 'recommendation'
      && claim.confirmationLevel === 'none') {
      return 'UNCONFIRMED_SUGGESTION';
    }

    // 外部检索结果作为用户属性
    if (claim.originator === 'external' && candidate.proposedMemoryClass === 'semantic') {
      return 'EXTERNAL_RETRIEVAL_AS_USER_ATTR';
    }

    // 跨项目运行时状态
    if (claim.projectId !== undefined && claim.projectId !== '' && claim.projectId !== currentProjectId()) {
      return 'CROSS_PROJECT_RUNTIME';
    }

    // 无未来复用价值（且非人类确认）
    const humanConfirmed = this.isHumanConfirmed(claim);
    if (candidate.futureUtilityScore < 0.5 && !humanConfirmed) {
      return 'NO_FUTURE_UTILITY';
    }

    return undefined;
  }

  private isHumanConfirmed(claim: ClaimLike): boolean {
    if (claim.originator === 'human' && claim.confirmationLevel === 'field') return true;
    if (claim.originator === 'human' && claim.claimType === 'decision'
      && (claim.confirmationLevel === 'field' || claim.confirmationLevel === 'option')) return true;
    return false;
  }

  private collectPositiveReasonCodes(candidate: MemoryCandidate): MemoryWriteReasonCode[] {
    const codes: MemoryWriteReasonCode[] = ['SOURCE_VERIFIED', 'DURABLE'];
    const claim = asClaim(candidate.claim);

    if (candidate.futureUtilityScore >= 0.7) {
      codes.push('HIGH_FUTURE_UTILITY');
    }
    if (claim.originator === 'human' && claim.confirmationLevel === 'field') {
      codes.push('HUMAN_FIELD_CONFIRMED');
    }
    if (claim.originator === 'human' && claim.claimType === 'decision'
      && (claim.confirmationLevel === 'field' || claim.confirmationLevel === 'option')) {
      codes.push('HUMAN_DECISION_EXPLICIT');
    }
    if (claim.epistemicStatus === 'observed'
      && (claim.speaker === 'tool' || claim.originator === 'system')) {
      codes.push('PROJECT_STATE_OBSERVED');
    }
    if (claim.speaker === 'tool' && claim.epistemicStatus === 'observed') {
      codes.push('EXECUTION_EXPERIENCE_VERIFIED');
    }
    return codes;
  }

  private buildTransaction(candidate: MemoryCandidate): MemoryTransaction {
    const claim = asClaim(candidate.claim);
    const claimHash = typeof claim.contentHash === 'string' ? claim.contentHash : candidate.candidateId;
    return {
      schema: 'awkn-transaction/v1',
      transactionId: createMemoryTransactionId(),
      idempotencyKey: `mc-write:${claimHash}`,
      operations: [{
        type: 'create',
        claim: candidate.claim,
        memoryClass: candidate.proposedMemoryClass,
      }],
      dependencyUpdates: [],
      tombstones: [],
    };
  }

  private extractClaimId(candidate: MemoryCandidate): string {
    const claim = asClaim(candidate.claim);
    if (typeof claim.claimId !== 'string' || !claim.claimId) {
      throw new Error('candidate claim missing claimId');
    }
    return claim.claimId;
  }

  private reject(
    candidate: MemoryCandidate,
    claimId: string,
    reasonCode: MemoryWriteReasonCode,
  ): MemoryWriteReceipt {
    log.info('candidate rejected', { candidateId: candidate.candidateId, reasonCode });
    return this.buildReceipt({
      candidateId: candidate.candidateId,
      claimId,
      decision: 'REJECT',
      reasonCodes: [reasonCode],
      backend: 'none',
      idempotencyKey: `mc-write:${candidate.candidateId}`,
    });
  }

  private defer(candidate: MemoryCandidate, claimId: string): MemoryWriteReceipt {
    log.info('candidate deferred for confirmation', { candidateId: candidate.candidateId });
    return this.buildReceipt({
      candidateId: candidate.candidateId,
      claimId,
      decision: 'DEFER',
      reasonCodes: ['REQUIRES_CONFIRMATION'],
      backend: 'none',
      idempotencyKey: `mc-write:${candidate.candidateId}`,
    });
  }

  private writeUnavailable(
    candidate: MemoryCandidate,
    claimId: string,
    reasonCodes: ReadonlyArray<MemoryWriteReasonCode>,
  ): MemoryWriteReceipt {
    log.warn('backend unavailable, issuing receipt without persistence', {
      candidateId: candidate.candidateId,
    });
    return this.buildReceipt({
      candidateId: candidate.candidateId,
      claimId,
      decision: 'WRITE',
      reasonCodes: [...reasonCodes, 'BACKEND_UNAVAILABLE'],
      backend: 'none',
      idempotencyKey: `mc-write:${candidate.candidateId}`,
    });
  }

  private buildReceipt(input: {
    candidateId: string;
    claimId: string;
    decision: 'WRITE' | 'REJECT' | 'DEFER';
    reasonCodes: ReadonlyArray<MemoryWriteReasonCode>;
    backend: MemoryBackend;
    idempotencyKey: string;
    transactionId?: string;
    memoryId?: string;
    revision?: number;
  }): MemoryWriteReceipt {
    const receipt: MemoryWriteReceipt = {
      schema: 'awkn-memory-write-receipt/v1',
      receiptId: createMemoryWriteReceiptId(),
      candidateId: input.candidateId,
      claimId: input.claimId,
      decision: input.decision,
      reasonCodes: [...input.reasonCodes],
      backend: input.backend,
      idempotencyKey: input.idempotencyKey,
      createdAt: toUtcTimestamp(new Date()),
      ...(input.transactionId !== undefined ? { transactionId: input.transactionId } : {}),
      ...(input.memoryId !== undefined ? { memoryId: input.memoryId } : {}),
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
    };
    return MemoryWriteReceiptSchema.parse(receipt);
  }
}

let instance: MemoryWriteGate | null = null;

export function getMemoryWriteGate(): MemoryWriteGate {
  if (!instance) instance = new MemoryWriteGate();
  return instance;
}
