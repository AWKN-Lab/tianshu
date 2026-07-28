/**
 * Delivery Router (Phase 6 / C07 / WP-AOS-12)
 *
 * 设计文档: `docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md` 第二节
 *
 * 主流程：
 * ```text
 * GoalSpec.deliveryExpectation + ExecutionResult
 * → select Delivery modes
 * → build DeliveryContract for each mode
 * → mark Primary Delivery
 * → build DeliveryBundle
 * → execute deliveries (上层负责)
 * → attach DeliveryReceipts
 * → finalize Bundle state (SUCCEEDED / PARTIAL / FAILED)
 * ```
 *
 * 本模块为纯编排层，不直接执行外部系统调用。
 * 上层（AgentLoop）负责实际执行 Delivery Adapter。
 *
 * 关键规则：
 * - 同一 Execution 可产生多个 Delivery，必须指定 Primary
 * - Delivery 与 Execution 状态完全分离
 * - fail-closed: 未知状态归为 UNKNOWN
 */

import type {
  DeliveryBundle,
  DeliveryBundleState,
  DeliveryContract,
  DeliveryReceipt,
  ArtifactRef,
  DeliveryMode,
  ResourceRef,
  ArtifactRequirement,
} from '../contracts/delivery.js';
import { createDeliveryId } from '../contracts/delivery.js';
import type { DeliveryExpectation } from '../contracts/goal.js';
import { toUtcTimestamp } from '../contracts/time.js';
import {
  buildDeliveryContract,
  deriveContractsFromGoal,
  type DeliveryContractInput,
} from './contracts.js';

/** Delivery Router 错误 */
export class DeliveryRouterError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'DeliveryRouterError';
  }
}

/**
 * Router 构建输入（用于 planDeliveryBundle）
 */
export interface DeliveryRouterInput {
  executionId: string;
  deliveryExpectation: DeliveryExpectation;
  /** 可选：每个 mode 对应的 target（CONNECTED_SYSTEM / SCHEDULED_TASK 必填） */
  targets?: Partial<Record<DeliveryMode, ResourceRef>>;
  /** 可选：每个 mode 对应的 format */
  formats?: Partial<Record<DeliveryMode, string>>;
  /** 可选：每个 mode 对应的 requiredArtifacts */
  requiredArtifacts?: Partial<Record<DeliveryMode, ArtifactRequirement[]>>;
  /** 可选：执行产生的产物（用于绑定到 Bundle） */
  artifacts?: ArtifactRef[];
  /** 可选：当前 UTC 时间戳（默认现在） */
  now?: string;
}

/**
 * 构建 DeliveryBundle（PENDING 状态）
 *
 * 步骤：
 * 1. 从 deliveryExpectation 推导 DeliveryContract 列表
 * 2. 找到 primary contract，提取 primaryDeliveryId
 * 3. 构建 PENDING 状态的 DeliveryBundle
 *
 * fail-closed:
 * - deliveryExpectation 为空 → 抛错
 * - 没有任何 primary=true 的 contract → 抛错
 * - 多于一个 primary=true 的 contract → 抛错
 */
export function planDeliveryBundle(input: DeliveryRouterInput): DeliveryBundle {
  if (!input.executionId) {
    throw new DeliveryRouterError(
      'executionId is required',
      'MISSING_EXECUTION_ID',
    );
  }

  const contracts = deriveContractsFromGoal(
    input.executionId,
    input.deliveryExpectation,
    {
      targets: input.targets,
      formats: input.formats,
      requiredArtifacts: input.requiredArtifacts,
    },
  );

  if (contracts.length === 0) {
    throw new DeliveryRouterError(
      'no delivery contracts derived from goal',
      'NO_CONTRACTS_DERIVED',
    );
  }

  const primaries = contracts.filter((c) => c.primary);
  if (primaries.length === 0) {
    throw new DeliveryRouterError(
      'no primary delivery contract derived',
      'NO_PRIMARY_CONTRACT',
    );
  }
  if (primaries.length > 1) {
    throw new DeliveryRouterError(
      `multiple primary contracts derived: ${primaries.length}`,
      'MULTIPLE_PRIMARY_CONTRACTS',
    );
  }
  const primaryContract = primaries[0]!;
  const primaryDeliveryId = primaryContract.deliveryId;

  const now = input.now ?? toUtcTimestamp(new Date());
  const bundle: DeliveryBundle = {
    schema: 'awkn-delivery-bundle/v1',
    bundleId: createDeliveryId(),
    executionId: input.executionId,
    contracts,
    artifacts: input.artifacts ?? [],
    receipts: [],
    primaryDeliveryId,
    state: 'PENDING',
    createdAt: now,
  };
  return bundle;
}

/**
 * 根据 Execution Result 决定 Bundle 是否应该开始执行（PENDING → RUNNING）
 *
 * 注意：执行失败也可启动 Delivery（如 CHAT 模式报告失败原因）。
 *
 * 当前策略：始终允许启动 Delivery，由上层根据 GoalSpec 决定是否跳过。
 * 保留 executionSucceeded 入参以支持未来更精细的策略（如失败时仅允许 CHAT 模式）。
 */
export function shouldStartDelivery(_executionSucceeded: boolean): boolean {
  // 即使执行失败，也允许启动 Delivery（如 CHAT 报告失败原因）
  // 上层可根据 GoalSpec 决定是否跳过 Delivery
  return true;
}

/**
 * 附加 Receipt 到 Bundle 并更新状态
 *
 * 状态转换规则：
 * - PENDING → RUNNING（第一次附加 Receipt 时）
 * - RUNNING → SUCCEEDED（所有 Receipts 都是 SUCCESS）
 * - RUNNING → FAILED（任一 Receipt 不是 SUCCESS 且 failurePolicy=FAIL）
 * - RUNNING → PARTIAL（任一 Receipt 不是 SUCCESS 且 failurePolicy=PARTIAL）
 * - 其他状态保持（终态不可逆）
 *
 * fail-closed:
 * - 收到未知 Receipt 的 deliveryId → 抛错
 * - 已 SUCCEEDED 的 Bundle 收到失败 Receipt → 抛错（状态不一致）
 */
export function attachReceiptAndFinalize(
  bundle: DeliveryBundle,
  receipt: DeliveryReceipt,
  now: string = toUtcTimestamp(new Date()),
): DeliveryBundle {
  // 校验 receipt.deliveryId 存在于 contracts
  const contractIds = new Set(bundle.contracts.map((c) => c.deliveryId));
  if (!contractIds.has(receipt.deliveryId)) {
    throw new DeliveryRouterError(
      `receipt references unknown deliveryId: ${receipt.deliveryId}`,
      'UNKNOWN_DELIVERY_ID',
    );
  }

  // 终态 Bundle 不可再附加 Receipt（先于 DUPLICATE_RECEIPT 检查：
  // 已定稿的 bundle 即使收到重复 deliveryId 的 receipt，也应以 BUNDLE_ALREADY_FINALIZED 拒绝）
  if (bundle.state === 'SUCCEEDED' || bundle.state === 'FAILED') {
    throw new DeliveryRouterError(
      `cannot attach receipt to ${bundle.state} bundle`,
      'BUNDLE_ALREADY_FINALIZED',
    );
  }

  // 已有同 deliveryId 的 receipt 不允许覆盖（追加模式）
  if (bundle.receipts.some((r) => r.deliveryId === receipt.deliveryId)) {
    throw new DeliveryRouterError(
      `receipt for deliveryId ${receipt.deliveryId} already attached`,
      'DUPLICATE_RECEIPT',
    );
  }

  const newReceipts = [...bundle.receipts, receipt];

  // 计算新状态
  const newState = computeBundleState(bundle.contracts, newReceipts);

  const updatedBundle: DeliveryBundle = {
    ...bundle,
    receipts: newReceipts,
    state: newState,
  };
  // 终态时设置 finalizedAt
  if (newState === 'SUCCEEDED' || newState === 'FAILED' || newState === 'PARTIAL') {
    updatedBundle.finalizedAt = now;
  }
  return updatedBundle;
}

/**
 * 根据 contracts 和 receipts 计算 Bundle 状态
 *
 * - receipts 为空 → PENDING（或 RUNNING，由调用方决定）
 * - receipts 未覆盖所有 contracts → RUNNING
 * - 所有 receipts 都是 SUCCESS → SUCCEEDED
 * - 任一 receipt 不是 SUCCESS：
 *   - 查看对应 contract 的 failurePolicy
 *   - PARTIAL 允许 → PARTIAL（如果有部分成功）
 *   - 其他 → FAILED
 *
 * 注意：本函数假设 receipts 中的 deliveryId 都已校验存在。
 */
export function computeBundleState(
  contracts: readonly DeliveryContract[],
  receipts: readonly DeliveryReceipt[],
): DeliveryBundleState {
  if (receipts.length === 0) {
    return 'PENDING';
  }

  // 检查是否所有 contracts 都有 receipt
  const contractIds = new Set(contracts.map((c) => c.deliveryId));
  const receivedIds = new Set(receipts.map((r) => r.deliveryId));
  const allCovered = contractIds.size === receivedIds.size
    && [...contractIds].every((id) => receivedIds.has(id));

  if (!allCovered) {
    return 'RUNNING';
  }

  // 所有 receipts 都成功 → SUCCEEDED
  const allSuccess = receipts.every((r) => r.toolReportedStatus === 'SUCCESS');
  if (allSuccess) {
    return 'SUCCEEDED';
  }

  // 部分失败：检查 failurePolicy
  const contractById = new Map(contracts.map((c) => [c.deliveryId, c] as const));
  const hasPartialPolicy = receipts.some((r) => {
    const contract = contractById.get(r.deliveryId);
    return contract?.failurePolicy === 'PARTIAL';
  });
  const hasAnySuccess = receipts.some((r) => r.toolReportedStatus === 'SUCCESS');

  // 如果有 PARTIAL 策略且有部分成功 → PARTIAL
  if (hasPartialPolicy && hasAnySuccess) {
    return 'PARTIAL';
  }

  // 否则 → FAILED
  return 'FAILED';
}

/**
 * 便捷方法：构建单个 DeliveryContract（用于自定义场景）
 */
export function buildSingleDeliveryContract(input: DeliveryContractInput): DeliveryContract {
  return buildDeliveryContract(input);
}

/**
 * 从 Bundle 中查找 Primary Delivery Contract
 */
export function findPrimaryContract(bundle: DeliveryBundle): DeliveryContract {
  const primary = bundle.contracts.find((c) => c.deliveryId === bundle.primaryDeliveryId);
  if (!primary) {
    throw new DeliveryRouterError(
      `primary delivery contract not found: ${bundle.primaryDeliveryId}`,
      'PRIMARY_CONTRACT_NOT_FOUND',
    );
  }
  return primary;
}

/**
 * 从 Bundle 中查找指定 deliveryId 的 Receipt
 */
export function findReceiptForDelivery(
  bundle: DeliveryBundle,
  deliveryId: string,
): DeliveryReceipt | undefined {
  return bundle.receipts.find((r) => r.deliveryId === deliveryId);
}

/**
 * 检查 Bundle 是否处于终态
 */
export function isBundleFinalized(bundle: DeliveryBundle): boolean {
  return bundle.state === 'SUCCEEDED' || bundle.state === 'FAILED' || bundle.state === 'PARTIAL';
}

/**
 * 检查 Bundle 是否成功完成
 */
export function isBundleSucceeded(bundle: DeliveryBundle): boolean {
  return bundle.state === 'SUCCEEDED';
}

/**
 * 检查 Bundle 是否失败
 */
export function isBundleFailed(bundle: DeliveryBundle): boolean {
  return bundle.state === 'FAILED';
}

// 重新导出便于上层使用
export { DeliveryContractError } from './contracts.js';
