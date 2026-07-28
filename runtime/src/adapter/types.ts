/**
 * Legacy Adapter 基础类型 (R2 Shadow Integration Phase 4c)
 *
 * 设计原则（授权确认书 §2.1 + 文档 16）：
 * - Adapter 是纯函数（不是 class），从 Engine v2 运行时数据快照中提取 Port 兼容数据
 * - Adapter 不触发副作用（不写 DB、不调用 LLM、不触发 hook、不调用 GoalManager.updateGoal）
 * - Adapter 不持久化；持久化是 EventStore 的工作
 * - Adapter 在 shadow 模式下作为旁路（fail-closed 抛错，由 ShadowExecutor try-catch 隔离）
 * - Adapter 在 enforce 模式下作为权威路径（错误直接传播，阻塞 Execution）
 * - Adapter 输入必须是 Engine v2 已有的运行时数据，不能要求 Engine v2 修改
 *
 * 关键不变量：
 * 1. 相同输入必须产生相同输出（确定性，便于 Diff）
 * 2. 跨平台 Hash 一致（使用 compareByCodePoint 而非 localeCompare）
 * 3. 不读取 process.env / 文件系统 / 数据库（纯函数）
 * 4. 不依赖时钟（clock 由调用方注入）
 */

import type { ChatMessage, ChatResponse } from '../llm/types.js';
import type { Goal } from '../goal/goal-state.js';
import type { GateResult } from '../gates/quality-gates.js';

/**
 * Adapter 模式：
 * - 'shadow'：旁路只读，fail-closed 抛错（由 ShadowExecutor 隔离）
 * - 'enforce'：权威路径，错误直接传播（阻塞 Execution）
 *
 * 注意：'0' 模式不调用 Adapter（ExecutionCoordinator 在 Input flag='0' 时直接返回 RECEIVED）
 */
export type AdapterMode = 'shadow' | 'enforce';

/**
 * Adapter 调用上下文。
 *
 * mode：shadow 或 enforce
 * clock：UTC 时间源（测试时可注入）
 * executionId：当前 Execution ID（用于关联）
 * traceId：W3C-compatible trace ID（与 LLM/Tool/Gate spans 共享）
 */
export interface LegacyAdapterContext {
  readonly mode: AdapterMode;
  readonly clock: () => string;
  readonly executionId: string;
  readonly traceId: string;
}

/**
 * Legacy Adapter 错误类型。
 *
 * code 用于 Shadow Diff 分类（Phase 4d）：
 * - 'ADAPTER_INPUT_INVALID'：Engine v2 输入数据不合法（如 userInput 为空字符串）
 * - 'ADAPTER_CONVERSION_FAILED'：转换逻辑失败（如无法从 LLM 响应推断 intent）
 * - 'ADAPTER_OUTPUT_SCHEMA_INVALID'：输出不符合 Port schema（不应发生，是 Adapter bug）
 */
export class LegacyAdapterError extends Error {
  constructor(
    public readonly code: 'ADAPTER_INPUT_INVALID' | 'ADAPTER_CONVERSION_FAILED' | 'ADAPTER_OUTPUT_SCHEMA_INVALID',
    message: string,
    public readonly adapterName: string,
    public readonly mode: AdapterMode,
  ) {
    super(`[${adapterName}][${mode}] ${code}: ${message}`);
    this.name = 'LegacyAdapterError';
  }
}

/**
 * Engine v2 输入数据快照。
 *
 * 用于 LegacyInputAdapter 和 LegacyIntentRouterAdapter。
 * - userInput：用户原始输入（来自 messages 中 role='user' 的最后一条）
 * - messages：Engine v2 完整 messages 数组（用于提取 system prompt 和历史）
 * - llmResponse：LLM 响应（用于 LegacyIntentRouterAdapter 推断 intent）
 *
 * 注意：llmResponse 可选，因为 LegacyInputAdapter 不需要它
 */
export interface EngineV2InputSnapshot {
  readonly userInput: string;
  readonly messages: readonly ChatMessage[];
  readonly llmResponse?: ChatResponse;
}

/**
 * Engine v2 Memory 数据快照。
 *
 * 用于 LegacyMemoryContextAdapter。
 * - messages：Engine v2 messages 数组（system + user + assistant + tool）
 * - systemPrompt：系统提示词（如果单独提供）
 * - goalId：当前 Goal ID（可选，用于关联 ContextManifest）
 *
 * 注意：executionId 来自 LegacyAdapterContext（由 ExecutionCoordinator 生成，保证合法格式）
 */
export interface EngineV2MemorySnapshot {
  readonly messages: readonly ChatMessage[];
  readonly systemPrompt?: string;
  readonly goalId?: string;
}

/**
 * Engine v2 Goal 数据快照。
 *
 * 用于 LegacyGoalManagerAdapter。
 * - goal：Engine v2 GoalManager 中的 Goal 对象
 * - runId：当前 Run ID
 * - gateResults：质量门禁结果（用于推断 GoalJudgement.verdict）
 * - judgeVersion：GoalJudge 版本（如 'awkn-goal-judge/v1'）
 */
export interface EngineV2GoalSnapshot {
  readonly goal: Goal;
  readonly runId: string;
  readonly gateResults: readonly GateResult[];
  readonly judgeVersion: string;
}
