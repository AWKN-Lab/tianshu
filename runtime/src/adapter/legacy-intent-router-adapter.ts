/**
 * LegacyIntentRouterAdapter (R2 Shadow Integration Phase 4c)
 *
 * 从 Engine v2 运行时数据中提取 IntentRouterInput（除 schema/inputId/sourceHash/createdAt，
 * 这些由 ExecutionCoordinator 补全）。
 *
 * Engine v2 hook 点：
 * - agent-loop.ts runL1(): LLM response 的 content + toolCalls
 * - Engine v2 没有"显式 intent 路由"，LLM 直接决定是否调用 tool
 *
 * Adapter 推断策略（后置分析器，不是真正的 intent 路由）：
 * - primaryIntent: 从 userInput 提取前 80 字符（截断 + 省略号）
 * - operations: 根据 toolCalls 推断
 *   - 有 toolCalls → ['EXECUTE']（Engine v2 toolCalls 对应 WRITE/SEND/DELETE 等，统一为 EXECUTE 占位）
 *   - 无 toolCalls → ['ANALYZE']（纯文本回复视为分析）
 * - taskKind: 'analysis'（默认，Engine v2 无 task profile 概念）
 * - toolCountHint: toolCalls?.length ?? 0
 * - externalSideEffects: 根据 operations 推断（EXECUTE → true，ANALYZE → false）
 * - 其他字段用合理默认值（iterative=false, multiAgent=false, timeDependency='none' 等）
 *
 * 注意：这是"后置推断"，不是真正的 intent 路由。Shadow Diff 会与真实 IntentRouter 的输出比较。
 * 简化是预期的：Legacy Adapter 反映 Engine v2 的"无 intent 层"架构现实。
 */

import type { IntentOperation, TaskProfileId, TimeDependency } from '../contracts/intent.js';
import type { LegacyAdapterContext, EngineV2InputSnapshot } from './types.js';
import { LegacyAdapterError } from './types.js';

/** IntentRouterInput 中由 Coordinator 补全的字段（schema/inputId/sourceHash/createdAt）外的字段 */
export interface LegacyIntentRouterAdaptation {
  readonly primaryIntent: string;
  readonly secondaryIntents: readonly string[];
  readonly requestedOutcome: string;
  readonly deliverableTypes: readonly string[];
  readonly taskKind: TaskProfileId;
  readonly operations: readonly IntentOperation[];
  readonly toolCountHint: number;
  readonly dependencyCount: number;
  readonly iterative: boolean;
  readonly deterministicAcceptance: boolean;
  readonly multiAgent: boolean;
  readonly externalSideEffects: boolean;
  readonly timeDependency: TimeDependency;
  readonly confidence: number;
  readonly knownFields: readonly string[];
  readonly missingFields: readonly [];
  /** 推断来源（用于 Shadow Diff 分类） */
  readonly inferredFrom: 'llm_tool_calls' | 'llm_content_only' | 'user_input_only';
}

const MAX_PRIMARY_INTENT_LENGTH = 80;

function truncateForIntent(text: string): string {
  if (text.length <= MAX_PRIMARY_INTENT_LENGTH) return text;
  return text.slice(0, MAX_PRIMARY_INTENT_LENGTH - 1) + '…';
}

export function adaptLegacyIntentRouter(
  snapshot: EngineV2InputSnapshot,
  ctx: LegacyAdapterContext,
): LegacyIntentRouterAdaptation {
  const userInput = snapshot.userInput;
  if (userInput.length === 0) {
    throw new LegacyAdapterError(
      'ADAPTER_INPUT_INVALID',
      'userInput is empty (cannot infer primaryIntent)',
      'LegacyIntentRouterAdapter',
      ctx.mode,
    );
  }

  const primaryIntent = truncateForIntent(userInput);
  const llmResponse = snapshot.llmResponse;
  const toolCalls = llmResponse?.toolCalls;
  const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;

  // 推断 operations
  // 注意：IntentOperationSchema 不含 'EXECUTE'，用 'WRITE' 作为 side-effect 占位
  // （Engine v2 toolCalls 通常对应文件写入、命令执行等副作用操作）
  // 纯文本回复视为 ANALYZE
  const operations: readonly IntentOperation[] = hasToolCalls ? ['WRITE'] : ['ANALYZE'];
  const inferredFrom: LegacyIntentRouterAdaptation['inferredFrom'] = hasToolCalls
    ? 'llm_tool_calls'
    : (llmResponse !== undefined ? 'llm_content_only' : 'user_input_only');

  const toolCountHint = toolCalls?.length ?? 0;
  const externalSideEffects = hasToolCalls; // 有 toolCalls 通常意味着外部副作用

  return {
    primaryIntent,
    secondaryIntents: [],
    requestedOutcome: 'a grounded response', // Engine v2 默认目标
    deliverableTypes: ['chat'],
    taskKind: 'analysis',
    operations,
    toolCountHint,
    dependencyCount: 0,
    iterative: false,
    deterministicAcceptance: false,
    multiAgent: false,
    externalSideEffects,
    timeDependency: 'none',
    confidence: 0.5, // 默认中等置信度（Engine v2 无显式 confidence）
    knownFields: [],
    missingFields: [],
    inferredFrom,
  };
}
