/**
 * Legacy Adapter Public API (R2 Shadow Integration Phase 4c)
 *
 * 导出 4 个 Legacy Adapter：
 * - LegacyInputAdapter：Engine v2 userInput → rawInput
 * - LegacyIntentRouterAdapter：Engine v2 LLM response → IntentRouterInput
 * - LegacyMemoryContextAdapter：Engine v2 messages → ContextPlannerInput
 * - LegacyGoalManagerAdapter：Engine v2 Goal state → GoalJudgement 推断
 *
 * 使用方式：
 * ```typescript
 * import { adaptLegacyInput, adaptLegacyIntentRouter, adaptLegacyMemoryContext, adaptLegacyGoalManager } from './adapter/public.js';
 *
 * const inputResult = adaptLegacyInput(inputSnapshot, ctx);
 * const intentResult = adaptLegacyIntentRouter(intentSnapshot, ctx);
 * const memoryResult = adaptLegacyMemoryContext(memorySnapshot, ctx);
 * const goalResult = adaptLegacyGoalManager(goalSnapshot, ctx);
 * ```
 *
 * 所有 Adapter 都是纯函数：
 * - 不触发副作用（不写 DB、不调用 LLM、不触发 hook）
 * - 不持久化（持久化是 ExecutionCoordinator / EventStore 的工作）
 * - fail-closed（输入非法时抛 LegacyAdapterError）
 * - 确定性（相同输入相同输出，便于 Shadow Diff）
 */

export * from './types.js';
export * from './legacy-input-adapter.js';
export * from './legacy-intent-router-adapter.js';
export * from './legacy-memory-context-adapter.js';
export * from './legacy-goal-manager-adapter.js';
