/**
 * Outcome Attribution Builder (Phase 6 / C08 / WP-AOS-13)
 *
 * 设计文档: `docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md` 第四节
 *
 * P0 采用规则型归因（rule_based）：
 * - 从 ExecutionResult + BrokerPlan + Policy/Skill Bundle + Tool Receipts 中提取贡献者
 * - 每个贡献者附上权重 [0, 1]
 * - 计算总置信度
 *
 * 后续阶段（P1+）会增加反事实评测（counterfactual）。
 *
 * 关键规则：
 * - contributing* 数组中 ref 不能重复
 * - refType 必须与字段匹配
 * - confidence 不超过整体 confidence
 */

import type {
  OutcomeAttribution,
  OutcomeState,
  WeightedRef,
} from '../contracts/outcome.js';
import type { BrokerPlan, ToolExecutionReceipt } from '../contracts/broker.js';
import type { CompiledPolicyBundle } from '../contracts/policy.js';
import type { CompiledSkillBundle } from '../contracts/skill.js';
import type { EvidenceRecord } from '../contracts/evidence.js';

/** Attribution Builder 错误 */
export class OutcomeAttributionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'OutcomeAttributionError';
  }
}

/** Attribution Builder 输入 */
export interface AttributionInput {
  /** BrokerPlan（用于提取 model/tool 贡献） */
  brokerPlan?: BrokerPlan;
  /** CompiledPolicyBundle（用于提取 policy 贡献） */
  policyBundle?: CompiledPolicyBundle;
  /** CompiledSkillBundle（用于提取 skill 贡献） */
  skillBundle?: CompiledSkillBundle;
  /** Tool Execution Receipts（用于提取 tool 实际贡献） */
  toolReceipts?: ToolExecutionReceipt[];
  /** Evidence Records（用于提取 claim 贡献） */
  evidenceRecords?: EvidenceRecord[];
  /** 执行结果状态（影响权重计算） */
  executionOutcome: OutcomeState;
  /** 交付结果状态（影响权重计算） */
  deliveryOutcome: OutcomeState;
}

/**
 * P0 规则型归因权重默认值
 *
 * - 执行成功时：所有贡献者均分基础权重
 * - 执行失败时：tool 权重提升（用于定位失败工具）
 * - 交付失败时：tool 权重提升（用于定位交付失败原因）
 */
export const DEFAULT_ATTRIBUTION_WEIGHTS = {
  /** Claim 基础权重（每条证据贡献） */
  claimBase: 0.5,
  /** Policy 基础权重 */
  policyBase: 0.7,
  /** Skill 基础权重 */
  skillBase: 0.6,
  /** Model 基础权重 */
  modelBase: 0.6,
  /** Tool 基础权重 */
  toolBase: 0.7,
  /** 失败时 tool 权重提升 */
  toolFailureBoost: 0.3,
  /** 失败时 model 权重提升 */
  modelFailureBoost: 0.2,
  /** 单个贡献者最大权重 */
  maxWeight: 1.0,
  /** 单个贡献者最小权重 */
  minWeight: 0.1,
} as const;

/** 归因方法版本 */
export const ATTRIBUTION_BUILDER_VERSION = 'awkn-outcome-attribution-builder/v1';

/**
 * Clamp 权重到 [min, max]
 */
function clampWeight(value: number, min = DEFAULT_ATTRIBUTION_WEIGHTS.minWeight, max = DEFAULT_ATTRIBUTION_WEIGHTS.maxWeight): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 从 EvidenceRecord 列表中提取所有 claim ID（去重）
 */
function extractClaimIds(evidenceRecords: readonly EvidenceRecord[]): string[] {
  const claimIds = new Set<string>();
  for (const evidence of evidenceRecords) {
    for (const claimId of evidence.claimIds) {
      claimIds.add(claimId);
    }
  }
  return [...claimIds].sort();
}

/**
 * 从 BrokerPlan 中提取所有 model ID（去重）
 */
function extractModelIds(brokerPlan: BrokerPlan): string[] {
  const modelIds = new Set<string>();
  for (const route of brokerPlan.modelRoutes) {
    modelIds.add(`${route.selectedProviderId}/${route.selectedModelId}`);
  }
  return [...modelIds].sort();
}

/**
 * 从 ToolExecutionReceipt 列表中提取所有 tool ID（去重）
 */
function extractToolIds(toolReceipts: readonly ToolExecutionReceipt[]): string[] {
  const toolIds = new Set<string>();
  for (const receipt of toolReceipts) {
    toolIds.add(receipt.toolId);
  }
  return [...toolIds].sort();
}

/**
 * 从 CompiledPolicyBundle 中提取所有 policy ID
 */
function extractPolicyIds(policyBundle: CompiledPolicyBundle): string[] {
  return policyBundle.policies.map((p) => p.policyId).sort();
}

/**
 * 从 CompiledSkillBundle 中提取所有 skill ID
 */
function extractSkillIds(skillBundle: CompiledSkillBundle): string[] {
  return skillBundle.selectedSkills.map((s) => s.skillId).sort();
}

/**
 * 计算 P0 规则型归因
 *
 * 步骤：
 * 1. 从各 bundle 中提取贡献者 ID
 * 2. 根据执行/交付结果分配权重
 * 3. 失败时提升相关贡献者权重（用于诊断）
 * 4. 计算总置信度
 *
 * 权重规则：
 * - 执行失败时：tool 权重 +0.3，model 权重 +0.2（用于定位失败原因）
 * - 交付失败时：tool 权重 +0.3
 * - 执行成功时：所有贡献者基础权重
 *
 * 置信度规则：
 * - 基础 0.5
 * - 有 evidenceRecords → +0.2
 * - 有 brokerPlan → +0.1
 * - 有 policyBundle → +0.1
 * - 有 skillBundle → +0.1
 * - 上限 0.95（保留人工审查空间）
 */
export function buildRuleBasedAttribution(input: AttributionInput): OutcomeAttribution {
  const isExecutionFailed = input.executionOutcome === 'FAILED' || input.executionOutcome === 'PARTIAL';
  const isDeliveryFailed = input.deliveryOutcome === 'FAILED' || input.deliveryOutcome === 'PARTIAL';
  const isAnyFailed = isExecutionFailed || isDeliveryFailed;

  // 提取贡献者 ID
  const claimIds = input.evidenceRecords ? extractClaimIds(input.evidenceRecords) : [];
  const policyIds = input.policyBundle ? extractPolicyIds(input.policyBundle) : [];
  const skillIds = input.skillBundle ? extractSkillIds(input.skillBundle) : [];
  const modelIds = input.brokerPlan ? extractModelIds(input.brokerPlan) : [];
  const toolIds = input.toolReceipts ? extractToolIds(input.toolReceipts) : [];

  // 构建 WeightedRef
  const contributingClaims: WeightedRef[] = claimIds.map((id) => ({
    ref: id,
    refType: 'claim' as const,
    weight: clampWeight(DEFAULT_ATTRIBUTION_WEIGHTS.claimBase),
    reason: 'evidence-supported claim contributing to outcome',
  }));

  const contributingPolicies: WeightedRef[] = policyIds.map((id) => ({
    ref: id,
    refType: 'policy' as const,
    weight: clampWeight(DEFAULT_ATTRIBUTION_WEIGHTS.policyBase),
    reason: 'active policy governing the execution',
  }));

  const contributingSkills: WeightedRef[] = skillIds.map((id) => ({
    ref: id,
    refType: 'skill' as const,
    weight: clampWeight(DEFAULT_ATTRIBUTION_WEIGHTS.skillBase),
    reason: 'selected skill applied to the execution',
  }));

  const contributingModels: WeightedRef[] = modelIds.map((id) => ({
    ref: id,
    refType: 'model' as const,
    weight: clampWeight(
      DEFAULT_ATTRIBUTION_WEIGHTS.modelBase
      + (isExecutionFailed ? DEFAULT_ATTRIBUTION_WEIGHTS.modelFailureBoost : 0),
    ),
    reason: isExecutionFailed
      ? 'model contributing to failed execution (under review)'
      : 'model selected for execution',
  }));

  const contributingTools: WeightedRef[] = toolIds.map((id) => ({
    ref: id,
    refType: 'tool' as const,
    weight: clampWeight(
      DEFAULT_ATTRIBUTION_WEIGHTS.toolBase
      + (isAnyFailed ? DEFAULT_ATTRIBUTION_WEIGHTS.toolFailureBoost : 0),
    ),
    reason: isAnyFailed
      ? 'tool involved in failed outcome (under review)'
      : 'tool executed during the run',
  }));

  // 计算置信度
  let confidence = 0.5;
  if (claimIds.length > 0) confidence += 0.2;
  if (modelIds.length > 0) confidence += 0.1;
  if (policyIds.length > 0) confidence += 0.1;
  if (skillIds.length > 0) confidence += 0.1;
  confidence = Math.min(0.95, confidence);

  const attribution: OutcomeAttribution = {
    schema: 'awkn-outcome-attribution/v1',
    contributingClaims,
    contributingPolicies,
    contributingSkills,
    contributingModels,
    contributingTools,
    confidence,
    method: 'rule_based',
    explanation: `P0 rule-based attribution: ${claimIds.length} claims, ${policyIds.length} policies, ${skillIds.length} skills, ${modelIds.length} models, ${toolIds.length} tools${isAnyFailed ? ' (failure-aware boost applied)' : ''}`,
  };
  return attribution;
}

/**
 * 构建空归因（无任何贡献者时使用）
 *
 * 用于 ExecutionResult 中没有任何 bundle 信息的场景。
 * confidence 极低（0.1）表示归因质量差。
 */
export function buildEmptyAttribution(reason = 'no contributors available'): OutcomeAttribution {
  return {
    schema: 'awkn-outcome-attribution/v1',
    contributingClaims: [],
    contributingPolicies: [],
    contributingSkills: [],
    contributingModels: [],
    contributingTools: [],
    confidence: 0.1,
    method: 'rule_based',
    explanation: `empty attribution: ${reason}`,
  };
}
