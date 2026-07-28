/**
 * Legacy Adapter Tests (R2 Shadow Integration Phase 4c)
 *
 * 测试覆盖：
 * 1. LegacyInputAdapter：从 messages/userInput 提取 rawInput
 * 2. LegacyIntentRouterAdapter：从 LLM response 推断 IntentRouterInput
 * 3. LegacyMemoryContextAdapter：从 messages 推断 ContextPlannerInput
 * 4. LegacyGoalManagerAdapter：从 Goal state + gateResults 推断 verdict
 *
 * 关键不变量验证：
 * - shadow 和 enforce 模式行为一致（都是 fail-closed）
 * - Adapter 不修改输入 snapshot（无副作用）
 * - 确定性：相同输入相同输出
 * - 跨平台 Hash 一致（不使用 localeCompare）
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  adaptLegacyInput,
  adaptLegacyIntentRouter,
  adaptLegacyMemoryContext,
  adaptLegacyGoalManager,
  LegacyAdapterError,
  type LegacyAdapterContext,
  type EngineV2InputSnapshot,
  type EngineV2MemorySnapshot,
  type EngineV2GoalSnapshot,
} from '../../src/adapter/public.js';
import type { ChatMessage, ChatResponse } from '../../src/llm/types.js';
import type { Goal } from '../../src/goal/goal-state.js';
import type { GateResult } from '../../src/gates/quality-gates.js';

const now = '2026-07-28T04:00:00.000Z';
const executionId = 'exec_' + 'a'.repeat(32);
const traceId = 'trace_' + 'b'.repeat(32);

function buildCtx(mode: 'shadow' | 'enforce' = 'shadow'): LegacyAdapterContext {
  return {
    mode,
    clock: () => now,
    executionId,
    traceId,
  };
}

function buildUserMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

function buildSystemMessage(content: string): ChatMessage {
  return { role: 'system', content };
}

function buildAssistantMessage(content: string): ChatMessage {
  return { role: 'assistant', content };
}

function buildToolCallMessage(toolCallId: string, toolName: string, args: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{
      id: toolCallId,
      type: 'function',
      function: { name: toolName, arguments: args },
    }],
  };
}

function buildLlmResponse(opts: { content?: string; toolCalls?: ChatResponse['toolCalls'] }): ChatResponse {
  return {
    content: opts.content ?? '',
    toolCalls: opts.toolCalls,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    provider: 'trae',
    model: 'test-model',
    finishReason: opts.toolCalls ? 'tool_calls' : 'stop',
  };
}

function buildGoal(opts: Partial<Goal> = {}): Goal {
  return {
    id: opts.id ?? 'goal_test_001',
    title: opts.title ?? 'Test Goal',
    description: opts.description ?? 'A test goal',
    state: opts.state ?? 'active',
    owner: opts.owner ?? 'test',
    createdAt: opts.createdAt ?? now,
    updatedAt: opts.updatedAt ?? now,
    hao: opts.hao ?? [{ description: 'criterion 1', passed: false }],
    history: opts.history ?? [],
  };
}

function buildGateResult(opts: Partial<GateResult> = {}): GateResult {
  return {
    name: opts.name ?? 'test-gate',
    passed: opts.passed ?? true,
    details: opts.details,
    suggestion: opts.suggestion,
    durationMs: opts.durationMs ?? 10,
  };
}

// ─── LegacyInputAdapter ───────────────────────────────────────────────

describe('LegacyInputAdapter', () => {
  describe('extracts rawInput from messages', () => {
    it('extracts last user message from messages', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: 'ignored param',
        messages: [
          buildSystemMessage('system prompt'),
          buildUserMessage('first user input'),
          buildAssistantMessage('assistant response'),
          buildUserMessage('second user input'),
        ],
      };
      const result = adaptLegacyInput(snapshot, buildCtx());
      assert.equal(result.rawInput, 'second user input');
      assert.equal(result.extractedFrom, 'user_message');
      assert.equal(result.messageIndex, 3);
    });

    it('falls back to userInput param when no user message in messages', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: 'param input',
        messages: [buildSystemMessage('system only')],
      };
      const result = adaptLegacyInput(snapshot, buildCtx());
      assert.equal(result.rawInput, 'param input');
      assert.equal(result.extractedFrom, 'userInput_param');
      assert.equal(result.messageIndex, undefined);
    });
  });

  describe('fail-closed on invalid input', () => {
    it('throws LegacyAdapterError when userInput is empty and no user message', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: '',
        messages: [buildSystemMessage('system only')],
      };
      assert.throws(
        () => adaptLegacyInput(snapshot, buildCtx()),
        (err: LegacyAdapterError) => err.code === 'ADAPTER_INPUT_INVALID' && err.adapterName === 'LegacyInputAdapter',
      );
    });

    it('throws when user message content is empty', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: 'fallback',
        messages: [buildUserMessage('')],
      };
      assert.throws(
        () => adaptLegacyInput(snapshot, buildCtx()),
        (err: LegacyAdapterError) => err.code === 'ADAPTER_INPUT_INVALID',
      );
    });
  });

  describe('mode consistency — shadow and enforce behave identically', () => {
    it('shadow and enforce produce same result for valid input', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: 'test input',
        messages: [buildUserMessage('message input')],
      };
      const shadowResult = adaptLegacyInput(snapshot, buildCtx('shadow'));
      const enforceResult = adaptLegacyInput(snapshot, buildCtx('enforce'));
      assert.deepEqual(shadowResult, enforceResult);
    });

    it('shadow and enforce both throw on invalid input', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: '',
        messages: [],
      };
      assert.throws(() => adaptLegacyInput(snapshot, buildCtx('shadow')));
      assert.throws(() => adaptLegacyInput(snapshot, buildCtx('enforce')));
    });
  });
});

// ─── LegacyIntentRouterAdapter ─────────────────────────────────────────

describe('LegacyIntentRouterAdapter', () => {
  describe('infers operations from LLM response', () => {
    it('infers WRITE operation when toolCalls present', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: 'write a file',
        messages: [buildUserMessage('write a file')],
        llmResponse: buildLlmResponse({
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'write_file', arguments: '{}' },
          }],
        }),
      };
      const result = adaptLegacyIntentRouter(snapshot, buildCtx());
      assert.deepEqual(result.operations, ['WRITE']);
      assert.equal(result.toolCountHint, 1);
      assert.equal(result.externalSideEffects, true);
      assert.equal(result.inferredFrom, 'llm_tool_calls');
    });

    it('infers ANALYZE operation when no toolCalls', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: 'analyze this',
        messages: [buildUserMessage('analyze this')],
        llmResponse: buildLlmResponse({ content: 'analysis result' }),
      };
      const result = adaptLegacyIntentRouter(snapshot, buildCtx());
      assert.deepEqual(result.operations, ['ANALYZE']);
      assert.equal(result.toolCountHint, 0);
      assert.equal(result.externalSideEffects, false);
      assert.equal(result.inferredFrom, 'llm_content_only');
    });

    it('infers from user_input_only when llmResponse absent', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: 'just input',
        messages: [buildUserMessage('just input')],
      };
      const result = adaptLegacyIntentRouter(snapshot, buildCtx());
      assert.equal(result.inferredFrom, 'user_input_only');
      assert.deepEqual(result.operations, ['ANALYZE']);
    });
  });

  describe('primaryIntent truncation', () => {
    it('truncates primaryIntent to 80 chars with ellipsis', () => {
      const longInput = 'a'.repeat(100);
      const snapshot: EngineV2InputSnapshot = {
        userInput: longInput,
        messages: [buildUserMessage(longInput)],
      };
      const result = adaptLegacyIntentRouter(snapshot, buildCtx());
      assert.equal(result.primaryIntent.length, 80);
      assert.ok(result.primaryIntent.endsWith('…'));
    });

    it('keeps primaryIntent as-is when under 80 chars', () => {
      const shortInput = 'short input';
      const snapshot: EngineV2InputSnapshot = {
        userInput: shortInput,
        messages: [buildUserMessage(shortInput)],
      };
      const result = adaptLegacyIntentRouter(snapshot, buildCtx());
      assert.equal(result.primaryIntent, shortInput);
    });
  });

  describe('fail-closed on invalid input', () => {
    it('throws when userInput is empty', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: '',
        messages: [buildUserMessage('')],
      };
      assert.throws(
        () => adaptLegacyIntentRouter(snapshot, buildCtx()),
        (err: LegacyAdapterError) => err.code === 'ADAPTER_INPUT_INVALID' && err.adapterName === 'LegacyIntentRouterAdapter',
      );
    });
  });

  describe('default fields', () => {
    it('uses sensible defaults for Engine v2 absence of intent layer', () => {
      const snapshot: EngineV2InputSnapshot = {
        userInput: 'test',
        messages: [buildUserMessage('test')],
      };
      const result = adaptLegacyIntentRouter(snapshot, buildCtx());
      assert.equal(result.taskKind, 'analysis');
      assert.equal(result.iterative, false);
      assert.equal(result.multiAgent, false);
      assert.equal(result.timeDependency, 'none');
      assert.equal(result.confidence, 0.5);
      assert.deepEqual(result.secondaryIntents, []);
      assert.deepEqual(result.missingFields, []);
      assert.deepEqual(result.knownFields, []);
    });
  });
});

// ─── LegacyMemoryContextAdapter ───────────────────────────────────────

describe('LegacyMemoryContextAdapter', () => {
  describe('infers query from messages', () => {
    it('uses systemPrompt param when provided', () => {
      const snapshot: EngineV2MemorySnapshot = {
        messages: [],
        systemPrompt: 'You are a helpful assistant',
      };
      const result = adaptLegacyMemoryContext(snapshot, buildCtx());
      assert.equal(result.plan.query, 'You are a helpful assistant');
      assert.equal(result.inferredFrom, 'system_prompt');
    });

    it('uses system message when systemPrompt param absent', () => {
      const snapshot: EngineV2MemorySnapshot = {
        messages: [buildSystemMessage('system from messages')],
      };
      const result = adaptLegacyMemoryContext(snapshot, buildCtx());
      assert.equal(result.plan.query, 'system from messages');
      assert.equal(result.inferredFrom, 'system_message');
    });

    it('falls back to user message when no system', () => {
      const snapshot: EngineV2MemorySnapshot = {
        messages: [buildUserMessage('user query')],
      };
      const result = adaptLegacyMemoryContext(snapshot, buildCtx());
      assert.equal(result.plan.query, 'user query');
      assert.equal(result.inferredFrom, 'user_message');
    });

    it('truncates query to 80 chars', () => {
      const longSystem = 'b'.repeat(100);
      const snapshot: EngineV2MemorySnapshot = {
        messages: [],
        systemPrompt: longSystem,
      };
      const result = adaptLegacyMemoryContext(snapshot, buildCtx());
      assert.equal(result.plan.query.length, 80);
      assert.ok(result.plan.query.endsWith('…'));
    });
  });

  describe('plan construction', () => {
    it('derives contextId from executionId', () => {
      const snapshot: EngineV2MemorySnapshot = {
        messages: [buildSystemMessage('system')],
      };
      const result = adaptLegacyMemoryContext(snapshot, buildCtx());
      // executionId = exec_aaaa...a (32 a's)
      // contextId should be ctx_aaaa...a (32 a's)
      assert.equal(result.plan.contextId, 'ctx_' + 'a'.repeat(32));
      assert.equal(result.plan.executionId, executionId);
    });

    it('uses default token budget and policy versions', () => {
      const snapshot: EngineV2MemorySnapshot = {
        messages: [buildSystemMessage('system')],
      };
      const result = adaptLegacyMemoryContext(snapshot, buildCtx());
      assert.equal(result.plan.tokenBudget, 2000);
      assert.equal(result.plan.allowStale, false);
      assert.deepEqual(result.plan.allowedSensitivityClasses, ['internal']);
      assert.equal(result.plan.policyVersion, 'context-policy/v1');
      assert.equal(result.plan.plannerVersion, 'context-planner/v1');
    });

    it('uses injected clock for createdAt', () => {
      const snapshot: EngineV2MemorySnapshot = {
        messages: [buildSystemMessage('system')],
      };
      const result = adaptLegacyMemoryContext(snapshot, buildCtx());
      assert.equal(result.plan.createdAt, now);
    });

    it('returns empty candidates array (Engine v2 has no Context Planner layer)', () => {
      const snapshot: EngineV2MemorySnapshot = {
        messages: [buildSystemMessage('system')],
      };
      const result = adaptLegacyMemoryContext(snapshot, buildCtx());
      assert.deepEqual(result.candidates, []);
    });
  });

  describe('fail-closed on invalid input', () => {
    it('throws when no system prompt or user message', () => {
      const snapshot: EngineV2MemorySnapshot = {
        messages: [buildAssistantMessage('assistant only')],
      };
      assert.throws(
        () => adaptLegacyMemoryContext(snapshot, buildCtx()),
        (err: LegacyAdapterError) => err.code === 'ADAPTER_INPUT_INVALID' && err.adapterName === 'LegacyMemoryContextAdapter',
      );
    });

    it('throws when executionId format is invalid', () => {
      const snapshot: EngineV2MemorySnapshot = {
        messages: [buildSystemMessage('system')],
      };
      const badCtx: LegacyAdapterContext = {
        ...buildCtx(),
        executionId: 'invalid-format',
      };
      assert.throws(
        () => adaptLegacyMemoryContext(snapshot, badCtx),
        (err: LegacyAdapterError) => err.code === 'ADAPTER_INPUT_INVALID',
      );
    });
  });
});

// ─── LegacyGoalManagerAdapter ─────────────────────────────────────────

describe('LegacyGoalManagerAdapter', () => {
  describe('infers verdict from goal state', () => {
    it('infers ACHIEVED when goal.state=achieved and has passed hao', () => {
      const snapshot: EngineV2GoalSnapshot = {
        goal: buildGoal({
          state: 'achieved',
          hao: [
            { description: 'c1', passed: true },
            { description: 'c2', passed: true },
          ],
        }),
        runId: 'run_test_001',
        gateResults: [],
        judgeVersion: 'awkn-goal-judge/v1',
      };
      const result = adaptLegacyGoalManager(snapshot, buildCtx());
      assert.equal(result.inferredVerdict, 'ACHIEVED');
      assert.equal(result.inferredFrom, 'goal_state_achieved');
      assert.equal(result.passedHaoCount, 2);
      assert.equal(result.totalHaoCount, 2);
      assert.deepEqual(result.reasonCodes, ['GOAL_STATE_ACHIEVED']);
    });

    it('infers UNKNOWN when goal.state=achieved but no passed hao', () => {
      const snapshot: EngineV2GoalSnapshot = {
        goal: buildGoal({
          state: 'achieved',
          hao: [{ description: 'c1', passed: false }],
        }),
        runId: 'run_test_002',
        gateResults: [],
        judgeVersion: 'awkn-goal-judge/v1',
      };
      const result = adaptLegacyGoalManager(snapshot, buildCtx());
      assert.equal(result.inferredVerdict, 'UNKNOWN');
      assert.ok(result.reasonCodes.includes('GOAL_STATE_ACHIEVED_BUT_NO_PASSED_HAO'));
    });

    it('infers BLOCKED when goal.state=budget_limited', () => {
      const snapshot: EngineV2GoalSnapshot = {
        goal: buildGoal({ state: 'budget_limited' }),
        runId: 'run_test_003',
        gateResults: [],
        judgeVersion: 'awkn-goal-judge/v1',
      };
      const result = adaptLegacyGoalManager(snapshot, buildCtx());
      assert.equal(result.inferredVerdict, 'BLOCKED');
      assert.equal(result.inferredFrom, 'goal_state_budget_limited');
    });

    it('infers UNKNOWN when goal.state=paused', () => {
      const snapshot: EngineV2GoalSnapshot = {
        goal: buildGoal({ state: 'paused' }),
        runId: 'run_test_004',
        gateResults: [],
        judgeVersion: 'awkn-goal-judge/v1',
      };
      const result = adaptLegacyGoalManager(snapshot, buildCtx());
      assert.equal(result.inferredVerdict, 'UNKNOWN');
      assert.equal(result.inferredFrom, 'goal_state_paused');
    });

    it('infers NOT_ACHIEVED when goal.state=unmet', () => {
      const snapshot: EngineV2GoalSnapshot = {
        goal: buildGoal({ state: 'unmet' }),
        runId: 'run_test_005',
        gateResults: [],
        judgeVersion: 'awkn-goal-judge/v1',
      };
      const result = adaptLegacyGoalManager(snapshot, buildCtx());
      assert.equal(result.inferredVerdict, 'NOT_ACHIEVED');
      assert.equal(result.inferredFrom, 'goal_state_unmet');
    });
  });

  describe('infers verdict from gateResults when goal.state=active', () => {
    it('infers ACHIEVED when all gates passed', () => {
      const snapshot: EngineV2GoalSnapshot = {
        goal: buildGoal({ state: 'active' }),
        runId: 'run_test_006',
        gateResults: [
          buildGateResult({ name: 'typecheck', passed: true }),
          buildGateResult({ name: 'test', passed: true }),
        ],
        judgeVersion: 'awkn-goal-judge/v1',
      };
      const result = adaptLegacyGoalManager(snapshot, buildCtx());
      assert.equal(result.inferredVerdict, 'ACHIEVED');
      assert.equal(result.inferredFrom, 'gate_results');
      assert.equal(result.gateResultsUsed, 2);
      assert.ok(result.reasonCodes.includes('ALL_GATES_PASSED'));
    });

    it('infers NOT_ACHIEVED when some gates failed', () => {
      const snapshot: EngineV2GoalSnapshot = {
        goal: buildGoal({ state: 'active' }),
        runId: 'run_test_007',
        gateResults: [
          buildGateResult({ name: 'typecheck', passed: true }),
          buildGateResult({ name: 'test', passed: false }),
        ],
        judgeVersion: 'awkn-goal-judge/v1',
      };
      const result = adaptLegacyGoalManager(snapshot, buildCtx());
      assert.equal(result.inferredVerdict, 'NOT_ACHIEVED');
      assert.ok(result.reasonCodes.includes('GATE_FAIL_DETECTED'));
    });

    it('infers UNKNOWN when no gateResults', () => {
      const snapshot: EngineV2GoalSnapshot = {
        goal: buildGoal({ state: 'active' }),
        runId: 'run_test_008',
        gateResults: [],
        judgeVersion: 'awkn-goal-judge/v1',
      };
      const result = adaptLegacyGoalManager(snapshot, buildCtx());
      assert.equal(result.inferredVerdict, 'UNKNOWN');
      assert.ok(result.reasonCodes.includes('NO_GATE_RESULTS'));
    });
  });

  describe('preserves expectedJudgeVersion', () => {
    it('includes expectedJudgeVersion in output', () => {
      const snapshot: EngineV2GoalSnapshot = {
        goal: buildGoal(),
        runId: 'run_test_009',
        gateResults: [],
        judgeVersion: 'awkn-goal-judge/v2',
      };
      const result = adaptLegacyGoalManager(snapshot, buildCtx());
      assert.equal(result.expectedJudgeVersion, 'awkn-goal-judge/v2');
    });
  });
});

// ─── 无外部副作用 + 确定性测试 ─────────────────────────────────────────

describe('Adapter immutability and determinism', () => {
  it('LegacyInputAdapter does not modify input snapshot', () => {
    const snapshot: EngineV2InputSnapshot = {
      userInput: 'original',
      messages: [buildUserMessage('message')],
    };
    const snapshotCopy: EngineV2InputSnapshot = {
      userInput: snapshot.userInput,
      messages: [...snapshot.messages],
    };
    adaptLegacyInput(snapshot, buildCtx());
    assert.deepEqual(snapshot, snapshotCopy);
  });

  it('LegacyIntentRouterAdapter does not modify input snapshot', () => {
    const snapshot: EngineV2InputSnapshot = {
      userInput: 'test',
      messages: [buildUserMessage('test')],
      llmResponse: buildLlmResponse({ content: 'response' }),
    };
    const snapshotCopy: EngineV2InputSnapshot = {
      userInput: snapshot.userInput,
      messages: [...snapshot.messages],
      llmResponse: snapshot.llmResponse,
    };
    adaptLegacyIntentRouter(snapshot, buildCtx());
    assert.deepEqual(snapshot, snapshotCopy);
  });

  it('LegacyMemoryContextAdapter does not modify input snapshot', () => {
    const snapshot: EngineV2MemorySnapshot = {
      messages: [buildSystemMessage('system')],
      systemPrompt: 'prompt',
      goalId: 'goal_123',
    };
    const snapshotCopy: EngineV2MemorySnapshot = {
      messages: [...snapshot.messages],
      systemPrompt: snapshot.systemPrompt,
      goalId: snapshot.goalId,
    };
    adaptLegacyMemoryContext(snapshot, buildCtx());
    assert.deepEqual(snapshot, snapshotCopy);
  });

  it('LegacyGoalManagerAdapter does not modify input snapshot', () => {
    const goal = buildGoal({ state: 'active' });
    const gateResults = [buildGateResult({ passed: true })];
    const snapshot: EngineV2GoalSnapshot = {
      goal,
      runId: 'run_test',
      gateResults,
      judgeVersion: 'awkn-goal-judge/v1',
    };
    const snapshotCopy: EngineV2GoalSnapshot = {
      goal: { ...goal, hao: [...goal.hao], history: [...goal.history] },
      runId: snapshot.runId,
      gateResults: [...snapshot.gateResults],
      judgeVersion: snapshot.judgeVersion,
    };
    adaptLegacyGoalManager(snapshot, buildCtx());
    assert.deepEqual(snapshot, snapshotCopy);
  });

  it('produces identical output for identical input (determinism)', () => {
    const snapshot: EngineV2InputSnapshot = {
      userInput: 'deterministic input',
      messages: [buildUserMessage('deterministic input')],
    };
    const result1 = adaptLegacyInput(snapshot, buildCtx());
    const result2 = adaptLegacyInput(snapshot, buildCtx());
    assert.deepEqual(result1, result2);
  });

  it('produces identical goal adaptation for identical input', () => {
    const snapshot: EngineV2GoalSnapshot = {
      goal: buildGoal({ state: 'active' }),
      runId: 'run_det',
      gateResults: [buildGateResult({ name: 'test', passed: true })],
      judgeVersion: 'awkn-goal-judge/v1',
    };
    const result1 = adaptLegacyGoalManager(snapshot, buildCtx());
    const result2 = adaptLegacyGoalManager(snapshot, buildCtx());
    assert.deepEqual(result1, result2);
  });
});
