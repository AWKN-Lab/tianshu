/**
 * Broker 主入口 (Phase 6 / C05 / WP-AOS-08/09)
 *
 * 设计文档: `docs/agent-os-3.0/06-Tool-Model-Broker.md` 第 2 节
 *
 * 主流程:
 * ```text
 * Compiled Policy/Skill Bundle
 * → Capability Requirements
 * → Available Models/Tools/Providers
 * → Cost/Latency/Privacy/Risk Scoring
 * → Provider Choice
 * → Authorization Check
 * → Broker Plan Freeze
 * → Execute
 * → Verify Side Effect
 * → Receipts
 * ```
 */

import type {
  AuthorizationRequirement,
  BrokerPlan,
  CostBudget,
  ModelRoutePlan,
  ProviderChoice,
  ProviderDescriptor,
  RiskSnapshot,
  ToolCapability,
  ToolRoutePlan,
} from '../contracts/broker.js';
import { computeBrokerPlanHash } from '../contracts/broker.js';
import { createAwknId } from '../contracts/ids.js';
import { computeCumulativeRisk } from './cumulative-risk.js';
import { selectModel, type ModelRouteRequest } from './model-broker.js';
import { buildToolRoutePlan, type AuthorizationRequirementInput } from './tool-broker.js';
import { selectProvider, type ProviderSelectionInput } from './provider-choice.js';

/** Broker 错误 */
export class BrokerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'BrokerError';
  }
}

export interface BrokerPlanInput {
  executionId: string;
  modelRouteRequests: readonly ModelRouteRequest[];
  toolCapabilities: readonly ToolCapability[];
  toolRequirements: ReadonlyMap<string, AuthorizationRequirementInput>;
  providers: readonly ProviderDescriptor[];
  providerSelection: Omit<ProviderSelectionInput, 'availableProviders'>;
  costBudget: Omit<CostBudget, 'schema'>;
  /** 已验证补偿方案 (用于风险折扣) */
  verifiedCompensation: boolean;
  frozenAt: string;
}

/**
 * 构建 BrokerPlan
 *
 * fail-closed:
 * - 空 modelRouteRequests → 抛错 (无模型路由需求是无效 plan)
 * - 空 toolCapabilities 且需要工具 → 抛错
 * - toolCapability.requiresAuthorization 为 true 但未在 toolRequirements 中提供 → 抛错
 * - selectModel 失败 → 透传错误
 * - selectProvider 返回 requiresUserSelection → 抛错 (要求用户先选择)
 */
export function buildBrokerPlan(input: BrokerPlanInput): BrokerPlan {
  if (input.modelRouteRequests.length === 0) {
    throw new BrokerError('no model route requests provided', 'EMPTY_MODEL_ROUTES');
  }

  // 1. 选择供应商
  const providerSelection = selectProvider({
    ...input.providerSelection,
    availableProviders: input.providers,
  });
  if (providerSelection.requiresUserSelection) {
    throw new BrokerError(
      'multiple third-party providers available; user selection required',
      'PROVIDER_SELECTION_REQUIRED',
    );
  }
  const chosenProvider = providerSelection.chosen;
  if (!chosenProvider) {
    throw new BrokerError('no provider chosen', 'NO_PROVIDER');
  }

  // 2. 为每个 modelRouteRequest 选择模型
  const modelRoutes: ModelRoutePlan[] = [];
  // 限制 providers 为已选 + 其 fallback 候选
  const candidateProviders = [chosenProvider, ...input.providers.filter((p) => p.providerId !== chosenProvider.providerId)];
  for (const request of input.modelRouteRequests) {
    const route = selectModel(request, candidateProviders);
    modelRoutes.push(route);
  }

  // 3. 构建工具路由
  const toolRoutes: ToolRoutePlan[] = [];
  const authorizationRequirements: AuthorizationRequirement[] = [];
  const repetitionMap = new Map<string, number>();
  for (const capability of input.toolCapabilities) {
    const requirement = input.toolRequirements.get(capability.toolId);
    const route = buildToolRoutePlan(capability, requirement);
    toolRoutes.push(route);
    if (route.authorizationRequirement) {
      authorizationRequirements.push(route.authorizationRequirement);
    }
    repetitionMap.set(capability.toolId, (repetitionMap.get(capability.toolId) ?? 0) + 1);
  }

  // 4. 计算累计风险
  const cumulativeRisk: RiskSnapshot = computeCumulativeRisk(
    toolRoutes,
    repetitionMap,
    input.verifiedCompensation,
  );

  // 5. 计算成本预算
  const totalInputTokens = modelRoutes.reduce((sum, r) => sum + r.estimatedInputTokens, 0);
  const totalOutputTokens = modelRoutes.reduce((sum, r) => sum + r.estimatedOutputTokens, 0);
  const estimatedCostUsd = computeEstimatedCost(modelRoutes, [chosenProvider, ...input.providers]);
  const costBudget: CostBudget = {
    schema: 'awkn-cost-budget/v1',
    estimatedInputTokens: totalInputTokens,
    estimatedOutputTokens: totalOutputTokens,
    estimatedCostUsd,
    budgetCeilingUsd: input.costBudget.budgetCeilingUsd,
    budgetConsumedUsd: input.costBudget.budgetConsumedUsd,
  };

  // 6. 构建 BrokerPlan (排除 planHash / frozenAt)
  const providerChoices: ProviderChoice[] = providerSelection.choices;
  const brokerPlanId = createAwknId('brokerPlan');
  const planWithoutHash: Omit<BrokerPlan, 'planHash' | 'frozenAt'> = {
    schema: 'awkn-broker-plan/v1',
    brokerPlanId,
    executionId: input.executionId,
    modelRoutes,
    toolRoutes,
    providerChoices,
    authorizationRequirements,
    cumulativeRisk,
    costBudget,
  };
  const planHash = computeBrokerPlanHash(planWithoutHash);

  return {
    ...planWithoutHash,
    planHash,
    frozenAt: input.frozenAt,
  };
}

function computeEstimatedCost(
  routes: readonly ModelRoutePlan[],
  providers: readonly ProviderDescriptor[],
): number {
  let total = 0;
  for (const route of routes) {
    const provider = providers.find((p) => p.providerId === route.selectedProviderId);
    if (!provider) continue;
    const model = provider.models.find((m) => m.modelId === route.selectedModelId);
    if (!model) continue;
    total +=
      (route.estimatedInputTokens / 1000) * model.inputCostPer1k +
      (route.estimatedOutputTokens / 1000) * model.outputCostPer1k;
  }
  return total;
}
