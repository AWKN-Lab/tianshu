/**
 * Outcome Recorder (Phase 6 / C08 / WP-AOS-13)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第三、四节
 *
 * 职责：
 * - 协调五层结果记录（执行/交付/采用/业务/学习）
 * - 维护每个 executionId 的部分结果状态（in-memory）
 * - 在 finalize 时通过 zod schema 验证并生成 hash
 * - 提供 rule_based 归因构建器（设计文档第四节，P0）
 *
 * 五层独立性（设计文档 3.1）：
 * - executionOutcome: 执行完成
 * - deliveryOutcome: 交付完成
 * - adoptionOutcome: 用户采用（UNKNOWN 允许）
 * - businessOutcome: 业务结果（UNKNOWN 允许）
 * - learningOutcome: 学习结果（UNKNOWN 允许，执行失败仍可能产生学习）
 *
 * 禁止合并的状态（设计文档 3.1）：
 * - 测试通过 ≠ 用户采用
 * - 文件创建 ≠ 用户下载
 * - 邮件工具成功 ≠ 收件人收到
 * - 模型建议完成 ≠ 业务目标达成
 * - 用户采用 ≠ 建议有效
 * - 执行失败仍可能产生有价值学习
 *
 * 状态约束（已在 contract schema 中冻结）：
 * - executionOutcome=SUCCEEDED → learningOutcome 不能是 FAILED
 * - executionOutcome=FAILED → deliveryOutcome 不能是 SUCCEEDED
 * - adoptionOutcome=SUCCEEDED → deliveryOutcome 必须 SUCCEEDED
 * - businessOutcome=SUCCEEDED → adoptionOutcome 必须 SUCCEEDED
 * - executionOutcome=CANCELLED → businessOutcome 只能是 UNKNOWN 或 CANCELLED
 */

import type {
  OutcomeRecord,
  OutcomeAttribution,
  OutcomeState,
} from '../contracts/outcome.js';
import type { ActorRef } from '../contracts/actors.js';
import {
  OutcomeRecordSchema,
  OutcomeAttributionSchema,
  createOutcomeId,
  computeOutcomeRecordHash,
} from '../contracts/outcome.js';
import { toUtcTimestamp } from '../contracts/time.js';

// ===== Types =====

/**
 * 部分结果状态（五层结果的中间态）。
 * 每个 executionId 对应一个 PartialOutcome，在 finalize 前可逐层更新。
 */
interface PartialOutcome {
  readonly executionId: string;
  runId?: string;
  executionOutcome: OutcomeState;
  deliveryOutcome: OutcomeState;
  adoptionOutcome: OutcomeState;
  businessOutcome: OutcomeState;
  learningOutcome: OutcomeState;
  evidenceIds: string[];
  attribution?: OutcomeAttribution;
}

/**
 * 归因贡献者（用于构建 rule_based 归因）。
 */
export interface AttributionContributor {
  readonly ref: string;
  /** 省略时均分权重；提供时所有 contributor 必须同时提供 */
  readonly weight?: number;
  readonly role?: string;
  readonly kind: 'claim' | 'policy' | 'skill' | 'model' | 'tool';
}

// ===== Internal Helpers =====

function createPartialOutcome(executionId: string): PartialOutcome {
  return {
    executionId,
    executionOutcome: 'PENDING',
    deliveryOutcome: 'PENDING',
    adoptionOutcome: 'UNKNOWN',
    businessOutcome: 'UNKNOWN',
    learningOutcome: 'UNKNOWN',
    evidenceIds: [],
  };
}

function mergeEvidence(existing: string[], addition: ReadonlyArray<string>): string[] {
  if (addition.length === 0) return existing;
  const set = new Set(existing);
  for (const id of addition) set.add(id);
  return [...set];
}

/**
 * 计算结果观察的置信度（基于已确定层数 / 总层数）。
 * PENDING 和 UNKNOWN 视为"未确定"，降低置信度。
 */
function computeConfidence(partial: PartialOutcome): number {
  let determined = 0;
  if (partial.executionOutcome !== 'PENDING' && partial.executionOutcome !== 'UNKNOWN') determined += 1;
  if (partial.deliveryOutcome !== 'PENDING' && partial.deliveryOutcome !== 'UNKNOWN') determined += 1;
  if (partial.adoptionOutcome !== 'PENDING' && partial.adoptionOutcome !== 'UNKNOWN') determined += 1;
  if (partial.businessOutcome !== 'PENDING' && partial.businessOutcome !== 'UNKNOWN') determined += 1;
  if (partial.learningOutcome !== 'PENDING' && partial.learningOutcome !== 'UNKNOWN') determined += 1;
  return determined / 5;
}

function toWeightedRef(
  ref: string,
  weight: number,
  role?: string,
): { ref: string; weight: number; role?: string } {
  return role ? { ref, weight, role } : { ref, weight };
}

// ===== Attribution Builder =====

/**
 * 构建 rule_based 归因（设计文档第四节）。
 *
 * 规则：
 * - 若所有 contributor 均省略 weight，则均分权重（1/n）
 * - 若所有 contributor 均提供 weight，则校验总和（容差 0.01），不满足时自动归一化
 * - 不允许混合（部分提供、部分省略）
 * - 至少需要一个 contributor
 * - method 固定为 'rule_based'
 *
 * @param contributors 贡献者列表
 * @returns 归一化并通过 schema 验证的 OutcomeAttribution
 */
export function buildRuleBasedAttribution(
  contributors: ReadonlyArray<AttributionContributor>,
): OutcomeAttribution {
  if (contributors.length === 0) {
    throw new Error('attribution requires at least one contributor');
  }

  const weights = contributors.map((c) => c.weight);
  const allDefined = weights.every((w) => w !== undefined);
  const allUndefined = weights.every((w) => w === undefined);

  if (!allDefined && !allUndefined) {
    throw new Error('cannot mix weighted and unweighted contributors; provide weights for all or none');
  }

  let normalizedWeights: number[];

  if (allUndefined) {
    const equal = 1 / contributors.length;
    normalizedWeights = contributors.map(() => equal);
  } else {
    const rawWeights = weights.map((w) => w as number);
    const sum = rawWeights.reduce((acc, w) => acc + w, 0);
    if (sum === 0) {
      throw new Error('attribution weights cannot all be zero');
    }
    if (Math.abs(sum - 1) > 0.01) {
      // 自动归一化
      normalizedWeights = rawWeights.map((w) => w / sum);
    } else {
      normalizedWeights = rawWeights;
    }
  }

  const indexed = contributors.map((c, i) => ({
    ref: c.ref,
    weight: normalizedWeights[i],
    role: c.role,
    kind: c.kind,
  }));

  const attribution: OutcomeAttribution = {
    contributingClaims: indexed
      .filter((c) => c.kind === 'claim')
      .map((c) => toWeightedRef(c.ref, c.weight, c.role)),
    contributingPolicies: indexed
      .filter((c) => c.kind === 'policy')
      .map((c) => toWeightedRef(c.ref, c.weight, c.role)),
    contributingSkills: indexed
      .filter((c) => c.kind === 'skill')
      .map((c) => toWeightedRef(c.ref, c.weight, c.role)),
    contributingModels: indexed
      .filter((c) => c.kind === 'model')
      .map((c) => toWeightedRef(c.ref, c.weight, c.role)),
    contributingTools: indexed
      .filter((c) => c.kind === 'tool')
      .map((c) => toWeightedRef(c.ref, c.weight, c.role)),
    confidence: 0.8,
    method: 'rule_based',
  };

  return OutcomeAttributionSchema.parse(attribution);
}

// ===== Outcome Recorder =====

/**
 * Outcome Recorder（设计文档第三节）。
 *
 * 协调五层结果的记录、验证和最终化。
 * 维护 in-memory 状态，支持幂等记录和提前拒绝非法状态转换。
 *
 * 五层结果相互独立，不可合并（设计文档 3.1）。
 */
export class OutcomeRecorder {
  private readonly partials = new Map<string, PartialOutcome>();
  private readonly finalized = new Map<string, OutcomeRecord>();

  /**
   * 记录执行层结果。
   * 其他层默认为 PENDING/UNKNOWN，可后续逐层更新。
   *
   * 幂等：同一 executionId + 'execution' + state 视为 no-op（evidence 仍会合并）。
   */
  recordExecutionOutcome(
    executionId: string,
    state: OutcomeState,
    evidence?: ReadonlyArray<string>,
  ): void {
    const partial = this.getOrCreatePartial(executionId);
    if (partial.executionOutcome === state) {
      if (evidence && evidence.length > 0) {
        partial.evidenceIds = mergeEvidence(partial.evidenceIds, evidence);
      }
      return;
    }
    // 约束：执行成功时学习不能是 FAILED
    if (state === 'SUCCEEDED' && partial.learningOutcome === 'FAILED') {
      throw new Error('execution cannot succeed when learning outcome is FAILED');
    }
    partial.executionOutcome = state;
    if (evidence && evidence.length > 0) {
      partial.evidenceIds = mergeEvidence(partial.evidenceIds, evidence);
    }
  }

  /**
   * 记录交付层结果。
   * 交付成功要求执行成功（设计文档 3.1：文件创建 ≠ 用户下载）。
   */
  recordDeliveryOutcome(
    executionId: string,
    deliveryState: OutcomeState,
    evidence?: ReadonlyArray<string>,
  ): void {
    const partial = this.getOrCreatePartial(executionId);
    if (partial.deliveryOutcome === deliveryState) {
      if (evidence && evidence.length > 0) {
        partial.evidenceIds = mergeEvidence(partial.evidenceIds, evidence);
      }
      return;
    }
    // 约束：执行失败时交付不能成功
    if (deliveryState === 'SUCCEEDED' && partial.executionOutcome === 'FAILED') {
      throw new Error('delivery cannot succeed when execution failed');
    }
    partial.deliveryOutcome = deliveryState;
    if (evidence && evidence.length > 0) {
      partial.evidenceIds = mergeEvidence(partial.evidenceIds, evidence);
    }
  }

  /**
   * 记录用户采用层结果。
   * 采用成功要求交付成功（设计文档 3.1：测试通过 ≠ 用户采用）。
   */
  recordAdoptionOutcome(
    executionId: string,
    adoptionState: OutcomeState,
    evidence?: ReadonlyArray<string>,
  ): void {
    const partial = this.getOrCreatePartial(executionId);
    if (partial.adoptionOutcome === adoptionState) {
      if (evidence && evidence.length > 0) {
        partial.evidenceIds = mergeEvidence(partial.evidenceIds, evidence);
      }
      return;
    }
    // 约束：交付未成功时采用不能成功
    if (adoptionState === 'SUCCEEDED' && partial.deliveryOutcome !== 'SUCCEEDED') {
      throw new Error('adoption cannot succeed when delivery is not SUCCEEDED');
    }
    partial.adoptionOutcome = adoptionState;
    if (evidence && evidence.length > 0) {
      partial.evidenceIds = mergeEvidence(partial.evidenceIds, evidence);
    }
  }

  /**
   * 记录业务结果层。
   * 业务成功要求采用成功（设计文档 3.1：模型建议 ≠ 业务目标达成）。
   * 执行取消时业务结果只能是 UNKNOWN 或 CANCELLED。
   */
  recordBusinessOutcome(
    executionId: string,
    businessState: OutcomeState,
    evidence?: ReadonlyArray<string>,
  ): void {
    const partial = this.getOrCreatePartial(executionId);
    if (partial.businessOutcome === businessState) {
      if (evidence && evidence.length > 0) {
        partial.evidenceIds = mergeEvidence(partial.evidenceIds, evidence);
      }
      return;
    }
    // 约束：采用未成功时业务不能成功
    if (businessState === 'SUCCEEDED' && partial.adoptionOutcome !== 'SUCCEEDED') {
      throw new Error('business outcome cannot succeed without adoption');
    }
    // 约束：执行取消时业务只能是 UNKNOWN 或 CANCELLED
    if (
      partial.executionOutcome === 'CANCELLED'
      && businessState !== 'UNKNOWN'
      && businessState !== 'CANCELLED'
    ) {
      throw new Error('cancelled execution cannot have non-UNKNOWN/CANCELLED business outcome');
    }
    partial.businessOutcome = businessState;
    if (evidence && evidence.length > 0) {
      partial.evidenceIds = mergeEvidence(partial.evidenceIds, evidence);
    }
  }

  /**
   * 记录学习结果层。
   * 执行成功时学习不能是 FAILED；执行失败仍可能产生学习（设计文档测试 10）。
   */
  recordLearningOutcome(
    executionId: string,
    learningState: OutcomeState,
    evidence?: ReadonlyArray<string>,
  ): void {
    const partial = this.getOrCreatePartial(executionId);
    if (partial.learningOutcome === learningState) {
      if (evidence && evidence.length > 0) {
        partial.evidenceIds = mergeEvidence(partial.evidenceIds, evidence);
      }
      return;
    }
    // 约束：执行成功时学习不能是 FAILED
    if (learningState === 'FAILED' && partial.executionOutcome === 'SUCCEEDED') {
      throw new Error('learning outcome cannot be FAILED when execution succeeded');
    }
    partial.learningOutcome = learningState;
    if (evidence && evidence.length > 0) {
      partial.evidenceIds = mergeEvidence(partial.evidenceIds, evidence);
    }
  }

  /**
   * 附加归因（验证权重总和 = 1.0，容差 0.01）。
   * 在 finalize 前调用，或直接传给 finalizeOutcome。
   */
  attachAttribution(executionId: string, attribution: OutcomeAttribution): void {
    const partial = this.getOrCreatePartial(executionId);
    const validated = OutcomeAttributionSchema.parse(attribution);
    partial.attribution = validated;
  }

  /**
   * 设置 runId（可选，用于关联执行运行）。
   */
  setRunId(executionId: string, runId: string): void {
    const partial = this.getOrCreatePartial(executionId);
    partial.runId = runId;
  }

  /**
   * 最终化结果记录。
   *
   * 构建 OutcomeRecord，通过 OutcomeRecordSchema 验证（fail-closed），
   * 计算 hash（computeOutcomeRecordHash），并缓存到 finalized map。
   *
   * @param executionId 执行 ID
   * @param observer 观察者
   * @param attribution 可选归因；若提供则覆盖之前 attachAttribution 的值
   * @returns 验证通过的 OutcomeRecord
   */
  finalizeOutcome(
    executionId: string,
    observer: ActorRef,
    attribution?: OutcomeAttribution,
  ): OutcomeRecord {
    const partial = this.partials.get(executionId);
    if (!partial) {
      throw new Error(`no outcome recorded for execution ${executionId}`);
    }

    const finalAttribution = attribution ?? partial.attribution;
    if (attribution) {
      OutcomeAttributionSchema.parse(attribution);
    }

    const draft: OutcomeRecord = {
      schema: 'awkn-outcome-record/v1',
      outcomeId: createOutcomeId(),
      executionId: partial.executionId,
      ...(partial.runId ? { runId: partial.runId } : {}),
      executionOutcome: partial.executionOutcome,
      deliveryOutcome: partial.deliveryOutcome,
      adoptionOutcome: partial.adoptionOutcome,
      businessOutcome: partial.businessOutcome,
      learningOutcome: partial.learningOutcome,
      evidenceIds: [...partial.evidenceIds],
      observedAt: toUtcTimestamp(new Date()),
      observer,
      confidence: computeConfidence(partial),
      ...(finalAttribution ? { attribution: finalAttribution } : {}),
    };

    const record = OutcomeRecordSchema.parse(draft) as OutcomeRecord;
    const { outcomeId: _omit, ...content } = record;
    void _omit;
    const hash = computeOutcomeRecordHash(content);
    void hash;

    this.finalized.set(executionId, record);
    return record;
  }

  /**
   * 获取已最终化的结果记录。
   * @returns 已最终化的 OutcomeRecord，或 undefined（未最终化）
   */
  getOutcome(executionId: string): OutcomeRecord | undefined {
    return this.finalized.get(executionId);
  }

  /**
   * 获取当前部分结果状态（只读快照，用于检查进度）。
   * 返回深拷贝以防止外部修改。
   */
  getPartialOutcome(executionId: string): Readonly<PartialOutcome> | undefined {
    const partial = this.partials.get(executionId);
    if (!partial) return undefined;
    return {
      ...partial,
      evidenceIds: [...partial.evidenceIds],
    };
  }

  private getOrCreatePartial(executionId: string): PartialOutcome {
    let partial = this.partials.get(executionId);
    if (!partial) {
      partial = createPartialOutcome(executionId);
      this.partials.set(executionId, partial);
    }
    return partial;
  }
}
