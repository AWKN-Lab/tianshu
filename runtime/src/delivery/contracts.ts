/**
 * Delivery Contract Builder Helpers (Phase 6 / C07 / WP-AOS-12)
 *
 * 设计文档: `docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md` 第二节
 *
 * 职责：
 * - 根据 GoalSpec.deliveryExpectation 推导 DeliveryContract
 * - 计算 DeliverySideEffect（基于 mode）
 * - 计算 DeliveryFailurePolicy（基于 mode 和风险等级）
 * - 计算 requiresAuthorization（基于 sideEffect）
 * - 构建默认 successPredicate
 *
 * fail-closed:
 * - 缺少 primaryMode → 抛错
 * - 未在 modes 中的 mode 被指定为 primary → 抛错
 * - CONNECTED_SYSTEM 缺少 target → 抛错
 */

import type { DeliveryContract, DeliveryMode, DeliverySideEffect, DeliveryFailurePolicy, ResourceRef, ArtifactRequirement } from '../contracts/delivery.js';
import { createDeliveryId } from '../contracts/delivery.js';
import type { DeliveryExpectation } from '../contracts/goal.js';

/** Delivery Contract Builder 错误 */
export class DeliveryContractError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'DeliveryContractError';
  }
}

/**
 * 根据 DeliveryMode 推导默认 sideEffect
 *
 * - CHAT: none（纯展示）
 * - FILE: local_write（写入本地）
 * - VISUAL: none（仅渲染展示）
 * - ARTIFACT_APP: local_write（应用状态写入）
 * - CONNECTED_SYSTEM: external_write（外部系统修改）
 * - SCHEDULED_TASK: scheduled（调度任务）
 */
export function deriveSideEffect(mode: DeliveryMode): DeliverySideEffect {
  switch (mode) {
    case 'CHAT':
      return 'none';
    case 'FILE':
      return 'local_write';
    case 'VISUAL':
      return 'none';
    case 'ARTIFACT_APP':
      return 'local_write';
    case 'CONNECTED_SYSTEM':
      return 'external_write';
    case 'SCHEDULED_TASK':
      return 'scheduled';
    default: {
      // fail-closed: 未知模式归为最严格
      const exhaustive: never = mode;
      void exhaustive;
      return 'external_write';
    }
  }
}

/**
 * 根据 DeliveryMode 推导默认 failurePolicy
 *
 * - CHAT / VISUAL: FAIL（无副作用，失败直接报告）
 * - FILE: RETRY（可重试写入）
 * - ARTIFACT_APP: PARTIAL（部分状态可接受）
 * - CONNECTED_SYSTEM: ROLLBACK（外部副作用优先回滚）
 * - SCHEDULED_TASK: WAIT_USER（调度失败等待用户决策）
 */
export function deriveFailurePolicy(mode: DeliveryMode): DeliveryFailurePolicy {
  switch (mode) {
    case 'CHAT':
    case 'VISUAL':
      return 'FAIL';
    case 'FILE':
      return 'RETRY';
    case 'ARTIFACT_APP':
      return 'PARTIAL';
    case 'CONNECTED_SYSTEM':
      return 'ROLLBACK';
    case 'SCHEDULED_TASK':
      return 'WAIT_USER';
    default: {
      const exhaustive: never = mode;
      void exhaustive;
      return 'FAIL';
    }
  }
}

/**
 * 根据 sideEffect 推导 requiresAuthorization
 *
 * - none: false
 * - local_write: false（项目授权覆盖）
 * - external_write: true（必须授权）
 * - scheduled: true（必须授权）
 */
export function deriveRequiresAuthorization(sideEffect: DeliverySideEffect): boolean {
  return sideEffect === 'external_write' || sideEffect === 'scheduled';
}

/**
 * 根据 DeliveryMode 构建默认 successPredicate
 */
export function buildDefaultSuccessPredicate(mode: DeliveryMode): Record<string, unknown> {
  switch (mode) {
    case 'CHAT':
      return { messageDelivered: true };
    case 'FILE':
      return { fileWritten: true, hashMatched: true };
    case 'VISUAL':
      return { rendered: true };
    case 'ARTIFACT_APP':
      return { statePersisted: true };
    case 'CONNECTED_SYSTEM':
      return { externalResourceIdReceived: true, verifiedSuccess: true };
    case 'SCHEDULED_TASK':
      return { taskScheduled: true, scheduleConfirmed: true };
    default: {
      const exhaustive: never = mode;
      void exhaustive;
      return { delivered: true };
    }
  }
}

/**
 * Delivery Contract 构建输入
 */
export interface DeliveryContractInput {
  executionId: string;
  mode: DeliveryMode;
  primary: boolean;
  target?: ResourceRef;
  format?: string;
  requiredArtifacts?: ArtifactRequirement[];
  successPredicate?: Record<string, unknown>;
  failurePolicy?: DeliveryFailurePolicy;
  /** 显式覆盖 sideEffect（默认从 mode 推导） */
  sideEffect?: DeliverySideEffect;
  /** 显式覆盖 requiresAuthorization（默认从 sideEffect 推导） */
  requiresAuthorization?: boolean;
}

/**
 * 构建 DeliveryContract
 *
 * fail-closed:
 * - CONNECTED_SYSTEM / SCHEDULED_TASK 必须提供 target
 * - primary=true 时不可与其他 primary 冲突（由上层 Bundle 校验）
 */
export function buildDeliveryContract(input: DeliveryContractInput): DeliveryContract {
  if (!input.executionId) {
    throw new DeliveryContractError(
      'executionId is required',
      'MISSING_EXECUTION_ID',
    );
  }
  if ((input.mode === 'CONNECTED_SYSTEM' || input.mode === 'SCHEDULED_TASK') && !input.target) {
    throw new DeliveryContractError(
      `${input.mode} mode requires target resource`,
      'MISSING_TARGET',
    );
  }

  const sideEffect = input.sideEffect ?? deriveSideEffect(input.mode);
  const requiresAuthorization = input.requiresAuthorization ?? deriveRequiresAuthorization(sideEffect);

  // 二次校验：external_write / scheduled 必须要求授权（防御性）
  if ((sideEffect === 'external_write' || sideEffect === 'scheduled') && !requiresAuthorization) {
    throw new DeliveryContractError(
      `${sideEffect} sideEffect requires authorization`,
      'AUTHORIZATION_REQUIRED',
    );
  }

  const contract: DeliveryContract = {
    schema: 'awkn-delivery-contract/v1',
    deliveryId: createDeliveryId(),
    executionId: input.executionId,
    mode: input.mode,
    sideEffect,
    requiresAuthorization,
    primary: input.primary,
    requiredArtifacts: input.requiredArtifacts ?? [],
    successPredicate: input.successPredicate ?? buildDefaultSuccessPredicate(input.mode),
    failurePolicy: input.failurePolicy ?? deriveFailurePolicy(input.mode),
  };
  if (input.target !== undefined) {
    contract.target = input.target;
  }
  if (input.format !== undefined) {
    contract.format = input.format;
  }
  return contract;
}

/**
 * 从 GoalSpec.deliveryExpectation 推导 DeliveryContract 列表
 *
 * - 为 deliveryExpectation.modes 中的每个 mode 构建一个 DeliveryContract
 * - deliveryExpectation.primaryMode 对应的 Contract 标记为 primary=true
 * - 其余 Contract 标记为 primary=false
 *
 * fail-closed:
 * - deliveryExpectation 为空 → 抛错
 * - primaryMode 不在 modes 中 → 抛错（schema 层已校验，此处二次防御）
 */
export function deriveContractsFromGoal(
  executionId: string,
  deliveryExpectation: DeliveryExpectation,
  options: {
    /** 可选：每个 mode 对应的 target（CONNECTED_SYSTEM / SCHEDULED_TASK 必填） */
    targets?: Partial<Record<DeliveryMode, ResourceRef>>;
    /** 可选：每个 mode 对应的 format */
    formats?: Partial<Record<DeliveryMode, string>>;
    /** 可选：每个 mode 对应的 requiredArtifacts */
    requiredArtifacts?: Partial<Record<DeliveryMode, ArtifactRequirement[]>>;
  } = {},
): DeliveryContract[] {
  if (!deliveryExpectation) {
    throw new DeliveryContractError(
      'deliveryExpectation is required',
      'MISSING_DELIVERY_EXPECTATION',
    );
  }
  if (!deliveryExpectation.modes.includes(deliveryExpectation.primaryMode)) {
    throw new DeliveryContractError(
      `primaryMode ${deliveryExpectation.primaryMode} not in modes`,
      'PRIMARY_MODE_NOT_IN_MODES',
    );
  }

  const contracts: DeliveryContract[] = [];
  for (const mode of deliveryExpectation.modes) {
    // CONNECTED_SYSTEM / SCHEDULED_TASK 必须提供 target
    const target = options.targets?.[mode];
    if ((mode === 'CONNECTED_SYSTEM' || mode === 'SCHEDULED_TASK') && !target) {
      throw new DeliveryContractError(
        `${mode} mode requires target in options.targets`,
        'MISSING_TARGET',
      );
    }
    const contract = buildDeliveryContract({
      executionId,
      mode,
      primary: mode === deliveryExpectation.primaryMode,
      target,
      format: options.formats?.[mode],
      requiredArtifacts: options.requiredArtifacts?.[mode],
      // 使用 GoalSpec 中的 successPredicate 作为 primary 的谓词
      successPredicate: mode === deliveryExpectation.primaryMode
        ? deliveryExpectation.successPredicate as Record<string, unknown>
        : undefined,
    });
    contracts.push(contract);
  }
  return contracts;
}
