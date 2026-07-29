/**
 * Delivery Router (Phase 6 / C07 / WP-AOS-13)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第二节
 *
 * 职责：
 * - 协调 Delivery Contract / Receipt / Bundle 的构建与校验
 * - 路由 Execution 结果到 6 种载体（CHAT/FILE/VISUAL/ARTIFACT_APP/CONNECTED_SYSTEM/SCHEDULED_TASK）
 * - 维护交付状态机（PENDING → RUNNING → PARTIAL/SUCCEEDED/FAILED）
 * - 维护 Adapter 注册表，执行 Adapter.deliver 并产出 Receipt
 * - 幂等：同一 deliveryId 已 SUCCEEDED 时直接返回缓存，不重复执行
 * - 重试：失败后再次路由时 retryCount 递增
 *
 * 不变量（设计文档 3.1 禁止合并的状态）：
 * - 测试通过 ≠ 用户采用；文件创建 ≠ 用户下载；邮件工具成功 ≠ 收件人收到
 * - 模型建议完成 ≠ 业务目标达成；用户采用 ≠ 建议有效
 * - 因此 Receipt 同时记录 toolReportedSuccess 与 verifiedSuccess，两者独立。
 *
 * Adapter 边界（设计文档 2.5）：
 * - 允许：天枢 Chat / File / Visual / ArtifactApp / Connector / Cron
 * - 禁止：将 GUNDAM、Value、win 等其他项目作为 Delivery Adapter
 */

import type { ObjectRef } from '../contracts/actors.js';
import {
  DeliveryBundleSchema,
  DeliveryContractSchema,
  DeliveryReceiptSchema,
  createDeliveryId,
  type ArtifactRequirement,
  type DeliveryBundle,
  type DeliveryContract,
  type DeliveryFailurePolicy,
  type DeliveryMode,
  type DeliveryReceipt,
  type DeliverySideEffect,
  type DeliveryState,
  type ResourceRef,
} from '../contracts/delivery.js';
import { createAwknId } from '../contracts/ids.js';
import type { JsonValue } from '../contracts/json-value.js';
import { toUtcTimestamp } from '../contracts/time.js';

// ===== Section 1: Adapter Interface (设计文档 2.5) =====

/**
 * Delivery Adapter 接口。
 *
 * Adapter 负责执行具体副作用并产出 Receipt。
 * Router 不实现副作用，只协调与校验。
 */
export interface DeliveryAdapter {
  readonly mode: DeliveryMode;
  deliver(
    contract: DeliveryContract,
    artifacts: ReadonlyArray<ObjectRef>,
  ): Promise<DeliveryReceipt>;
}

// ===== Section 2: Input Types =====

export interface CreateDeliveryContractInput {
  executionId: string;
  mode: DeliveryMode;
  target?: ResourceRef;
  format?: string;
  primary: boolean;
  sideEffect: DeliverySideEffect;
  requiresAuthorization: boolean;
  requiredArtifacts: ReadonlyArray<ArtifactRequirement>;
  successPredicate: Record<string, JsonValue>;
  failurePolicy: DeliveryFailurePolicy;
}

export interface CreateDeliveryReceiptInput {
  deliveryId: string;
  executionId: string;
  mode: DeliveryMode;
  state: DeliveryState;
  actualTarget?: ResourceRef;
  artifactRefs: ReadonlyArray<ObjectRef>;
  artifactHashes: ReadonlyArray<string>;
  externalResourceId?: string;
  toolReportedSuccess: boolean;
  verifiedSuccess: boolean;
  reversible: boolean;
  failureReason?: string;
  retryCount: number;
  compensationRef?: string;
  deliveredAt?: string;
}

export interface CreateDeliveryBundleInput {
  executionId: string;
  contracts: ReadonlyArray<DeliveryContract>;
  artifactRefs: ReadonlyArray<ObjectRef>;
  primaryDeliveryId: string;
  receipts?: ReadonlyArray<DeliveryReceipt>;
  state?: DeliveryState;
}

// ===== Section 3: Delivery State Machine (设计文档 2.3) =====

const STATE_TRANSITIONS: Record<DeliveryState, ReadonlyArray<DeliveryState>> = {
  PENDING: ['RUNNING'],
  RUNNING: ['PARTIAL', 'SUCCEEDED', 'FAILED'],
  PARTIAL: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
};

/** 判断状态迁移是否合法。同态迁移（no-op）始终允许。 */
export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  if (from === to) return true;
  return STATE_TRANSITIONS[from].includes(to);
}

function assertTransition(from: DeliveryState, to: DeliveryState): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid delivery state transition: ${from} -> ${to}`);
  }
}

// ===== Section 4: Delivery Router =====

/**
 * Delivery Router 协调器。
 *
 * 状态独立于 Execution（设计文档 3.1）：
 * Router 只关心 Delivery 自身的 PENDING/RUNNING/PARTIAL/SUCCEEDED/FAILED。
 */
export class DeliveryRouter {
  private readonly adapters = new Map<DeliveryMode, DeliveryAdapter>();
  private readonly receiptByDeliveryId = new Map<string, DeliveryReceipt>();

  /**
   * 注册 Adapter（设计文档 2.5）。
   * 同一 mode 后注册者覆盖先注册者。
   */
  registerAdapter(adapter: DeliveryAdapter): void {
    this.adapters.set(adapter.mode, adapter);
  }

  /** 按 mode 查找 Adapter。 */
  getAdapter(mode: DeliveryMode): DeliveryAdapter | undefined {
    return this.adapters.get(mode);
  }

  // ---- Contract (设计文档 2.2) ----

  /**
   * 构建并校验 Delivery Contract。
   * 生成 deliveryId，使用 zod .parse() fail-closed 校验。
   */
  createDeliveryContract(input: CreateDeliveryContractInput): DeliveryContract {
    const contract: DeliveryContract = {
      schema: 'awkn-delivery-contract/v1',
      deliveryId: createDeliveryId(),
      executionId: input.executionId,
      mode: input.mode,
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
      primary: input.primary,
      sideEffect: input.sideEffect,
      requiresAuthorization: input.requiresAuthorization,
      requiredArtifacts: [...input.requiredArtifacts],
      successPredicate: input.successPredicate,
      failurePolicy: input.failurePolicy,
    };
    return DeliveryContractSchema.parse(contract);
  }

  // ---- Receipt (设计文档 2.4) ----

  /**
   * 构建并校验 Delivery Receipt。
   *
   * verifiedSuccess 与 toolReportedSuccess 独立区分（设计文档 3.1）：
   * - toolReportedSuccess：工具/Adapter 自报告是否成功
   * - verifiedSuccess：Router 或上层是否独立验证成功
   */
  createDeliveryReceipt(input: CreateDeliveryReceiptInput): DeliveryReceipt {
    const receipt: DeliveryReceipt = {
      schema: 'awkn-delivery-receipt/v1',
      receiptId: createAwknId('receipt'),
      deliveryId: input.deliveryId,
      executionId: input.executionId,
      mode: input.mode,
      state: input.state,
      ...(input.actualTarget !== undefined ? { actualTarget: input.actualTarget } : {}),
      artifactRefs: [...input.artifactRefs],
      artifactHashes: [...input.artifactHashes],
      ...(input.externalResourceId !== undefined ? { externalResourceId: input.externalResourceId } : {}),
      toolReportedSuccess: input.toolReportedSuccess,
      verifiedSuccess: input.verifiedSuccess,
      reversible: input.reversible,
      ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
      retryCount: input.retryCount,
      ...(input.compensationRef !== undefined ? { compensationRef: input.compensationRef } : {}),
      ...(input.deliveredAt !== undefined ? { deliveredAt: input.deliveredAt } : {}),
      createdAt: toUtcTimestamp(new Date()),
    };
    return DeliveryReceiptSchema.parse(receipt);
  }

  // ---- Bundle (设计文档 2.3) ----

  /**
   * 构建并校验 Delivery Bundle。
   *
   * 必须有且仅有一个 Primary Delivery（设计文档 2.1）。
   * primaryDeliveryId 必须对应一个 primary contract。
   */
  createDeliveryBundle(input: CreateDeliveryBundleInput): DeliveryBundle {
    const now = toUtcTimestamp(new Date());
    const bundle: DeliveryBundle = {
      schema: 'awkn-delivery-bundle/v1',
      bundleId: createDeliveryId(),
      executionId: input.executionId,
      contracts: [...input.contracts],
      artifactRefs: [...input.artifactRefs],
      receipts: input.receipts ? [...input.receipts] : [],
      primaryDeliveryId: input.primaryDeliveryId,
      state: input.state ?? 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    return DeliveryBundleSchema.parse(bundle);
  }

  // ---- Route (设计文档 2.1) ----

  /**
   * 路由 Delivery：按 contract.mode 查找 Adapter，执行并产出 Receipt。
   *
   * 幂等：若 deliveryId 已有 SUCCEEDED Receipt，直接返回缓存，不重复执行。
   * 重试：若 deliveryId 上次 Receipt 非 SUCCEEDED，retryCount 在原值上递增。
   *
   * @param contract 已校验的 Delivery Contract
   * @param artifacts 关联产物引用（用于 Adapter 校验产物 Hash）
   */
  async routeDelivery(
    contract: DeliveryContract,
    artifacts: ReadonlyArray<ObjectRef>,
  ): Promise<DeliveryReceipt> {
    const cached = this.receiptByDeliveryId.get(contract.deliveryId);
    if (cached !== undefined && cached.state === 'SUCCEEDED') {
      return cached;
    }

    const adapter = this.adapters.get(contract.mode);
    if (adapter === undefined) {
      throw new Error(`no adapter registered for mode ${contract.mode}`);
    }

    const attemptNumber = cached !== undefined ? cached.retryCount + 1 : 0;
    const raw = await adapter.deliver(contract, artifacts);
    // Router 维护重试语义：覆盖 Adapter 自报告的 retryCount
    const receipt: DeliveryReceipt = { ...raw, retryCount: attemptNumber };
    const validated = DeliveryReceiptSchema.parse(receipt);
    this.receiptByDeliveryId.set(contract.deliveryId, validated);
    return validated;
  }

  // ---- Close Bundle (设计文档 2.3) ----

  /**
   * 闭合 Bundle：根据 Receipts 推导终态。
   *
   * - 全部 SUCCEEDED → SUCCEEDED
   * - 全部 FAILED → FAILED
   * - SUCCEEDED/FAILED 混合 → PARTIAL
   * - 存在 PENDING/RUNNING → 推进至 RUNNING（不可终态闭合）
   *
   * 已处于 SUCCEEDED/FAILED 的 Bundle 不再变更。
   */
  closeBundle(
    bundle: DeliveryBundle,
    receipts: ReadonlyArray<DeliveryReceipt>,
  ): DeliveryBundle {
    // 已闭合的 Bundle 不再变更
    if (bundle.state === 'SUCCEEDED' || bundle.state === 'FAILED') {
      return bundle;
    }
    if (receipts.length === 0) {
      return bundle;
    }

    const now = toUtcTimestamp(new Date());
    const hasNonTerminal = receipts.some(
      (r) => r.state === 'PENDING' || r.state === 'RUNNING',
    );

    if (hasNonTerminal) {
      const nextState: DeliveryState = bundle.state === 'PENDING' ? 'RUNNING' : bundle.state;
      assertTransition(bundle.state, nextState);
      const next: DeliveryBundle = {
        ...bundle,
        receipts: [...receipts],
        state: nextState,
        updatedAt: now,
      };
      return DeliveryBundleSchema.parse(next);
    }

    const succeeded = receipts.filter((r) => r.state === 'SUCCEEDED').length;
    const failed = receipts.filter((r) => r.state === 'FAILED').length;
    const nextState: DeliveryState =
      failed === 0 ? 'SUCCEEDED' : succeeded === 0 ? 'FAILED' : 'PARTIAL';

    assertTransition(bundle.state, nextState);
    const next: DeliveryBundle = {
      ...bundle,
      receipts: [...receipts],
      state: nextState,
      updatedAt: now,
      closedAt: now,
    };
    return DeliveryBundleSchema.parse(next);
  }

  // ---- Describe (人类可读摘要) ----

  /**
   * 返回 Bundle 的人类可读摘要。
   */
  describeBundle(bundle: DeliveryBundle): string {
    const contracts = bundle.contracts;
    const primary = contracts.find((c) => c.primary);
    const primaryCount = contracts.filter((c) => c.primary).length;
    const receipts = bundle.receipts;
    const succeeded = receipts.filter((r) => r.state === 'SUCCEEDED').length;
    const failed = receipts.filter((r) => r.state === 'FAILED').length;
    const partial = receipts.filter((r) => r.state === 'PARTIAL').length;
    const inFlight = receipts.filter(
      (r) => r.state === 'PENDING' || r.state === 'RUNNING',
    ).length;
    const lines: string[] = [
      `Bundle ${bundle.bundleId} (state=${bundle.state}, primary=${bundle.primaryDeliveryId})`,
      `  Contracts: ${contracts.length} (${primaryCount} primary, ${contracts.length - primaryCount} secondary)`,
      `  Primary mode: ${primary?.mode ?? 'unknown'}`,
      `  Receipts: ${receipts.length} (${succeeded} succeeded, ${failed} failed, ${partial} partial, ${inFlight} in-flight)`,
      `  Artifacts: ${bundle.artifactRefs.length}`,
      `  Created: ${bundle.createdAt}`,
      `  Updated: ${bundle.updatedAt}`,
      ...(bundle.closedAt !== undefined ? [`  Closed: ${bundle.closedAt}`] : []),
    ];
    return lines.join('\n');
  }

  // ---- Cache inspection ----

  /** 获取缓存的 Receipt（用于幂等查询）。 */
  getCachedReceipt(deliveryId: string): DeliveryReceipt | undefined {
    return this.receiptByDeliveryId.get(deliveryId);
  }

  /** 清空 Receipt 缓存（主要用于测试）。 */
  clearCache(): void {
    this.receiptByDeliveryId.clear();
  }
}

// ===== Section 5: Built-in Adapters =====

/**
 * 内存型 CHAT Adapter（用于测试与默认 CHAT 路由）。
 *
 * 总是成功，产生一个虚拟 artifact hash 以满足 SUCCEEDED 约束。
 * 不执行任何真实副作用。
 */
export class InMemoryDeliveryAdapter implements DeliveryAdapter {
  readonly mode: DeliveryMode = 'CHAT';

  async deliver(
    contract: DeliveryContract,
    artifacts: ReadonlyArray<ObjectRef>,
  ): Promise<DeliveryReceipt> {
    const now = toUtcTimestamp(new Date());
    const fakeHash = '0'.repeat(64);
    const hashes = artifacts.flatMap((a) => (a.contentHash ? [a.contentHash] : []));
    const artifactHashes = hashes.length > 0 ? hashes : [fakeHash];
    return DeliveryReceiptSchema.parse({
      schema: 'awkn-delivery-receipt/v1',
      receiptId: createAwknId('receipt'),
      deliveryId: contract.deliveryId,
      executionId: contract.executionId,
      mode: contract.mode,
      state: 'SUCCEEDED',
      artifactRefs: [...artifacts],
      artifactHashes,
      toolReportedSuccess: true,
      verifiedSuccess: true,
      reversible: false,
      retryCount: 0,
      deliveredAt: now,
      createdAt: now,
    });
  }
}

/**
 * 外部写入 Adapter（用于 CONNECTED_SYSTEM / SCHEDULED_TASK）。
 *
 * 需要授权 Token；缺少授权时返回 FAILED Receipt（设计文档 2.5）。
 * 真实副作用通过 delegate 异步函数执行；delegate 抛错时产出 FAILED Receipt。
 */
export interface ExternalWriteAdapterOptions {
  mode: DeliveryMode;
  authorizationToken: string;
  delegate?: (
    contract: DeliveryContract,
    artifacts: ReadonlyArray<ObjectRef>,
  ) => Promise<{
    externalResourceId?: string;
    actualTarget?: ResourceRef;
    artifactHashes?: ReadonlyArray<string>;
    failureReason?: string;
  }>;
}

export class ExternalWriteAdapter implements DeliveryAdapter {
  readonly mode: DeliveryMode;
  private readonly authorizationToken: string;
  private readonly delegate: ExternalWriteAdapterOptions['delegate'];

  constructor(options: ExternalWriteAdapterOptions) {
    this.mode = options.mode;
    this.authorizationToken = options.authorizationToken;
    this.delegate = options.delegate;
  }

  async deliver(
    contract: DeliveryContract,
    artifacts: ReadonlyArray<ObjectRef>,
  ): Promise<DeliveryReceipt> {
    const now = toUtcTimestamp(new Date());
    const baseReceipt = {
      schema: 'awkn-delivery-receipt/v1' as const,
      receiptId: createAwknId('receipt'),
      deliveryId: contract.deliveryId,
      executionId: contract.executionId,
      mode: contract.mode,
      ...(contract.target !== undefined ? { actualTarget: contract.target } : {}),
      artifactRefs: [...artifacts],
      artifactHashes: [] as string[],
      retryCount: 0,
      createdAt: now,
    };

    if (!this.authorizationToken) {
      return DeliveryReceiptSchema.parse({
        ...baseReceipt,
        state: 'FAILED',
        toolReportedSuccess: false,
        verifiedSuccess: false,
        reversible: false,
        failureReason: 'missing authorization token',
      });
    }

    if (this.delegate === undefined) {
      return DeliveryReceiptSchema.parse({
        ...baseReceipt,
        state: 'FAILED',
        toolReportedSuccess: false,
        verifiedSuccess: false,
        reversible: false,
        failureReason: 'no delegate configured for external write',
      });
    }

    try {
      const result = await this.delegate(contract, artifacts);
      const artifactHashes = result.artifactHashes !== undefined ? [...result.artifactHashes] : [];

      if (result.failureReason !== undefined) {
        return DeliveryReceiptSchema.parse({
          ...baseReceipt,
          ...(result.actualTarget !== undefined ? { actualTarget: result.actualTarget } : {}),
          ...(result.externalResourceId !== undefined ? { externalResourceId: result.externalResourceId } : {}),
          artifactHashes,
          state: 'FAILED',
          toolReportedSuccess: false,
          verifiedSuccess: false,
          reversible: false,
          failureReason: result.failureReason,
        });
      }

      if (artifactHashes.length === 0) {
        // SUCCEEDED 要求至少一个 artifactHash（契约层强约束）；无 hash 视为失败
        return DeliveryReceiptSchema.parse({
          ...baseReceipt,
          ...(result.actualTarget !== undefined ? { actualTarget: result.actualTarget } : {}),
          ...(result.externalResourceId !== undefined ? { externalResourceId: result.externalResourceId } : {}),
          state: 'FAILED',
          toolReportedSuccess: true,
          verifiedSuccess: false,
          reversible: false,
          failureReason: 'delegate returned no artifact hashes',
        });
      }

      return DeliveryReceiptSchema.parse({
        ...baseReceipt,
        ...(result.actualTarget !== undefined ? { actualTarget: result.actualTarget } : {}),
        ...(result.externalResourceId !== undefined ? { externalResourceId: result.externalResourceId } : {}),
        artifactHashes,
        state: 'SUCCEEDED',
        toolReportedSuccess: true,
        verifiedSuccess: true,
        reversible: false,
        deliveredAt: now,
      });
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      return DeliveryReceiptSchema.parse({
        ...baseReceipt,
        state: 'FAILED',
        toolReportedSuccess: false,
        verifiedSuccess: false,
        reversible: false,
        failureReason,
      });
    }
  }
}


