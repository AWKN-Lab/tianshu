/**
 * Agent Loop — L1/L2 循环编排
 *
 * 参考：awkn-agent/src/core/agent-loop-react-cycle.ts（重新实现，不直接抽取）
 *
 * L1 Turn-based：
 *   while (turn < maxTurns):
 *     LLM call → tool dispatch → record observation → reflect → 是否继续
 *
 * L2 Goal-based：
 *   while (goal.state == 'active' && !stopConditionsAchieved):
 *     L1 循环（maxTurns 轮）
 *     → evaluateL2StopConditions（tsc/test/lint/review 4 项）
 *     → recordCycle（记录 token/时长）
 *     → 未达条件 → 反思 + 调整 → 继续
 */

import { createLogger } from './logger.js';
import { createReActState, recordObservation, reflect, shouldReflect, type ReActState } from './react-loop.js';
import { LoopMonitor } from './loop-monitor.js';
import { hookManager } from './hook-manager.js';
import { getLlmRouter } from '../llm/router.js';
import type { ChatMessage, ChatRequest } from '../llm/types.js';
import { toolRegistry } from '../tools/registry.js';
import type { ExecutionContext } from '../tools/types.js';
import { getGoalManager } from '../goal/goal-manager.js';
import { evaluateL2StopConditions, type GateContext, type GateResult } from '../gates/quality-gates.js';
import type { LlmProvider } from '../llm/types.js';
import { getLoopStateManager, type LoopSnapshot } from './loop-state-manager.js';
import { getCorrectionsLedger } from '../evolve/corrections-ledger.js';

const logger = createLogger('AgentLoop');

export interface AgentLoopConfig {
  /** L1 最大轮数（默认 8） */
  maxTurns: number;
  /** L2 最大循环数（默认 50） */
  maxL2Cycles: number;
  /** 工作目录 */
  cwd: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 关联的 goal ID（L2 用） */
  goalId?: string;
  /** gate 上下文 */
  gateCtx?: Partial<GateContext>;
  /** 是否启用 L2 循环（默认 false，纯 L1） */
  enableL2: boolean;
  /** 调用来源 */
  callSource?: string;
  /** 强制指定 LLM provider（跨模型 review 场景用，不传走 router 默认） */
  provider?: LlmProvider;
}

export const DEFAULT_CONFIG: AgentLoopConfig = {
  maxTurns: 8,
  maxL2Cycles: 50,
  cwd: process.cwd(),
  enableL2: false,
};

export interface AgentLoopResult {
  /** 最终输出文本 */
  finalText: string;
  /** ReAct 状态最终快照 */
  reactState: ReActState;
  /** L2 gate 结果（enableL2=true 时有值） */
  l2Results?: GateResult[];
  /** 是否达到 L2 停止条件 */
  l2Achieved?: boolean;
  /** 总轮数 */
  totalTurns: number;
  /** 总 L2 循环数 */
  totalL2Cycles: number;
  /** 总 token 消耗 */
  totalTokens: number;
  /** 是否被 budget/3-strike 终止 */
  terminated: boolean;
  terminationReason?: string;
}

export class AgentLoop {
  private config: AgentLoopConfig;
  private loopMonitor: LoopMonitor;
  private totalTokens = 0;

  constructor(config: Partial<AgentLoopConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.loopMonitor = new LoopMonitor();
  }

  /**
   * 运行 L1 单轮循环
   *
   * 检查点恢复（断点恢复）：
   *   - 当 goalId 存在时，每轮工具执行后保存 checkpoint 到 loop_state 表
   *   - 进程崩溃后可通过 options.resumeFrom 传入快照恢复（messages + turn + tokens + reactState）
   *   - 循环正常结束时清除 checkpoint（标记 terminated，不再 resume）
   *
   * @param userInput 用户输入（resume 模式下可传空字符串，会从 messages 恢复上下文）
   * @param options.resumeFrom 从快照恢复（用于断点恢复）
   */
  async runL1(
    userInput: string,
    options?: { resumeFrom?: LoopSnapshot },
  ): Promise<AgentLoopResult> {
    const resumeFrom = options?.resumeFrom;

    // === 状态初始化（resume 时从快照恢复，否则新建） ===
    // M3 进阶-27（2026-07-23）：原版 const reactState 导致纯函数返回值无法赋值
    //   recordObservation/reflect 都是纯函数（返回新 state，不 mutate）
    //   但原版调用 recordObservation(reactState, ...) / reflect(reactState) 不接 return
    //   → observations/totalObservations/consecutiveErrors/lastReflection 永远不更新
    //   → shouldReflect 永远返回 false（consecutiveErrors=0）→ 反思机制死代码
    //   → reactState.lastReflection 永远 undefined → reflection stop 永远不触发
    //   → "假完成"模式：代码看似在记录观察 + 触发反思，实际什么都不做
    //   修复：改 const → let，接住纯函数返回值
    let reactState = resumeFrom
      ? resumeFrom.reactState
      : createReActState(`session_${Date.now()}`);
    const checkpointId = reactState.conversationId;

    let finalText = resumeFrom?.finalText ?? '';
    let turn = resumeFrom?.turn ?? 0;

    // resume 时恢复累计 token（让 buildResult 返回正确的 totalTokens）
    if (resumeFrom && resumeFrom.totalTokens > 0) {
      this.totalTokens = resumeFrom.totalTokens;
    }

    const messages: ChatMessage[] = resumeFrom?.messages ?? [];
    // 全新对话才注入 system + user 首条消息（resume 时 messages 已包含完整上下文）
    if (messages.length === 0) {
      if (this.config.systemPrompt) {
        messages.push({ role: 'system', content: this.config.systemPrompt });
      }
      messages.push({ role: 'user', content: userInput });
    }

    // === checkpoint 管理辅助闭包（仅 goalId 存在时启用，避免无 L2 上下文时写 DB） ===
    const checkpointMgr = this.config.goalId ? getLoopStateManager() : null;
    const saveCheckpoint = (): void => {
      if (!checkpointMgr) return;
      try {
        checkpointMgr.saveCheckpoint(checkpointId, this.config.goalId ?? null, {
          reactState,
          messages,
          turn,
          totalTokens: this.totalTokens,
          finalText,
          terminated: false,
        });
      } catch (err) {
        // checkpoint 失败不能影响业务逻辑（fail-open，只记日志）
        logger.warn(`Failed to save checkpoint ${checkpointId}: ${String(err)}`);
      }
    };
    const clearCheckpoint = (terminated: boolean, reason?: string): void => {
      if (!checkpointMgr) return;
      try {
        checkpointMgr.clearCheckpoint(checkpointId, terminated, reason);
      } catch (err) {
        logger.warn(`Failed to clear checkpoint ${checkpointId}: ${String(err)}`);
      }
    };

    // M3 进阶-17：记录 loop_monitor 失败到 corrections-ledger（自进化闭环入口）
    // 设计：3-strike / 工具错误 / 重复模式都必须留证据，pattern-detector 据此触发经验沉淀
    const recordLoopFailure = (errorText: string, severity: 'error' | 'fatal' = 'error'): void => {
      try {
        getCorrectionsLedger().record({
          goalId: this.config.goalId,
          source: 'loop_monitor',
          severity,
          errorText,
        });
      } catch (e) {
        // ledger 写入失败不阻断主流程
        logger.warn(`Failed to record loop_monitor correction: ${String(e)}`);
      }
    };

    // 触发 session_start hook（resume 时跳过，避免重复触发）
    if (!resumeFrom) {
      await hookManager.trigger('session_start', {
        point: 'session_start',
        sessionId: reactState.conversationId,
      });
    } else {
      // resume 时立即保存一次 checkpoint：
      //   1. 让本次 resume 留痕（覆盖之前的快照，updated_at 刷新）
      //   2. 保证后续 clearCheckpoint 能找到行（即使 while 循环不进入也能正常标记）
      saveCheckpoint();
    }

    while (turn < this.config.maxTurns) {
      turn++;
      reactState.turn = turn;

      // 触发 user_prompt_submit hook（仅第一轮 + 非resume）
      if (turn === 1 && !resumeFrom) {
        await hookManager.trigger('user_prompt_submit', {
          point: 'user_prompt_submit',
          prompt: userInput,
          sessionId: reactState.conversationId,
        });
      }

      // LLM 调用
      const llmRouter = getLlmRouter();
      const tools = toolRegistry.toFunctionDefinitions();

      const req: ChatRequest = {
        messages,
        tools: tools.length > 0 ? tools.map((t) => ({
          type: 'function' as const,
          function: t,
        })) : undefined,
        callSource: this.config.callSource ?? 'main_dialogue',
        provider: this.config.provider,
      };

      let resp;
      try {
        resp = await llmRouter.chat(req);
      } catch (err) {
        logger.error(`LLM call failed: ${String(err)}`);
        const terminated = this.loopMonitor.recordFailure();
        if (terminated) {
          // M3 进阶-17：记录到 corrections-ledger（自进化闭环入口）
          recordLoopFailure(`LLM 连续失败 3 次: ${String(err)}`, 'fatal');
          // 标记终止：循环已结束，不再 resume
          clearCheckpoint(true, 'LLM 连续失败 3 次');
          return this.buildResult(finalText, reactState, turn, 0, true, 'LLM 连续失败 3 次');
        }
        // 失败也保存 checkpoint：方便崩溃后从断点续传
        saveCheckpoint();
        continue;
      }

      this.totalTokens += resp.usage.totalTokens;
      // M3 进阶-27：原版调用 recordTokenUsage 但不接 return 值
      //   → token 异常增长被检测到 + logged → 但循环不停止 → "假检测"
      //   与 recordFailure/recordToolCall 不一致（那两个都接 return 并终止循环）
      //   修复：接住返回值，异常时终止 + 记录 corrections-ledger
      const tokenAnomaly = this.loopMonitor.recordTokenUsage(resp.usage.totalTokens);
      if (tokenAnomaly) {
        finalText = `[token 异常增长] 最近 3 轮 token 增长超阈值（${this.loopMonitor.getStatus().historyLength} 历史）`;
        recordLoopFailure(`token 异常增长: 最近 3 轮 ratio > ${2.0}, current=${resp.usage.totalTokens}`, 'error');
        clearCheckpoint(true, 'token anomaly');
        return this.buildResult(finalText, reactState, turn, 0, true, 'token anomaly');
      }

      // 有 tool_calls → 执行工具
      if (resp.toolCalls && resp.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: resp.content,
          toolCalls: resp.toolCalls,
        });

        for (const tc of resp.toolCalls) {
          const toolName = tc.function.name;
          const args = JSON.parse(tc.function.arguments);

          // 触发 pre_tool_use hook
          const preResults = await hookManager.trigger('pre_tool_use', {
            point: 'pre_tool_use',
            toolName,
            toolInput: args,
            sessionId: reactState.conversationId,
          });
          const blocked = preResults.some((r) => r.block);
          if (blocked) {
            const blockReason = preResults.find((r) => r.block)?.blockReason ?? 'blocked by hook';
            logger.warn(`Tool ${toolName} blocked: ${blockReason}`);
            messages.push({
              role: 'tool',
              toolCallId: tc.id,
              content: `[blocked by hook] ${blockReason}`,
            });
            continue;
          }

          // 执行工具
          const ctx: ExecutionContext = {
            sessionId: reactState.conversationId,
            userId: 'runtime',
            callSource: 'main_dialogue',
          };

          const startedAt = Date.now();
          let toolResult: string;
          let isError = false;
          let errorMessage: string | undefined;
          try {
            toolResult = await toolRegistry.execute(toolName, args, ctx);
          } catch (err) {
            toolResult = '';
            isError = true;
            errorMessage = err instanceof Error ? err.message : String(err);
            // M3 进阶-17：记录工具执行错误到 corrections-ledger（自进化闭环入口）
            recordLoopFailure(`工具执行失败 ${toolName}: ${errorMessage}`);
          }
          const durationMs = Date.now() - startedAt;

          // 记录观察
          // M3 进阶-27：recordObservation 是纯函数，必须接住返回值更新 reactState
          reactState = recordObservation(reactState, {
            toolName,
            args,
            result: toolResult,
            isError,
            errorMessage,
            durationMs,
          });

          // 触发 post_tool_use hook
          await hookManager.trigger('post_tool_use', {
            point: 'post_tool_use',
            toolName,
            toolOutput: toolResult,
            sessionId: reactState.conversationId,
          });

          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            content: isError ? `[error] ${errorMessage}` : toolResult,
          });

          // 重复模式检测
          const repeated = this.loopMonitor.recordToolCall(toolName);
          if (repeated) {
            logger.warn('Repeating pattern detected, breaking L1 loop');
            finalText = '[循环异常：检测到工具调用重复模式，已终止]';
            // M3 进阶-17：记录重复模式到 corrections-ledger（自进化闭环入口）
            recordLoopFailure(`工具调用重复模式: ${toolName}`, 'fatal');
            clearCheckpoint(true, 'repeating pattern');
            return this.buildResult(finalText, reactState, turn, 0, true, 'repeating pattern');
          }
        }

        // 反思
        // M3 进阶-27：reflect 是纯函数，必须接住返回值更新 reactState
        if (shouldReflect(reactState)) {
          reactState = reflect(reactState);
          if (reactState.lastReflection && !reactState.lastReflection.shouldContinue) {
            finalText = `[reflection stop] ${reactState.lastReflection.reason}`;
            // M3 进阶-27：反思决定停止 → 记录到 corrections-ledger（自进化闭环入口）
            recordLoopFailure(`反思停止: ${reactState.lastReflection.reason}`, 'error');
            clearCheckpoint(true, `reflection stop: ${reactState.lastReflection.reason}`);
            return this.buildResult(finalText, reactState, turn, 0, true, `reflection stop: ${reactState.lastReflection.reason}`);
          }
        }

        // 每轮工具执行后保存 checkpoint（仅 goalId 存在时）
        // — 让进程在 LLM 调用 / 工具执行 / 反思后崩溃都能从断点续传
        saveCheckpoint();
        continue;
      }

      // 无 tool_calls → LLM 产出文本 → 结束
      finalText = resp.content;
      messages.push({ role: 'assistant', content: resp.content });
      this.loopMonitor.recordSuccess();
      break;
    }

    // 触发 session_stop hook（resume 时也触发，标记会话完整结束）
    await hookManager.trigger('session_stop', {
      point: 'session_stop',
      sessionId: reactState.conversationId,
    });

    // 循环结束统一清除 checkpoint：
    // - 正常完成（无 tool_calls break 或 reflection stop）→ terminated=true
    // - while 自然结束（达到 maxTurns）→ terminated=true（虽未达目标但循环已退出）
    // 标记后 loadLatestForGoal 会跳过此 checkpoint（不再 resume）
    const reachedMax = turn >= this.config.maxTurns;
    clearCheckpoint(true, reachedMax ? `达到 L1 最大轮数 ${this.config.maxTurns}` : '循环正常结束');

    return this.buildResult(finalText, reactState, turn, 0, false);
  }

  /** 运行 L2 循环（goal-based） */
  async runL2(userInput: string): Promise<AgentLoopResult> {
    if (!this.config.goalId) {
      throw new Error('L2 循环需要 goalId');
    }

    const goalManager = getGoalManager();
    let totalTurns = 0;
    let l2Cycle = 0;
    let lastFinalText = '';
    let lastReactState = createReActState(`l2_${Date.now()}`);
    // M3 进阶-6（2026-07-23）：token 双计 bug 修复
    // 原版：recordCycle(goalId, l1Result.totalTokens, ...) 传的是 this.totalTokens 累计值，
    //   但 recordCycle 内部是 `consumed.tokens += tokens`（增量累加），
    //   导致 L2 多轮循环时 token 被重复计数（cycle1 计 100，cycle2 计 250 而非 150）→ 预算提前耗尽。
    // 修复：用本轮增量（l1Result.totalTokens - prevCumulativeTokens）传给 recordCycle。
    let prevCumulativeTokens = 0;

    // === 断点恢复：检查该 goal 是否有未完成的 checkpoint ===
    // 仅在第一次循环时检查；后续 L1 调用都从空白开始（前一轮 L1 结束时已 clearCheckpoint）
    let pendingResume: LoopSnapshot | null = null;
    {
      const cp = getLoopStateManager().loadLatestForGoal(this.config.goalId);
      if (cp) {
        logger.info(`L2 检测到未完成的 checkpoint（id=${cp.id}, turn=${cp.snapshot.turn}），将从断点恢复`);
        pendingResume = cp.snapshot;
      }
    }

    while (l2Cycle < this.config.maxL2Cycles) {
      l2Cycle++;
      const goal = goalManager.read(this.config.goalId);
      if (!goal) {
        return this.buildResult(lastFinalText, lastReactState, totalTurns, l2Cycle, true, 'goal 不存在');
      }
      if (goal.state !== 'active') {
        return this.buildResult(lastFinalText, lastReactState, totalTurns, l2Cycle, true, `goal state=${goal.state}`);
      }

      // 跑一轮 L1（首次循环若有 pendingResume 则从快照恢复，之后清空让后续循环走全新 L1）
      const cycleStartedAt = Date.now();
      const l1Result = await this.runL1(
        userInput,
        pendingResume ? { resumeFrom: pendingResume } : undefined,
      );
      pendingResume = null; // 消费一次后清空，后续循环不再 resume
      totalTurns += l1Result.totalTurns;
      lastFinalText = l1Result.finalText;
      lastReactState = l1Result.reactState;

      if (l1Result.terminated) {
        return this.buildResult(lastFinalText, lastReactState, totalTurns, l2Cycle, true, l1Result.terminationReason);
      }

      // 记录 cycle 消耗（用增量 token，避免双计）
      const cycleDurationMs = Date.now() - cycleStartedAt;
      const incrementalTokens = l1Result.totalTokens - prevCumulativeTokens;
      prevCumulativeTokens = l1Result.totalTokens;
      goalManager.recordCycle(this.config.goalId, incrementalTokens, cycleDurationMs);

      // 评估 L2 停止条件
      const gateCtx: GateContext = {
        cwd: this.config.cwd,
        goalId: this.config.goalId,
        ...this.config.gateCtx,
      };
      const l2Eval = await evaluateL2StopConditions(gateCtx);

      if (l2Eval.achieved) {
        goalManager.updateGoal(this.config.goalId, { state: 'achieved' }, 'model');
        logger.info(`L2 achieved after ${l2Cycle} cycles`);
        return this.buildResult(lastFinalText, lastReactState, totalTurns, l2Cycle, false, undefined, l2Eval.results, true);
      }

      logger.info(`L2 cycle ${l2Cycle} not achieved: ${l2Eval.summary}`);
      // 继续下一轮 L1（userInput 保持不变，messages 会重新构造）
    }

    return this.buildResult(lastFinalText, lastReactState, totalTurns, l2Cycle, true, `达到 L2 最大循环数 ${this.config.maxL2Cycles}`);
  }

  private buildResult(
    finalText: string,
    reactState: ReActState,
    totalTurns: number,
    totalL2Cycles: number,
    terminated: boolean,
    terminationReason?: string,
    l2Results?: GateResult[],
    l2Achieved?: boolean,
  ): AgentLoopResult {
    return {
      finalText,
      reactState,
      totalTurns,
      totalL2Cycles,
      totalTokens: this.totalTokens,
      terminated,
      terminationReason,
      l2Results,
      l2Achieved,
    };
  }
}
