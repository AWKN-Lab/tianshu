/**
 * Model Broker (Phase 6 / C05 / WP-AOS-09)
 *
 * 设计文档: `docs/agent-os-3.0/06-Tool-Model-Broker.md` 第 4 节
 *
 * 输入维度:
 * - 能力: reasoning, coding, vision, long_context, structured_output, tool_calling
 * - 任务角色: executor, reviewer, classifier, compressor, summarizer
 * - 成本、时延、上下文容量
 * - 数据位置和保留要求
 * - 可用性
 * - 领域评测表现
 * - fallback 兼容性
 */

import type {
  ModelCapability,
  ModelDescriptor,
  ModelRoutePlan,
  ModelTaskRole,
  ProviderDescriptor,
} from '../contracts/broker.js';
import { createAwknId } from '../contracts/ids.js';

/** Model Broker 错误 */
export class ModelBrokerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ModelBrokerError';
  }
}

export interface ModelRouteRequest {
  taskRole: ModelTaskRole;
  requiredCapabilities: readonly ModelCapability[];
  /** 用户明确指定的 providerId */
  requestedProviderId?: string;
  /** 用户明确指定的 modelId */
  requestedModelId?: string;
  /** 估算输入 token */
  estimatedInputTokens: number;
  /** 估算输出 token */
  estimatedOutputTokens: number;
  /** 上下文窗口要求 */
  requiredContextWindow: number;
  /** 数据边界要求 (例如: EU-only, on-premise) */
  dataBoundaryRequirement?: string;
  /** 成本上限 (USD) */
  costCeilingUsd?: number;
  /** 延迟上限 (ms) */
  latencyCeilingMs?: number;
}

/**
 * 选择最佳模型并生成 ModelRoutePlan
 *
 * fail-closed:
 * - 无可用模型 → 抛错
 * - 请求的模型不存在 → 抛错
 * - 上下文窗口不足 → 抛错
 * - 延迟超过上限 → 抛错
 * - 成本超过上限 → 抛错
 */
export function selectModel(
  request: ModelRouteRequest,
  providers: readonly ProviderDescriptor[],
): ModelRoutePlan {
  if (providers.length === 0) {
    throw new ModelBrokerError('no providers available', 'NO_PROVIDER');
  }

  // 收集所有模型
  const allModels: Array<{ provider: ProviderDescriptor; model: ModelDescriptor }> = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      allModels.push({ provider, model });
    }
  }

  if (allModels.length === 0) {
    throw new ModelBrokerError('no models available', 'NO_MODEL');
  }

  // 1. 用户点名模型
  let selected: { provider: ProviderDescriptor; model: ModelDescriptor } | undefined;
  if (request.requestedProviderId && request.requestedModelId) {
    selected = allModels.find(
      ({ provider, model }) =>
        provider.providerId === request.requestedProviderId &&
        model.modelId === request.requestedModelId,
    );
    if (!selected) {
      throw new ModelBrokerError(
        `requested model not found: ${request.requestedProviderId}/${request.requestedModelId}`,
        'REQUESTED_MODEL_NOT_FOUND',
      );
    }
  } else if (request.requestedModelId) {
    selected = allModels.find(({ model }) => model.modelId === request.requestedModelId);
    if (!selected) {
      throw new ModelBrokerError(
        `requested model not found: ${request.requestedModelId}`,
        'REQUESTED_MODEL_NOT_FOUND',
      );
    }
  }

  // 2. 按能力筛选
  if (!selected) {
    const capable = allModels.filter(({ model }) =>
      request.requiredCapabilities.every((cap) => model.capabilities.includes(cap)),
    );
    if (capable.length === 0) {
      throw new ModelBrokerError(
        `no model has capabilities: ${request.requiredCapabilities.join(', ')}`,
        'CAPABILITY_GAP',
      );
    }

    // 3. 按上下文窗口筛选
    const contextFit = capable.filter(({ model }) => model.contextWindow >= request.requiredContextWindow);
    if (contextFit.length === 0) {
      throw new ModelBrokerError(
        `no model fits context window: required=${request.requiredContextWindow}`,
        'CONTEXT_WINDOW_EXCEEDED',
      );
    }

    // 4. 按任务角色筛选
    const roleFit = contextFit.filter(({ model }) => model.taskRoles.includes(request.taskRole));
    const candidatePool = roleFit.length > 0 ? roleFit : contextFit;

    // 5. 按数据边界筛选
    let boundaryFit = candidatePool;
    if (request.dataBoundaryRequirement) {
      boundaryFit = candidatePool.filter(
        ({ provider }) => provider.dataBoundary === request.dataBoundaryRequirement,
      );
      if (boundaryFit.length === 0) {
        // 没有满足数据边界的, 但继续 (fail-open 数据边界, 后续由 Policy 决定)
        boundaryFit = candidatePool;
      }
    }

    // 6. 按延迟上限筛选
    let latencyFit = boundaryFit;
    if (request.latencyCeilingMs) {
      latencyFit = boundaryFit.filter(({ model }) => model.latencyP99Ms <= request.latencyCeilingMs!);
      if (latencyFit.length === 0) {
        throw new ModelBrokerError(
          `no model meets latency ceiling: ${request.latencyCeilingMs}ms`,
          'LATENCY_EXCEEDED',
        );
      }
    }

    // 7. 按成本上限筛选
    let costFit = latencyFit;
    if (request.costCeilingUsd) {
      costFit = latencyFit.filter(({ model }) => {
        const estimatedCost =
          (request.estimatedInputTokens / 1000) * model.inputCostPer1k +
          (request.estimatedOutputTokens / 1000) * model.outputCostPer1k;
        return estimatedCost <= request.costCeilingUsd!;
      });
      if (costFit.length === 0) {
        throw new ModelBrokerError(
          `no model meets cost ceiling: ${request.costCeilingUsd} USD`,
          'COST_EXCEEDED',
        );
      }
    }

    // 8. 综合评分选择最优 (cost + latency + availability)
    selected = selectBestByScore(costFit, request);
  }

  const { provider, model } = selected;

  // 构建 fallback chain (排除已选 provider)
  const fallbackChain = allModels
    .filter(({ provider: p }) => p.providerId !== provider.providerId)
    .filter(({ model: m }) => hasOverlap(m.capabilities, request.requiredCapabilities))
    .sort((a, b) => {
      // 按 capability overlap 数量降序
      const aOverlap = a.model.capabilities.filter((c) => request.requiredCapabilities.includes(c)).length;
      const bOverlap = b.model.capabilities.filter((c) => request.requiredCapabilities.includes(c)).length;
      return bOverlap - aOverlap;
    })
    .slice(0, 3)
    .map(({ provider: p, model: m }) => `${p.providerId}/${m.modelId}`);

  // 计算能力差异
  const capabilityDelta: string[] = [];
  for (const cap of request.requiredCapabilities) {
    if (!model.capabilities.includes(cap)) {
      capabilityDelta.push(`MISSING:${cap}`);
    }
  }
  // fallback 兼容性差异
  for (const fallbackModel of model.fallbackCompatibleWith) {
    if (!fallbackChain.some((f) => f.includes(fallbackModel))) {
      capabilityDelta.push(`FALLBACK_UNAVAILABLE:${fallbackModel}`);
    }
  }

  const reasonCodes: string[] = [];
  if (request.requestedProviderId && request.requestedModelId) {
    reasonCodes.push('USER_REQUESTED');
  } else {
    reasonCodes.push('CAPABILITY_MATCH');
    if (request.requiredCapabilities.length > 0) reasonCodes.push('CAPABILITY_FILTER');
    if (request.latencyCeilingMs) reasonCodes.push('LATENCY_FILTER');
    if (request.costCeilingUsd) reasonCodes.push('COST_FILTER');
  }

  return {
    schema: 'awkn-model-route-plan/v1',
    routeId: createAwknId('modelRoute'),
    taskRole: request.taskRole,
    requestedProviderId: request.requestedProviderId,
    requestedModelId: request.requestedModelId,
    selectedProviderId: provider.providerId,
    selectedModelId: model.modelId,
    reasonCodes,
    fallbackChain,
    capabilityDelta,
    estimatedInputTokens: request.estimatedInputTokens,
    estimatedOutputTokens: request.estimatedOutputTokens,
    estimatedLatencyMs: model.latencyP50Ms,
  };
}

function hasOverlap<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.some((x) => b.includes(x));
}

function selectBestByScore(
  candidates: ReadonlyArray<{ provider: ProviderDescriptor; model: ModelDescriptor }>,
  request: ModelRouteRequest,
): { provider: ProviderDescriptor; model: ModelDescriptor } {
  // 评分: 成本 (越低越好) + 延迟 (越低越好) + 可用性 (越高越好)
  let best: { provider: ProviderDescriptor; model: ModelDescriptor } | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const estimatedCost =
      (request.estimatedInputTokens / 1000) * candidate.model.inputCostPer1k +
      (request.estimatedOutputTokens / 1000) * candidate.model.outputCostPer1k;
    // 归一化: cost / 0.01 + latency / 1000 + (1 - availability) * 10
    const score = estimatedCost / 0.01 + candidate.model.latencyP50Ms / 1000 + (1 - candidate.model.availability) * 10;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  // best 一定不为 undefined (candidates.length > 0 已在调用前检查)
  return best!;
}
