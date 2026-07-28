/**
 * Provider Choice (Phase 6 / C05 / WP-AOS-09)
 *
 * 设计文档: `docs/agent-os-3.0/06-Tool-Model-Broker.md` 第 7 节
 *
 * 当用户点名供应商时, Broker 验证可用性和权限后使用.
 * 用户未点名且多个第三方供应商都可完成任务时:
 * - 返回可选供应商
 * - 标注数据范围、价格和能力差异
 * - 由用户选择
 * - 已存在持久偏好且仍有效时可以直接选择
 * - 内部基础设施可以按组织 Policy 自动路由
 */

import type { ProviderChoice, ProviderDescriptor } from '../contracts/broker.js';

/** Provider Choice 错误 */
export class ProviderChoiceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ProviderChoiceError';
  }
}

export interface ProviderSelectionInput {
  /** 用户明确指定的 providerId (可选) */
  userSelectedProviderId?: string;
  /** 可用的 provider 列表 */
  availableProviders: readonly ProviderDescriptor[];
  /** 用户持久偏好 (可选) */
  persistentPreference?: string;
  /** 是否允许内部基础设施自动路由 */
  allowInternalAutoRoute: boolean;
  /** 持久偏好仍有效 */
  persistentPreferenceValid?: boolean;
}

export interface ProviderSelectionResult {
  chosen: ProviderDescriptor | undefined;
  choices: ProviderChoice[];
  /** 是否需要用户选择 (多个第三方供应商可完成且未指定) */
  requiresUserSelection: boolean;
  reasonCodes: string[];
}

/**
 * 选择供应商
 *
 * 决策树:
 * 1. 用户点名 → 验证可用性和权限 → 使用
 * 2. 持久偏好且有效 → 使用
 * 3. 内部基础设施可用且允许自动路由 → 使用
 * 4. 多个第三方供应商可完成 → 返回可选, 要求用户选择
 * 5. 仅一个供应商 → 使用
 * 6. 无可用供应商 → fail-closed
 */
export function selectProvider(input: ProviderSelectionInput): ProviderSelectionResult {
  if (input.availableProviders.length === 0) {
    // fail-closed: 无可用供应商
    return {
      chosen: undefined,
      choices: [],
      requiresUserSelection: false,
      reasonCodes: ['NO_AVAILABLE_PROVIDER'],
    };
  }

  // 1. 用户点名
  if (input.userSelectedProviderId) {
    const chosen = input.availableProviders.find(
      (p) => p.providerId === input.userSelectedProviderId,
    );
    if (!chosen) {
      throw new ProviderChoiceError(
        `user-selected provider not available: ${input.userSelectedProviderId}`,
        'PROVIDER_UNAVAILABLE',
      );
    }
    return {
      chosen,
      choices: [toProviderChoice(chosen, true, ['USER_SELECTED'])],
      requiresUserSelection: false,
      reasonCodes: ['USER_SELECTED'],
    };
  }

  // 2. 持久偏好且仍有效
  if (input.persistentPreference && input.persistentPreferenceValid) {
    const chosen = input.availableProviders.find(
      (p) => p.providerId === input.persistentPreference,
    );
    if (chosen) {
      return {
        chosen,
        choices: [toProviderChoice(chosen, false, ['PERSISTENT_PREFERENCE'])],
        requiresUserSelection: false,
        reasonCodes: ['PERSISTENT_PREFERENCE'],
      };
    }
  }

  // 3. 内部基础设施可用且允许自动路由
  if (input.allowInternalAutoRoute) {
    const internal = input.availableProviders.filter((p) => p.isInternal);
    if (internal.length === 1) {
      return {
        chosen: internal[0],
        choices: [toProviderChoice(internal[0]!, false, ['INTERNAL_AUTO_ROUTE'])],
        requiresUserSelection: false,
        reasonCodes: ['INTERNAL_AUTO_ROUTE'],
      };
    }
  }

  // 4. 多个第三方供应商 → 返回可选, 要求用户选择
  const thirdParty = input.availableProviders.filter((p) => !p.isInternal);
  if (thirdParty.length > 1) {
    return {
      chosen: undefined,
      choices: thirdParty.map((p) => toProviderChoice(p, false, ['THIRD_PARTY_CANDIDATE'])),
      requiresUserSelection: true,
      reasonCodes: ['MULTIPLE_THIRD_PARTY_REQUIRES_SELECTION'],
    };
  }

  // 5. 仅一个供应商 → 使用
  if (input.availableProviders.length === 1) {
    const chosen = input.availableProviders[0]!;
    return {
      chosen,
      choices: [toProviderChoice(chosen, false, ['ONLY_AVAILABLE'])],
      requiresUserSelection: false,
      reasonCodes: ['ONLY_AVAILABLE'],
    };
  }

  // 6. 多个供应商 (含内部) 但未指定 → 默认选内部基础设施
  if (input.allowInternalAutoRoute) {
    const internal = input.availableProviders.find((p) => p.isInternal);
    if (internal) {
      return {
        chosen: internal,
        choices: [toProviderChoice(internal, false, ['INTERNAL_DEFAULT'])],
        requiresUserSelection: false,
        reasonCodes: ['INTERNAL_DEFAULT'],
      };
    }
  }

  // fallback: 取第一个
  const fallback = input.availableProviders[0]!;
  return {
    chosen: fallback,
    choices: [toProviderChoice(fallback, false, ['FALLBACK_FIRST'])],
    requiresUserSelection: false,
    reasonCodes: ['FALLBACK_FIRST'],
  };
}

function toProviderChoice(
  provider: ProviderDescriptor,
  isUserSelected: boolean,
  reasonCodes: string[],
): ProviderChoice {
  return {
    schema: 'awkn-provider-choice/v1',
    providerId: provider.providerId,
    reasonCodes,
    isUserSelected,
    dataBoundary: provider.dataBoundary,
    priceTier: provider.priceTier,
  };
}
