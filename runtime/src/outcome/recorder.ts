/**
 * Outcome Recorder (Phase 6 / C08 / WP-AOS-13)
 *
 * 设计文档: `docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md` 第三节
 *
 * 职责：
 * - 在 Run 终态时生成 OutcomeRecord
 * - 五层状态独立计算，禁止合并：
 *   - executionOutcome: 执行层（动作完成情况）
 *   - deliveryOutcome: 交付层（产物送达载体情况）
 *   - adoptionOutcome: 采用层（用户实际采用情况）
 *   - businessOutcome: 业务层（业务目标达成情况）
 *   - learningOutcome: 学习层（产生有价值学习情况）
 * - 默认未观察层为 UNKNOWN（fail-closed）
 * - 执行失败仍可能产生 learningOutcome = SUCCEEDED
 *
 * 关键规则（设计文档 3.1）：
 * - 测试通过 ≠ 用户采用
 * - 文件创建 ≠ 用户下载
 * - 邮件工具返回成功 ≠ 收件人收到
 * - 模型建议完成 ≠ 业务目标达成
 * - 用户采用 ≠ 建议有效
 * - 执行失败仍可能产生有价值学习
 */

import type { ActorRef } from '../contracts/actors.js';
import type { DeliveryBundle } from '../contracts/delivery.js';
import type { EvidenceRecord } from '../contracts/evidence.js';
import type {
  OutcomeAttribution,
  OutcomeRecord,
  OutcomeState,
} from '../contracts/outcome.js';
import { createOutcomeId, DEFAULT_UNOBSERVED_OUTCOME } from '../contracts/outcome.js';
import type { BrokerPlan, ToolExecutionReceipt } from '../contracts/broker.js';
import type { CompiledPolicyBundle } from '../contracts/policy.js';
import type { CompiledSkillBundle } from '../contracts/skill.js';
import { toUtcTimestamp } from '../contracts/time.js';
import { buildRuleBasedAttribution, buildEmptyAttribution, type AttributionInput } from './attribution.js';

/** Outcome Recorder 错误 */
export class OutcomeRecorderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'OutcomeRecorderError';
  }
}

/** Run 终态输入 */
export interface RunFinalState {
  /** Execution ID */
  executionId: string;
  /** Run ID（可选，无 Run 概念时为空） */
  runId?: string;
  /** 执行是否成功（动作完成） */
  executionSucceeded: boolean;
  /** 执行是否部分成功（多个验收项中部分通过） */
  executionPartial?: boolean;
  /** 执行是否被取消 */
  executionCancelled?: boolean;
  /** 交付 Bundle（用于推导 deliveryOutcome） */
  deliveryBundle?: DeliveryBundle;
  /** 用户采用信号（如用户确认、下载、点击等） */
  adoptionSignal?: 'ADOPTED' | 'REJECTED' | 'PARTIAL' | null;
  /** 业务结果信号（如 KPI 达成、目标完成） */
  businessSignal?: 'ACHIEVED' | 'NOT_ACHIEVED' | 'PARTIAL' | null;
  /** 学习结果信号（如产生新经验、新候选规则） */
  learningSignal?: 'LEARNED' | 'NOT_LEARNED' | null;
  /** 证据记录列表 */
  evidenceRecords: EvidenceRecord[];
  /** 观察者 */
  observer: ActorRef;
  /** 观察时间（默认现在） */
  observedAt?: string;
  /** BrokerPlan（用于归因） */
  brokerPlan?: BrokerPlan;
  /** Policy Bundle（用于归因） */
  policyBundle?: CompiledPolicyBundle;
  /** Skill Bundle（用于归因） */
  skillBundle?: CompiledSkillBundle;
  /** Tool Execution Receipts（用于归因） */
  toolReceipts?: ToolExecutionReceipt[];
  /** 显式覆盖归因结果（可选，默认自动构建） */
  attribution?: OutcomeAttribution;
  /** 备注 */
  notes?: string;
}

/**
 * 根据执行结果推导 executionOutcome
 *
 * - executionCancelled → CANCELLED
 * - executionPartial → PARTIAL
 * - executionSucceeded → SUCCEEDED
 * - 否则 → FAILED
 *
 * fail-closed: 无信号 → UNKNOWN
 */
export function deriveExecutionOutcome(state: RunFinalState): OutcomeState {
  if (state.executionCancelled) return 'CANCELLED';
  if (state.executionPartial) return 'PARTIAL';
  if (state.executionSucceeded) return 'SUCCEEDED';
  // 无明确成功/失败信号时，归为 FAILED（终态时必须有明确信号）
  return 'FAILED';
}

/**
 * 根据 DeliveryBundle 推导 deliveryOutcome
 *
 * - 无 Bundle → UNKNOWN（fail-closed，未尝试交付）
 * - Bundle.state=SUCCEEDED → SUCCEEDED
 * - Bundle.state=FAILED → FAILED
 * - Bundle.state=PARTIAL → PARTIAL
 * - Bundle.state=PENDING / RUNNING → PENDING
 *
 * 关键规则：
 * - 文件创建成功但 Bundle FAILED → deliveryOutcome = FAILED（不可合并）
 * - 执行成功但 Bundle 未完成 → deliveryOutcome = PENDING（不可推断为 SUCCEEDED）
 */
export function deriveDeliveryOutcome(bundle: DeliveryBundle | undefined): OutcomeState {
  if (!bundle) return DEFAULT_UNOBSERVED_OUTCOME;
  switch (bundle.state) {
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'PARTIAL':
      return 'PARTIAL';
    case 'PENDING':
    case 'RUNNING':
      return 'PENDING';
    default: {
      // fail-closed: 未知状态归为 UNKNOWN
      const exhaustive: never = bundle.state;
      void exhaustive;
      return DEFAULT_UNOBSERVED_OUTCOME;
    }
  }
}

/**
 * 根据用户采用信号推导 adoptionOutcome
 *
 * - 无信号 → UNKNOWN（fail-closed，未观察到不能推断）
 * - ADOPTED → SUCCEEDED
 * - REJECTED → FAILED
 * - PARTIAL → PARTIAL
 *
 * 关键规则：
 * - 测试通过 ≠ 用户采用
 * - 文件创建 ≠ 用户下载
 * - 执行成功且用户未反馈 → UNKNOWN（不可推断为 SUCCEEDED）
 */
export function deriveAdoptionOutcome(signal: RunFinalState['adoptionSignal']): OutcomeState {
  if (signal === null || signal === undefined) return DEFAULT_UNOBSERVED_OUTCOME;
  switch (signal) {
    case 'ADOPTED':
      return 'SUCCEEDED';
    case 'REJECTED':
      return 'FAILED';
    case 'PARTIAL':
      return 'PARTIAL';
    default: {
      const exhaustive: never = signal;
      void exhaustive;
      return DEFAULT_UNOBSERVED_OUTCOME;
    }
  }
}

/**
 * 根据业务结果信号推导 businessOutcome
 *
 * - 无信号 → UNKNOWN（fail-closed）
 * - ACHIEVED → SUCCEEDED
 * - NOT_ACHIEVED → FAILED
 * - PARTIAL → PARTIAL
 *
 * 关键规则：
 * - 模型建议完成 ≠ 业务目标达成
 * - 用户采用 ≠ 建议有效
 */
export function deriveBusinessOutcome(signal: RunFinalState['businessSignal']): OutcomeState {
  if (signal === null || signal === undefined) return DEFAULT_UNOBSERVED_OUTCOME;
  switch (signal) {
    case 'ACHIEVED':
      return 'SUCCEEDED';
    case 'NOT_ACHIEVED':
      return 'FAILED';
    case 'PARTIAL':
      return 'PARTIAL';
    default: {
      const exhaustive: never = signal;
      void exhaustive;
      return DEFAULT_UNOBSERVED_OUTCOME;
    }
  }
}

/**
 * 根据学习信号推导 learningOutcome
 *
 * - 无信号 → UNKNOWN（fail-closed）
 * - LEARNED → SUCCEEDED（产生有价值学习）
 * - NOT_LEARNED → FAILED
 *
 * 关键规则：
 * - 执行失败仍可能 learningOutcome = SUCCEEDED（从失败中学习）
 * - Delivery 失败可形成 Learning Outcome
 */
export function deriveLearningOutcome(signal: RunFinalState['learningSignal']): OutcomeState {
  if (signal === null || signal === undefined) return DEFAULT_UNOBSERVED_OUTCOME;
  switch (signal) {
    case 'LEARNED':
      return 'SUCCEEDED';
    case 'NOT_LEARNED':
      return 'FAILED';
    default: {
      const exhaustive: never = signal;
      void exhaustive;
      return DEFAULT_UNOBSERVED_OUTCOME;
    }
  }
}

/**
 * 计算 Outcome 总置信度
 *
 * 基于：
 * - 证据数量（更多证据 → 更高置信度）
 * - 是否有归因 bundle
 * - 是否有用户信号
 *
 * 上限 0.95（保留人工审查空间）
 */
export function computeOutcomeConfidence(state: RunFinalState): number {
  let confidence = 0.3; // 基础置信度

  // 证据数量加成
  const evidenceCount = state.evidenceRecords.length;
  if (evidenceCount > 0) {
    confidence += Math.min(0.3, evidenceCount * 0.05);
  }

  // 归因 bundle 加成
  if (state.brokerPlan) confidence += 0.05;
  if (state.policyBundle) confidence += 0.05;
  if (state.skillBundle) confidence += 0.05;
  if (state.toolReceipts && state.toolReceipts.length > 0) confidence += 0.05;

  // 用户信号加成（adoption / business 有明确信号时置信度更高）
  if (state.adoptionSignal) confidence += 0.1;
  if (state.businessSignal) confidence += 0.1;

  return Math.min(0.95, confidence);
}

/**
 * 构建 OutcomeRecord
 *
 * 主流程：
 * 1. 推导五层 Outcome 状态（独立计算，禁止合并）
 * 2. 提取 evidenceIds
 * 3. 计算总置信度
 * 4. 构建归因（若未显式提供）
 * 5. 生成 OutcomeRecord
 *
 * fail-closed:
 * - 无证据 → 抛错（fail-closed: 无证据不能生成 Outcome）
 * - 无 observer → 抛错
 * - 无 executionId → 抛错
 *
 * 关键规则：
 * - 默认 adoptionOutcome / businessOutcome / learningOutcome = UNKNOWN
 * - 执行失败仍可 learningOutcome = SUCCEEDED（若 learningSignal=LEARNED）
 * - Delivery 失败可形成 Learning Outcome（learningSignal=LEARNED 时）
 */
export function buildOutcomeRecord(state: RunFinalState): OutcomeRecord {
  if (!state.executionId) {
    throw new OutcomeRecorderError(
      'executionId is required',
      'MISSING_EXECUTION_ID',
    );
  }
  if (!state.observer) {
    throw new OutcomeRecorderError(
      'observer is required',
      'MISSING_OBSERVER',
    );
  }
  if (state.evidenceRecords.length === 0) {
    throw new OutcomeRecorderError(
      'at least one evidence is required to produce an OutcomeRecord',
      'NO_EVIDENCE',
    );
  }

  // 1. 推导五层状态
  const executionOutcome = deriveExecutionOutcome(state);
  const deliveryOutcome = deriveDeliveryOutcome(state.deliveryBundle);
  const adoptionOutcome = deriveAdoptionOutcome(state.adoptionSignal);
  const businessOutcome = deriveBusinessOutcome(state.businessSignal);
  const learningOutcome = deriveLearningOutcome(state.learningSignal);

  // 2. 提取 evidenceIds（去重）
  const evidenceIds = [...new Set(state.evidenceRecords.map((e) => e.evidenceId))].sort();

  // 3. 计算总置信度
  const confidence = computeOutcomeConfidence(state);

  // 4. 构建归因
  let attribution = state.attribution;
  if (!attribution) {
    const attributionInput: AttributionInput = {
      brokerPlan: state.brokerPlan,
      policyBundle: state.policyBundle,
      skillBundle: state.skillBundle,
      toolReceipts: state.toolReceipts,
      evidenceRecords: state.evidenceRecords,
      executionOutcome,
      deliveryOutcome,
    };
    // 只有在有 bundle 或 evidence 时才构建归因
    const hasAnyContributor = state.brokerPlan
      || state.policyBundle
      || state.skillBundle
      || (state.toolReceipts && state.toolReceipts.length > 0)
      || state.evidenceRecords.length > 0;
    attribution = hasAnyContributor
      ? buildRuleBasedAttribution(attributionInput)
      : buildEmptyAttribution();
  }

  // 5. 生成 OutcomeRecord
  const observedAt = state.observedAt ?? toUtcTimestamp(new Date());
  const record: OutcomeRecord = {
    schema: 'awkn-outcome-record/v1',
    outcomeId: createOutcomeId(),
    executionId: state.executionId,
    executionOutcome,
    deliveryOutcome,
    adoptionOutcome,
    businessOutcome,
    learningOutcome,
    evidenceIds,
    observedAt,
    observer: state.observer,
    confidence,
    attribution,
  };
  if (state.runId !== undefined) {
    record.runId = state.runId;
  }
  if (state.notes !== undefined) {
    record.notes = state.notes;
  }
  return record;
}

/**
 * 查询指定层的 Outcome 状态
 *
 * 用于上层按层查询：
 * ```ts
 * const adoptionState = getOutcomeLayer(record, 'adoptionOutcome');
 * if (adoptionState === 'UNKNOWN') {
 *   // 未观察到用户采用，不可推断为成功
 * }
 * ```
 */
export function getOutcomeLayer(
  record: OutcomeRecord,
  layer: 'executionOutcome' | 'deliveryOutcome' | 'adoptionOutcome' | 'businessOutcome' | 'learningOutcome',
): OutcomeState {
  return record[layer];
}

/**
 * 检查指定层是否成功
 */
export function isLayerSucceeded(
  record: OutcomeRecord,
  layer: 'executionOutcome' | 'deliveryOutcome' | 'adoptionOutcome' | 'businessOutcome' | 'learningOutcome',
): boolean {
  return record[layer] === 'SUCCEEDED';
}

/**
 * 检查指定层是否失败
 */
export function isLayerFailed(
  record: OutcomeRecord,
  layer: 'executionOutcome' | 'deliveryOutcome' | 'adoptionOutcome' | 'businessOutcome' | 'learningOutcome',
): boolean {
  return record[layer] === 'FAILED';
}

/**
 * 检查指定层是否未知（fail-closed 默认状态）
 */
export function isLayerUnknown(
  record: OutcomeRecord,
  layer: 'executionOutcome' | 'deliveryOutcome' | 'adoptionOutcome' | 'businessOutcome' | 'learningOutcome',
): boolean {
  return record[layer] === 'UNKNOWN';
}
