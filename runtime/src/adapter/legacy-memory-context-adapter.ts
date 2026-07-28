/**
 * LegacyMemoryContextAdapter (R2 Shadow Integration Phase 4c)
 *
 * 从 Engine v2 运行时数据中提取 ContextPlannerInput（除 schema，由 Coordinator 补全）。
 *
 * Engine v2 hook 点：
 * - agent-loop.ts runL1(): messages 数组（system + user + assistant + tool）
 * - Engine v2 没有"显式 Context Planner"，直接用 messages 数组作为 context
 *
 * Adapter 推断策略（后置分析器）：
 * - plan.query: 从 system prompt 或第一条 user message 提取前 80 字符
 * - plan.contextId: 用 ctx.executionId 派生（确定性，便于 Diff）
 * - plan.executionId: ctx.executionId
 * - plan.tokenBudget: 2000（默认，Engine v2 无显式预算）
 * - plan.allowStale: false（保守默认）
 * - plan.allowedSensitivityClasses: ['internal']（默认）
 * - plan.policyVersion: 'context-policy/v1'
 * - plan.plannerVersion: 'context-planner/v1'
 * - plan.createdAt: ctx.clock()
 * - candidates: []（空，让 ContextPlanner 自行决定）
 *
 * 注意：空 candidates 会导致 ContextManifest.selectedTokenCount=0，这是预期的：
 * Legacy Adapter 反映 Engine v2 的"无 Context Planner 层"架构现实。
 * Shadow Diff 会标记 selectedTokenCount=0 vs 真实值的差异。
 */

import type { ContextPlannerInput } from '../contracts/context.js';
import type { LegacyAdapterContext, EngineV2MemorySnapshot } from './types.js';
import { LegacyAdapterError } from './types.js';

const DEFAULT_TOKEN_BUDGET = 2000;
const DEFAULT_POLICY_VERSION = 'context-policy/v1';
const DEFAULT_PLANNER_VERSION = 'context-planner/v1';
const MAX_QUERY_LENGTH = 80;

function truncateForQuery(text: string): string {
  if (text.length <= MAX_QUERY_LENGTH) return text;
  return text.slice(0, MAX_QUERY_LENGTH - 1) + '…';
}

/**
 * 从 messages 中推断 query（用于 ContextQueryPlan.query）。
 * 优先用 system prompt，其次第一条 user message。
 */
function inferQuery(snapshot: EngineV2MemorySnapshot): { query: string; inferredFrom: string } {
  if (snapshot.systemPrompt && snapshot.systemPrompt.length > 0) {
    return { query: truncateForQuery(snapshot.systemPrompt), inferredFrom: 'system_prompt' };
  }
  for (const msg of snapshot.messages) {
    if (msg.role === 'system' && msg.content.length > 0) {
      return { query: truncateForQuery(msg.content), inferredFrom: 'system_message' };
    }
  }
  for (const msg of snapshot.messages) {
    if (msg.role === 'user' && msg.content.length > 0) {
      return { query: truncateForQuery(msg.content), inferredFrom: 'user_message' };
    }
  }
  throw new LegacyAdapterError(
    'ADAPTER_INPUT_INVALID',
    'cannot infer query: no system prompt or user message in snapshot',
    'LegacyMemoryContextAdapter',
    'shadow',
  );
}

/**
 * 从 executionId 派生 contextId（确定性）。
 * contextId 必须符合 `ctx_<32hex>` 格式。
 * 策略：用 executionId 的 hex 部分（去掉前缀）作为 contextId 的 hex 部分。
 */
function deriveContextId(executionId: string): string {
  // executionId 格式: exec_<32hex>
  // contextId 格式: ctx_<32hex>
  const underscoreIdx = executionId.indexOf('_');
  if (underscoreIdx < 0 || underscoreIdx === executionId.length - 1) {
    // 不合法格式，用 executionId 的简单 hash 作为 fallback
    // 但这不是确定性的跨平台 hash，所以直接抛错（fail-closed）
    throw new LegacyAdapterError(
      'ADAPTER_INPUT_INVALID',
      `executionId format invalid (expected exec_<32hex>): ${executionId}`,
      'LegacyMemoryContextAdapter',
      'shadow',
    );
  }
  const hexPart = executionId.slice(underscoreIdx + 1);
  if (!/^[0-9a-f]{32}$/.test(hexPart)) {
    throw new LegacyAdapterError(
      'ADAPTER_INPUT_INVALID',
      `executionId hex part invalid (expected 32 hex chars): ${hexPart}`,
      'LegacyMemoryContextAdapter',
      'shadow',
    );
  }
  return `ctx_${hexPart}`;
}

export interface LegacyMemoryContextAdaptation {
  /** 与 ContextPlannerInput 兼容的 plan + candidates（不含 schema，由 Coordinator 补全） */
  readonly plan: Omit<ContextPlannerInput['plan'], 'schema'>;
  readonly candidates: readonly [];
  /** 推断来源（用于 Shadow Diff 分类） */
  readonly inferredFrom: string;
}

export function adaptLegacyMemoryContext(
  snapshot: EngineV2MemorySnapshot,
  ctx: LegacyAdapterContext,
): LegacyMemoryContextAdaptation {
  const { query, inferredFrom } = inferQuery(snapshot);
  const contextId = deriveContextId(ctx.executionId);
  const now = ctx.clock();

  return {
    plan: {
      contextId,
      executionId: ctx.executionId,
      query,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      allowStale: false,
      allowedSensitivityClasses: ['internal'],
      policyVersion: DEFAULT_POLICY_VERSION,
      plannerVersion: DEFAULT_PLANNER_VERSION,
      createdAt: now,
    },
    candidates: [],
    inferredFrom,
  };
}
