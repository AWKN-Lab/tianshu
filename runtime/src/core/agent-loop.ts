import { createLogger } from './logger.js';
import { createReActState, recordObservation, reflect, shouldReflect, type ReActState } from './react-loop.js';
import { LoopMonitor } from './loop-monitor.js';
import { hookManager } from './hook-manager.js';
import { getLlmRouter } from '../llm/router.js';
import type { ChatMessage, ChatRequest, LlmProvider } from '../llm/types.js';
import { toolRegistry } from '../tools/registry.js';
import type { ExecutionContext } from '../tools/types.js';
import { getGoalManager } from '../goal/goal-manager.js';
import {
  budgetGate,
  lintGate,
  recordGateFailures,
  testGate,
  typecheckGate,
  type GateContext,
  type GateResult,
} from '../gates/quality-gates.js';
import { parseStrictReviewVerdict } from '../gates/review-verdict.js';
import { getLoopStateManager, type LoopSnapshot } from './loop-state-manager.js';
import { getCorrectionsLedger } from '../evolve/corrections-ledger.js';
import { collectArtifactBundle } from '../evidence/artifact-bundle.js';
import { getEventStore } from '../workflow/event-store.js';

const logger = createLogger('AgentLoop');

export interface AgentLoopConfig {
  maxTurns: number;
  maxL2Cycles: number;
  cwd: string;
  systemPrompt?: string;
  goalId?: string;
  gateCtx?: Partial<GateContext>;
  enableL2: boolean;
  callSource?: string;
  provider?: LlmProvider;
  reviewProvider?: LlmProvider;
  reviewPrompt?: string;
  approvedTools?: string[];
}

export const DEFAULT_CONFIG: AgentLoopConfig = {
  maxTurns: 8,
  maxL2Cycles: 50,
  cwd: process.cwd(),
  enableL2: false,
};

export interface AgentLoopResult {
  finalText: string;
  reactState: ReActState;
  l2Results?: GateResult[];
  l2Achieved?: boolean;
  totalTurns: number;
  totalL2Cycles: number;
  totalTokens: number;
  terminated: boolean;
  terminationReason?: string;
}

export class AgentLoop {
  private config: AgentLoopConfig;
  private loopMonitor = new LoopMonitor();
  private totalTokens = 0;

  constructor(config: Partial<AgentLoopConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async runL1(userInput: string, options?: { resumeFrom?: LoopSnapshot }): Promise<AgentLoopResult> {
    const resumeFrom = options?.resumeFrom;
    if (!resumeFrom) this.loopMonitor.reset();

    let reactState = resumeFrom?.reactState ?? createReActState(`session_${Date.now()}`);
    let finalText = resumeFrom?.finalText ?? '';
    let turn = resumeFrom?.turn ?? 0;
    if (resumeFrom && resumeFrom.totalTokens > this.totalTokens) this.totalTokens = resumeFrom.totalTokens;

    const messages: ChatMessage[] = resumeFrom?.messages ? [...resumeFrom.messages] : [];
    if (messages.length === 0) {
      if (this.config.systemPrompt) messages.push({ role: 'system', content: this.config.systemPrompt });
      messages.push({ role: 'user', content: userInput });
    }

    const checkpointManager = this.config.goalId ? getLoopStateManager() : null;
    const checkpointId = reactState.conversationId;
    const saveCheckpoint = (): void => {
      if (!checkpointManager) return;
      try {
        checkpointManager.saveCheckpoint(checkpointId, this.config.goalId ?? null, {
          reactState,
          messages,
          turn,
          totalTokens: this.totalTokens,
          finalText,
          terminated: false,
        });
      } catch (err) {
        logger.warn(`Failed to save checkpoint: ${String(err)}`);
      }
    };
    const clearCheckpoint = (reason: string): void => {
      try { checkpointManager?.clearCheckpoint(checkpointId, true, reason); } catch { /* audit failure must not mask result */ }
    };
    const recordFailure = (errorText: string, severity: 'error' | 'fatal' = 'error'): void => {
      try {
        getCorrectionsLedger().record({
          goalId: this.config.goalId,
          source: 'loop_monitor',
          severity,
          errorText,
        });
      } catch { /* evidence write remains fail-open */ }
    };
    const stopSession = async (): Promise<void> => {
      await hookManager.trigger('session_stop', {
        point: 'session_stop',
        sessionId: reactState.conversationId,
      }).catch(() => []);
    };
    const terminate = async (reason: string, text = finalText): Promise<AgentLoopResult> => {
      finalText = text;
      clearCheckpoint(reason);
      await stopSession();
      return this.buildResult(finalText, reactState, turn, 0, true, reason);
    };

    if (!resumeFrom) {
      await hookManager.trigger('session_start', {
        point: 'session_start',
        sessionId: reactState.conversationId,
      });
    } else {
      saveCheckpoint();
    }

    while (turn < this.config.maxTurns) {
      turn++;
      reactState.turn = turn;
      if (turn === 1 && !resumeFrom) {
        await hookManager.trigger('user_prompt_submit', {
          point: 'user_prompt_submit',
          prompt: userInput,
          sessionId: reactState.conversationId,
        });
      }

      const request: ChatRequest = {
        messages,
        tools: toolRegistry.toFunctionDefinitions().map((tool) => ({ type: 'function' as const, function: tool })),
        callSource: this.config.callSource ?? 'main_dialogue',
        provider: this.config.provider,
      };

      let response;
      try {
        response = await getLlmRouter().chat(request);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`LLM call failed: ${message}`);
        if (this.loopMonitor.recordFailure()) {
          recordFailure(`LLM 连续失败 3 次: ${message}`, 'fatal');
          return terminate('LLM 连续失败 3 次');
        }
        saveCheckpoint();
        continue;
      }

      this.totalTokens += response.usage.totalTokens;
      if (this.loopMonitor.recordTokenUsage(response.usage.totalTokens)) {
        recordFailure(`token 异常增长: current=${response.usage.totalTokens}`);
        return terminate('token anomaly', '[token 异常增长，循环已终止]');
      }

      if (response.toolCalls?.length) {
        messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.function.name;
          let args: Record<string, unknown>;
          try {
            const parsed = JSON.parse(toolCall.function.arguments) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments must be an object');
            args = parsed as Record<string, unknown>;
          } catch (err) {
            const errorMessage = `Invalid tool arguments for ${toolName}: ${String(err)}`;
            messages.push({ role: 'tool', toolCallId: toolCall.id, content: `[error] ${errorMessage}` });
            reactState = recordObservation(reactState, {
              toolName,
              args: {},
              result: '',
              isError: true,
              errorMessage,
              durationMs: 0,
            });
            recordFailure(errorMessage);
            continue;
          }

          const preResults = await hookManager.trigger('pre_tool_use', {
            point: 'pre_tool_use',
            toolName,
            toolInput: args,
            sessionId: reactState.conversationId,
          });
          const blocker = preResults.find((result) => result.block);
          if (blocker) {
            const blockReason = blocker.blockReason ?? 'blocked by hook';
            messages.push({ role: 'tool', toolCallId: toolCall.id, content: `[blocked] ${blockReason}` });
            continue;
          }

          const context: ExecutionContext = {
            sessionId: reactState.conversationId,
            userId: 'runtime',
            callSource: (this.config.callSource ?? 'main_dialogue') as ExecutionContext['callSource'],
            workspaceRoot: this.config.cwd,
            approvedToolNames: this.config.approvedTools,
          };
          const startedAt = Date.now();
          let toolResult = '';
          let isError = false;
          let errorMessage: string | undefined;
          try {
            toolResult = await toolRegistry.execute(toolName, args, context);
            this.loopMonitor.recordSuccess();
          } catch (err) {
            isError = true;
            errorMessage = err instanceof Error ? err.message : String(err);
            recordFailure(`工具执行失败 ${toolName}: ${errorMessage}`);
            this.loopMonitor.recordFailure();
          }

          reactState = recordObservation(reactState, {
            toolName,
            args,
            result: toolResult,
            isError,
            errorMessage,
            durationMs: Date.now() - startedAt,
          });
          await hookManager.trigger('post_tool_use', {
            point: 'post_tool_use',
            toolName,
            toolOutput: toolResult,
            sessionId: reactState.conversationId,
          });
          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: isError ? `[error] ${errorMessage}` : toolResult,
          });

          if (this.loopMonitor.recordToolCall(toolName)) {
            recordFailure(`工具调用重复模式: ${toolName}`, 'fatal');
            return terminate('repeating pattern', '[循环异常：检测到工具调用重复模式，已终止]');
          }
        }

        if (shouldReflect(reactState)) {
          reactState = reflect(reactState);
          if (reactState.lastReflection && !reactState.lastReflection.shouldContinue) {
            const reason = `reflection stop: ${reactState.lastReflection.reason}`;
            recordFailure(reason);
            return terminate(reason, `[reflection stop] ${reactState.lastReflection.reason}`);
          }
        }
        saveCheckpoint();
        continue;
      }

      finalText = response.content;
      messages.push({ role: 'assistant', content: response.content });
      this.loopMonitor.recordSuccess();
      break;
    }

    const reachedMax = turn >= this.config.maxTurns && !finalText;
    clearCheckpoint(reachedMax ? `达到 L1 最大轮数 ${this.config.maxTurns}` : '循环正常结束');
    await stopSession();
    return this.buildResult(finalText, reactState, turn, 0, reachedMax, reachedMax ? `达到 L1 最大轮数 ${this.config.maxTurns}` : undefined);
  }

  async runL2(userInput: string): Promise<AgentLoopResult> {
    if (!this.config.goalId) throw new Error('L2 循环需要 goalId');

    const goalManager = getGoalManager();
    const eventStore = getEventStore();
    const run = eventStore.createRun({
      goalId: this.config.goalId,
      workflowName: 'agent-loop-l2',
      payload: { userInput, provider: this.config.provider, reviewProvider: this.resolveReviewProvider() },
    });
    eventStore.transitionRun(run.id, 'running');

    let totalTurns = 0;
    let cycle = 0;
    let previousCycleTokens = this.totalTokens;
    let repairContext = '';
    let lastFinalText = '';
    let lastReactState = createReActState(`l2_${Date.now()}`);
    let lastResults: GateResult[] = [];

    const pending = getLoopStateManager().loadLatestForGoal(this.config.goalId);
    let pendingResume = pending?.snapshot;

    while (cycle < this.config.maxL2Cycles) {
      cycle++;
      const cycleStartedAt = Date.now();
      const goal = goalManager.read(this.config.goalId);
      if (!goal || goal.state !== 'active') {
        const reason = goal ? `goal state=${goal.state}` : 'goal 不存在';
        eventStore.transitionRun(run.id, 'failed', { reason });
        return this.buildResult(lastFinalText, lastReactState, totalTurns, cycle, true, reason, lastResults, false);
      }

      eventStore.appendEvent(run.id, 'l2.cycle.started', { cycle, repairContext });
      const cycleInput = repairContext
        ? `${userInput}\n\n上一轮未通过证据与修复要求：\n${repairContext}`
        : userInput;
      const l1Result = await this.runL1(cycleInput, pendingResume ? { resumeFrom: pendingResume } : undefined);
      pendingResume = undefined;
      totalTurns += l1Result.totalTurns;
      lastFinalText = l1Result.finalText;
      lastReactState = l1Result.reactState;

      if (l1Result.terminated) {
        eventStore.transitionRun(run.id, 'failed', { reason: l1Result.terminationReason, cycle });
        return this.buildResult(lastFinalText, lastReactState, totalTurns, cycle, true, l1Result.terminationReason, lastResults, false);
      }

      const gateContext: GateContext = {
        cwd: this.config.cwd,
        goalId: this.config.goalId,
        ...this.config.gateCtx,
      };
      const deterministic = await Promise.all([
        typecheckGate({ ...gateContext, typecheckCmd: gateContext.typecheckCmd ?? 'npm run typecheck' }),
        testGate({ ...gateContext, testCmd: gateContext.testCmd ?? 'npm run test:all' }),
        lintGate({ ...gateContext, lintCmd: gateContext.lintCmd ?? 'npm run lint' }),
      ]);
      const bundle = await collectArtifactBundle({ cwd: this.config.cwd, finalText: lastFinalText, gates: deterministic });
      const reviewResult = await this.runIndependentReview(bundle);

      const incrementalTokens = this.totalTokens - previousCycleTokens;
      previousCycleTokens = this.totalTokens;
      goalManager.recordCycle(this.config.goalId, incrementalTokens, Date.now() - cycleStartedAt);

      const budgetResult = await budgetGate(gateContext);
      lastResults = [...deterministic, reviewResult, budgetResult];
      recordGateFailures(this.config.goalId, lastResults);
      eventStore.appendEvent(run.id, 'l2.cycle.evaluated', {
        cycle,
        results: lastResults,
        artifactDiffSha256: bundle.git.diffSha256,
      });

      if (lastResults.every((result) => result.passed)) {
        goalManager.updateGoal(this.config.goalId, { state: 'achieved' }, 'model');
        eventStore.transitionRun(run.id, 'succeeded', { cycle, results: lastResults });
        return this.buildResult(lastFinalText, lastReactState, totalTurns, cycle, false, undefined, lastResults, true);
      }

      if (!budgetResult.passed) {
        eventStore.transitionRun(run.id, 'budget_exceeded', { cycle, results: lastResults });
        return this.buildResult(lastFinalText, lastReactState, totalTurns, cycle, true, '预算超限', lastResults, false);
      }

      repairContext = lastResults
        .filter((result) => !result.passed)
        .map((result) => `[${result.name}] ${result.details ?? 'failed'}${result.suggestion ? `\n修复：${result.suggestion}` : ''}`)
        .join('\n\n');
      eventStore.transitionRun(run.id, 'retrying', { cycle, repairContext });
      eventStore.transitionRun(run.id, 'running');
    }

    const reason = `达到 L2 最大循环数 ${this.config.maxL2Cycles}`;
    eventStore.transitionRun(run.id, 'failed', { reason, results: lastResults });
    return this.buildResult(lastFinalText, lastReactState, totalTurns, cycle, true, reason, lastResults, false);
  }

  private resolveReviewProvider(): LlmProvider {
    if (this.config.reviewProvider) return this.config.reviewProvider;
    if (this.config.provider === 'codex') return 'minimax';
    return 'codex';
  }

  private async runIndependentReview(bundle: Awaited<ReturnType<typeof collectArtifactBundle>>): Promise<GateResult> {
    const startedAt = Date.now();
    const provider = this.resolveReviewProvider();
    const systemPrompt = this.config.reviewPrompt ?? [
      '你是独立质量审核器。只依据 Artifact Bundle 判断。',
      '输出必须包含且只能包含一个明确结论行：VERDICT: PASS 或 VERDICT: FAIL。',
      '缺少 diff、测试证据、关键产物或存在失败 Gate 时必须 FAIL。',
      'FAIL 后列出 ISSUES，每项包含证据、位置和修复动作。',
    ].join('\n');

    try {
      const response = await getLlmRouter().chat({
        provider,
        fallbackPolicy: 'none',
        callSource: 'sub_agent',
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(bundle, null, 2) },
        ],
      });
      this.totalTokens += response.usage.totalTokens;
      const verdict = parseStrictReviewVerdict(response.content);
      return {
        name: 'reviewGate',
        passed: verdict === 'PASS',
        details: response.content.slice(0, 4000),
        suggestion: verdict === 'FAIL'
          ? '按独立审核器 ISSUES 修复'
          : verdict === null
            ? '审核输出缺少唯一 VERDICT 行，按 FAIL 处理'
            : undefined,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        name: 'reviewGate',
        passed: false,
        details: `独立 Reviewer ${provider} 调用失败: ${err instanceof Error ? err.message : String(err)}`,
        suggestion: '配置可用的独立 reviewProvider，禁止回退到执行模型',
        durationMs: Date.now() - startedAt,
      };
    }
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
