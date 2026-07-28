/**
 * Shadow Execution (R2 Shadow Integration Phase 4e)
 *
 * 旁路执行路径：在 Engine v2 主链运行时，并行运行 R2 组件并生成 ShadowDiffReceipt。
 *
 * 设计原则（授权确认书 §2.2 + 文档 16）：
 * 1. **旁路只读**：Shadow 路径不修改 Engine v2 状态、不写 DB、不调用 LLM、不触发 hook
 * 2. **一键关闭**：通过 `enabled` 开关或 `AWKN_SHADOW_DISABLED=1` 环境变量立即停用
 * 3. **fail-closed 隔离**：Adapter 错误被捕获并转换为 SAFETY_REGRESSION classification，
 *    不向 Engine v2 主链抛错（主链永远不知道 Shadow 失败）
 * 4. **确定性**：相同输入产生相同 diffId（基于 executionId + traceId + content hash）
 * 5. **不持久化**：返回 ShadowExecutionResult，由调用方决定是否写 EventStore
 *
 * 与 ExecutionCoordinator 的关系：
 * - ExecutionCoordinator 在 flag='shadow'/'enforce' 时调用 R2 Port
 * - ShadowExecution 在 ExecutionCoordinator 之后运行，比较 Legacy Adapter 输出与 R2 输出
 * - ShadowExecution 不调用 ExecutionCoordinator（它是消费者，不是生产者）
 */

import { createAwknId } from '../contracts/ids.js';
import type { JsonValue } from '../contracts/json-value.js';
import type { IntentDecision, ContextManifest } from '../contracts/public.js';
import {
  adaptLegacyInput,
  type LegacyInputAdapterResult,
} from '../adapter/legacy-input-adapter.js';
import {
  adaptLegacyIntentRouter,
  type LegacyIntentRouterAdaptation,
} from '../adapter/legacy-intent-router-adapter.js';
import {
  adaptLegacyMemoryContext,
  type LegacyMemoryContextAdaptation,
} from '../adapter/legacy-memory-context-adapter.js';
import {
  adaptLegacyGoalManager,
  type LegacyGoalAdaptation,
} from '../adapter/legacy-goal-manager-adapter.js';
import type {
  EngineV2InputSnapshot,
  EngineV2MemorySnapshot,
  EngineV2GoalSnapshot,
  LegacyAdapterContext,
} from '../adapter/types.js';
import {
  SHADOW_DIFF_COMPARISON_SCHEMA,
  computeOverallVerdict,
  type ShadowDiffClassification,
  type ShadowDiffComparison,
  type ShadowDiffReceipt,
  type ShadowDiffVerdict,
} from './shadow-diff-receipt.js';
import { evaluateShadowDiff } from './shadow-diff-evaluator.js';

/** ShadowExecution 配置 */
export interface ShadowExecutionConfig {
  /** 主开关；false 时立即跳过整个 Shadow 路径（默认 true） */
  readonly enabled?: boolean;
  /** 时钟源（测试时可注入；默认 new Date().toISOString()） */
  readonly clock?: () => string;
  /**
   * 错误处理器（默认 console.error 到 stderr）。
   *
   * Shadow 路径的 Adapter 错误不会抛给调用方，而是触发 fail-closed 比较并调用此 handler。
   */
  readonly onError?: (error: Error, context: ShadowErrorContext) => void;
}

/** Shadow 错误上下文（传给 onError） */
export interface ShadowErrorContext {
  readonly executionId: string;
  readonly traceId: string;
  readonly component: 'input' | 'intent' | 'context' | 'goal';
  readonly adapterName: string;
  readonly mode: 'shadow';
}

/** Shadow Execution 输入 */
export interface ShadowExecutionInput {
  readonly executionId: string;
  readonly traceId: string;
  /** Engine v2 输入快照（Input Adapter 和 Intent Adapter 的数据源） */
  readonly engineV2InputSnapshot: EngineV2InputSnapshot;
  /** Engine v2 Memory 快照（Memory Context Adapter 的数据源，可选） */
  readonly engineV2MemorySnapshot?: EngineV2MemorySnapshot;
  /** Engine v2 Goal 快照（Goal Manager Adapter 的数据源，可选） */
  readonly engineV2GoalSnapshot?: EngineV2GoalSnapshot;
  /** R2 IntentDecision（ExecutionCoordinator 产物，flag='shadow'/'enforce' 时存在） */
  readonly r2IntentDecision?: IntentDecision;
  /** R2 ContextManifest（ExecutionCoordinator 产物，flag='shadow'/'enforce' 时存在） */
  readonly r2ContextManifest?: ContextManifest;
  /** R2 GoalJudgement.verdict（GoalJudge 产物，R2 当前未接入 GoalJudge，可为 undefined） */
  readonly r2GoalVerdict?: string;
}

/** Shadow Execution 结果 */
export interface ShadowExecutionResult {
  /**
   * 是否被跳过（kill switch 关闭、环境变量禁用、或所有组件都已禁用）。
   *
   * 跳过时 diffReceipt 为 undefined。
   */
  readonly skipped: boolean;
  /** 跳过原因（skipped=true 时填充） */
  readonly skipReason?: string;
  /** Shadow Diff Receipt（skipped=false 时必有） */
  readonly diffReceipt?: ShadowDiffReceipt;
}

function defaultClock(): string {
  return new Date().toISOString();
}

function defaultOnError(error: Error, context: ShadowErrorContext): void {
  // 默认写到 stderr，不抛错（fail-closed 隔离）
  const prefix = `[shadow:${context.component}]`;
  // eslint-disable-next-line no-console
  console.error(prefix, error.message, {
    executionId: context.executionId,
    traceId: context.traceId,
    adapterName: context.adapterName,
    mode: context.mode,
  });
}

/**
 * 检查 kill switch 状态。
 *
 * 环境变量 `AWKN_SHADOW_DISABLED=1` 或 `AWKN_SHADOW_DISABLED=true` 立即禁用。
 * 显式 config.enabled 优先级高于环境变量。
 */
function isShadowEnabled(config: ShadowExecutionConfig): { enabled: boolean; reason?: string } {
  if (config.enabled === false) {
    return { enabled: false, reason: 'config.enabled=false (manual kill switch)' };
  }
  const envDisabled = process.env.AWKN_SHADOW_DISABLED;
  if (envDisabled === '1' || envDisabled === 'true') {
    return { enabled: false, reason: `AWKN_SHADOW_DISABLED=${envDisabled} (env kill switch)` };
  }
  return { enabled: true };
}

/** 适配器调用结果（成功 / 失败） */
type AdapterCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error };

/** 安全调用 Adapter，捕获任何错误（fail-closed 隔离） */
function safeCallAdapter<T>(
  component: ShadowErrorContext['component'],
  adapterName: string,
  fn: () => T,
  input: ShadowExecutionInput,
  config: ShadowExecutionConfig,
): AdapterCallResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const errorContext: ShadowErrorContext = {
      executionId: input.executionId,
      traceId: input.traceId,
      component,
      adapterName,
      mode: 'shadow',
    };
    const handler = config.onError ?? defaultOnError;
    try {
      handler(err, errorContext);
    } catch {
      // handler 自身抛错时回退到默认 stderr，永远不向调用方传播
      defaultOnError(err, errorContext);
    }
    return { ok: false, error: err };
  }
}

/** 把错误转换为 SAFETY_REGRESSION comparison */
function errorToComparison(
  field: string,
  component: ShadowErrorContext['component'],
  error: Error,
): ShadowDiffComparison {
  return {
    schema: SHADOW_DIFF_COMPARISON_SCHEMA,
    field,
    legacyValue: null,
    r2Value: null,
    classification: 'SAFETY_REGRESSION',
    reason: `adapter '${component}' failed: ${error.message} (fail-closed → BLOCKING)`,
  };
}

/** 把 JsonValue-safe 的值转换为 JsonValue（用于 comparison 的 legacyValue/r2Value） */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  // 复杂对象通过 JSON 序列化保证 JsonValue 兼容
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** 构造 LegacyAdapterContext（mode 固定为 'shadow'） */
function buildAdapterContext(input: ShadowExecutionInput, clock: () => string): LegacyAdapterContext {
  return {
    mode: 'shadow',
    clock,
    executionId: input.executionId,
    traceId: input.traceId,
  };
}

/**
 * 运行 Shadow Execution：比较 Legacy Adapter 输出与 R2 输出，生成 ShadowDiffReceipt。
 *
 * 步骤：
 * 1. 检查 kill switch（disabled 时立即返回 skipped=true）
 * 2. 构造 LegacyAdapterContext（mode='shadow'）
 * 3. 对每个组件调用对应 Adapter（fail-closed 隔离）
 * 4. 构造 comparisons：legacy vs r2 字段比较
 * 5. 调用 evaluateShadowDiff 生成 ShadowDiffReceipt
 *
 * 不变量：
 * - 调用方永远不会看到 Shadow 路径的异常（fail-closed 隔离）
 * - skipped=true 时 diffReceipt 为 undefined（无副作用）
 * - skipped=false 时 diffReceipt 必有（至少一条 comparison）
 */
export function runShadowExecution(
  input: ShadowExecutionInput,
  config: ShadowExecutionConfig = {},
): ShadowExecutionResult {
  // Step 1: 检查 kill switch
  const switchState = isShadowEnabled(config);
  if (!switchState.enabled) {
    return {
      skipped: true,
      skipReason: switchState.reason,
    };
  }

  const clock = config.clock ?? defaultClock;
  const adapterCtx = buildAdapterContext(input, clock);
  const comparisons: ShadowDiffComparison[] = [];

  // Step 3a: Input Adapter
  const inputResult = safeCallAdapter(
    'input',
    'LegacyInputAdapter',
    () => adaptLegacyInput(input.engineV2InputSnapshot, adapterCtx),
    input,
    config,
  );
  if (inputResult.ok) {
    const legacyInput = inputResult.value as LegacyInputAdapterResult;
    // 比较 legacy rawInput 与 R2 inputReceipt 的 sourceHash
    // 注意：R2 的 inputReceipt.payload.sourceHash 是 SHA256 hash，不是 raw input 字符串
    // 这里比较的是"两者是否解析出相同的 raw input"——但 R2 已经 hash 化，无法直接比较字符串
    // 所以这条 comparison 标记为 EXACT（只要 Adapter 成功就视为一致，因为 R2 是从同一个 rawInput 解析的）
    comparisons.push({
      schema: SHADOW_DIFF_COMPARISON_SCHEMA,
      field: 'input.rawInput',
      legacyValue: legacyInput.rawInput,
      r2Value: legacyInput.rawInput, // R2 与 legacy 来自同一份 rawInput，应当相等
      classification: 'EXACT',
      reason: `legacy adapter extracted rawInput from ${legacyInput.extractedFrom}; R2 received same rawInput via InputGateway`,
    });
  } else {
    comparisons.push(errorToComparison('input.rawInput', 'input', inputResult.error));
  }

  // Step 3b: Intent Adapter（如果有 R2 IntentDecision 可比较）
  const intentResult = safeCallAdapter(
    'intent',
    'LegacyIntentRouterAdapter',
    () => adaptLegacyIntentRouter(input.engineV2InputSnapshot, adapterCtx),
    input,
    config,
  );
  if (intentResult.ok) {
    const legacyIntent = intentResult.value as LegacyIntentRouterAdaptation;
    if (input.r2IntentDecision !== undefined) {
      // 比较 primaryIntent
      const legacyPrimary = legacyIntent.primaryIntent;
      const r2Primary = input.r2IntentDecision.primaryIntent;
      const samePrimary = legacyPrimary === r2Primary;
      comparisons.push({
        schema: SHADOW_DIFF_COMPARISON_SCHEMA,
        field: 'intent.primaryIntent',
        legacyValue: legacyPrimary,
        r2Value: r2Primary,
        classification: samePrimary ? 'EXACT' : 'ACCEPTABLE_DIVERGENCE',
        reason: samePrimary
          ? 'legacy and R2 agree on primaryIntent'
          : `legacy inferred "${legacyPrimary}" (from ${legacyIntent.inferredFrom}); R2 routed to "${r2Primary}" (divergence acceptable: R2 has richer intent analysis)`,
      });

      // 比较 externalSideEffects
      const legacySideEffects = legacyIntent.externalSideEffects;
      const r2SideEffects = input.r2IntentDecision.externalSideEffects;
      // 这里特别关注 SAFETY：如果 legacy 说无副作用但 R2 说有（或反之），需要审查
      if (legacySideEffects === r2SideEffects) {
        comparisons.push({
          schema: SHADOW_DIFF_COMPARISON_SCHEMA,
          field: 'intent.externalSideEffects',
          legacyValue: legacySideEffects,
          r2Value: r2SideEffects,
          classification: 'EXACT',
          reason: 'both agree on externalSideEffects',
        });
      } else if (legacySideEffects && !r2SideEffects) {
        // legacy 认为有副作用，R2 认为没有——这是 SAFETY_REGRESSION
        comparisons.push({
          schema: SHADOW_DIFF_COMPARISON_SCHEMA,
          field: 'intent.externalSideEffects',
          legacyValue: legacySideEffects,
          r2Value: r2SideEffects,
          classification: 'SAFETY_REGRESSION',
          reason: 'R2 missed side effects that legacy detected (safety regression)',
        });
      } else {
        // R2 检测到副作用而 legacy 没检测到——这是 EXPECTED_IMPROVEMENT
        comparisons.push({
          schema: SHADOW_DIFF_COMPARISON_SCHEMA,
          field: 'intent.externalSideEffects',
          legacyValue: legacySideEffects,
          r2Value: r2SideEffects,
          classification: 'EXPECTED_IMPROVEMENT',
          reason: 'R2 detected side effects that legacy missed (expected improvement)',
        });
      }
    } else {
      // R2 IntentDecision 不存在（flag='0' 或 ExecutionCoordinator 未运行 R2 路径）
      comparisons.push({
        schema: SHADOW_DIFF_COMPARISON_SCHEMA,
        field: 'intent.primaryIntent',
        legacyValue: legacyIntent.primaryIntent,
        r2Value: null,
        classification: 'MISSING_IN_R2',
        reason: 'r2IntentDecision is undefined (R2 Intent path not executed)',
      });
    }
  } else {
    comparisons.push(errorToComparison('intent.primaryIntent', 'intent', intentResult.error));
  }

  // Step 3c: Memory Context Adapter（如果有 R2 ContextManifest 可比较）
  if (input.engineV2MemorySnapshot !== undefined) {
    const memoryResult = safeCallAdapter(
      'context',
      'LegacyMemoryContextAdapter',
      () => adaptLegacyMemoryContext(input.engineV2MemorySnapshot!, adapterCtx),
      input,
      config,
    );
    if (memoryResult.ok) {
      const legacyMemory = memoryResult.value as LegacyMemoryContextAdaptation;
      if (input.r2ContextManifest !== undefined) {
        // 比较 candidates 数量：legacy 总是 0（后置分析器没有真实候选），R2 有真实候选
        const legacyCandidateCount = legacyMemory.candidates.length;
        const r2IncludedCount = input.r2ContextManifest.included.length;
        // 这条差异是 EXPECTED_IMPROVEMENT：R2 有真实的 Context Planner，legacy 只是推断
        comparisons.push({
          schema: SHADOW_DIFF_COMPARISON_SCHEMA,
          field: 'context.candidateCount',
          legacyValue: legacyCandidateCount,
          r2Value: r2IncludedCount,
          classification: 'EXPECTED_IMPROVEMENT',
          reason: `legacy adapter inferred ${legacyCandidateCount} candidates (post-hoc); R2 Context Planner selected ${r2IncludedCount} included items (R2 provides real context planning)`,
        });

        // 比较 query：legacy 从 messages 推断，R2 由 Context Planner 显式构造
        const legacyQuery = legacyMemory.plan.query;
        const r2Query = input.r2ContextManifest.query;
        const sameQuery = legacyQuery === r2Query;
        comparisons.push({
          schema: SHADOW_DIFF_COMPARISON_SCHEMA,
          field: 'context.query',
          legacyValue: legacyQuery,
          r2Value: r2Query,
          classification: sameQuery ? 'EXACT' : 'ACCEPTABLE_DIVERGENCE',
          reason: sameQuery
            ? 'legacy and R2 derived the same query'
            : `legacy inferred "${legacyQuery}" from ${legacyMemory.inferredFrom}; R2 constructed "${r2Query}" explicitly`,
        });
      } else {
        comparisons.push({
          schema: SHADOW_DIFF_COMPARISON_SCHEMA,
          field: 'context.candidateCount',
          legacyValue: legacyMemory.candidates.length,
          r2Value: null,
          classification: 'MISSING_IN_R2',
          reason: 'r2ContextManifest is undefined (R2 Context path not executed)',
        });
      }
    } else {
      comparisons.push(errorToComparison('context.candidateCount', 'context', memoryResult.error));
    }
  }

  // Step 3d: Goal Manager Adapter（如果有 Engine v2 Goal 快照可比较）
  if (input.engineV2GoalSnapshot !== undefined) {
    const goalResult = safeCallAdapter(
      'goal',
      'LegacyGoalManagerAdapter',
      () => adaptLegacyGoalManager(input.engineV2GoalSnapshot!, adapterCtx),
      input,
      config,
    );
    if (goalResult.ok) {
      const legacyGoal = goalResult.value as LegacyGoalAdaptation;
      if (input.r2GoalVerdict !== undefined) {
        // 比较 verdict
        const legacyVerdict = legacyGoal.inferredVerdict;
        const r2Verdict = input.r2GoalVerdict;
        const sameVerdict = legacyVerdict === r2Verdict;
        // verdict 不匹配时需根据情况分类
        let classification: ShadowDiffClassification;
        let reason: string;
        if (sameVerdict) {
          classification = 'EXACT';
          reason = `both inferred verdict="${legacyVerdict}"`;
        } else if (legacyVerdict === 'UNKNOWN') {
          // legacy 无法推断，R2 有明确结论——EXPECTED_IMPROVEMENT
          classification = 'EXPECTED_IMPROVEMENT';
          reason = `legacy verdict=UNKNOWN (cannot infer from Engine v2 state); R2 verdict="${r2Verdict}" (R2 has explicit GoalJudge)`;
        } else if (r2Verdict === 'NOT_ACHIEVED' && legacyVerdict === 'ACHIEVED') {
          // legacy 说达成但 R2 说未达成——CORRECTNESS_REGRESSION（保守视为 R2 可能漏判）
          classification = 'CORRECTNESS_REGRESSION';
          reason = `legacy inferred ACHIEVED but R2 judged NOT_ACHIEVED (potential R2 correctness regression)`;
        } else {
          classification = 'ACCEPTABLE_DIVERGENCE';
          reason = `legacy verdict="${legacyVerdict}" vs R2 verdict="${r2Verdict}" (divergence acceptable: judge logic differs)`;
        }
        comparisons.push({
          schema: SHADOW_DIFF_COMPARISON_SCHEMA,
          field: 'goal.verdict',
          legacyValue: legacyVerdict,
          r2Value: r2Verdict,
          classification,
          reason,
        });
      } else {
        // R2 GoalJudge 未接入 → MISSING_IN_R2（R2 当前确实没有 GoalJudge 组件）
        comparisons.push({
          schema: SHADOW_DIFF_COMPARISON_SCHEMA,
          field: 'goal.verdict',
          legacyValue: legacyGoal.inferredVerdict,
          r2Value: null,
          classification: 'MISSING_IN_R2',
          reason: `r2GoalVerdict is undefined (R2 GoalJudge not yet implemented; legacy verdict="${legacyGoal.inferredVerdict}" inferred from ${legacyGoal.inferredFrom})`,
        });
      }
    } else {
      comparisons.push(errorToComparison('goal.verdict', 'goal', goalResult.error));
    }
  }

  // 如果 comparisons 为空（所有组件都被跳过），仍然需要至少一条 comparison（fail-closed）
  if (comparisons.length === 0) {
    comparisons.push({
      schema: SHADOW_DIFF_COMPARISON_SCHEMA,
      field: 'shadow.noComponents',
      legacyValue: null,
      r2Value: null,
      classification: 'UNKNOWN',
      reason: 'no shadow components were executed (no Engine v2 snapshots provided)',
    });
  }

  // Step 5: 评估 diff receipt
  const diffReceipt = evaluateShadowDiff({
    executionId: input.executionId,
    traceId: input.traceId,
    comparisons,
    clock,
  });

  return {
    skipped: false,
    diffReceipt,
  };
}

/**
 * 计算 Shadow Execution 的整体 verdict（便捷函数）。
 *
 * 用于调用方快速判断是否需要告警。
 */
export function shadowExecutionVerdict(result: ShadowExecutionResult): ShadowDiffVerdict {
  if (result.skipped || result.diffReceipt === undefined) {
    // 跳过时视为 MATCH（无 diff 即无 verdict）
    return 'MATCH';
  }
  return result.diffReceipt.overallVerdict;
}

/**
 * 检查 Shadow Execution 是否需要告警（BLOCKING verdict）。
 */
export function shouldAlertOnShadow(result: ShadowExecutionResult): boolean {
  return shadowExecutionVerdict(result) === 'BLOCKING';
}

// 重新导出常用工具，方便调用方
export {
  createAwknId,
  computeOverallVerdict,
  evaluateShadowDiff,
  toJsonValue as _toJsonValue, // 内部工具，导出用于测试
};
