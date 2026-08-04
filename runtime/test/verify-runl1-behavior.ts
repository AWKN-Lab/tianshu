/**
 * runL1 直接行为测试 — 触发 / 边界决策 / 失败恢复 / 结果路径
 *
 * 背景：verify-loop-checkpoint.ts 中部分断言仅检查 agent-loop.ts 源码字符串
 * （静态断言），无法证明运行时行为。本文件通过 mock LLM + hook spy +
 * 临时 DB 直接驱动 AgentLoop.runL1，覆盖：
 *
 * 1. 触发（triggering）：session_start / user_prompt_submit / session_stop
 *    hook 的触发顺序；resume 时跳过 session_start / user_prompt_submit。
 * 2. 边界决策（boundary decisions）：maxTurns 耗尽无 finalText → 终止；
 *    有 finalText → 正常结束；excludedTools 拦截；无效 tool arguments；
 *    pre_tool_use hook 阻断。
 * 3. 失败恢复（failure recovery）：LLM 连续失败 3 次 → 终止 + checkpoint
 *    标记 + ledger fatal；失败 1 次后恢复成功（fail-open）；token 异常增长
 *    → 终止；resumeFrom 继续执行且 LLM 收到快照 messages。
 * 4. 结果路径（result paths）：工具成功执行 → observation + checkpoint 快照
 *    保留；工具抛错 → isError observation 且循环继续；连续 2 次工具失败 →
 *    reflection stop；同工具重复调用 → repeating pattern 终止。
 *
 * 验收边界：与 verify-loop-checkpoint.ts 保持一致的 checkpoint 语义
 * （循环结束/终止均标记 terminated，resume 不触发 start hooks）。
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../src/store/db.js';
import { getGoalManager, resetGoalManager } from '../src/goal/goal-manager.js';
import {
  getLoopStateManager,
  resetLoopStateManager,
  type LoopSnapshot,
} from '../src/core/loop-state-manager.js';
import { createReActState } from '../src/core/react-loop.js';
import { getCorrectionsLedger } from '../src/evolve/corrections-ledger.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { getLlmRouter } from '../src/llm/router.js';
import { hookManager } from '../src/core/hook-manager.js';
import { toolRegistry } from '../src/tools/registry.js';
import { readTool } from '../src/tools/builtin/index.js';
import type { ChatMessage, ChatRequest, ChatResponse } from '../src/llm/types.js';
import type { HookPoint } from '../src/core/hook-types.js';
import type { ToolHandler } from '../src/tools/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 强制用临时 DB（避免污染正式数据）
process.env.AWKN_DB_PATH = resolve(__dirname, '..', 'data', `verify-runl1-behavior-${Date.now()}.db`);

// 关闭 evolve hook，避免 session_stop 时写经验文件干扰断言
process.env.AWKN_DISABLE_EVOLVE = '1';

const PKG_PATH = resolve(__dirname, '..', 'package.json');

// ─── Mock 基础设施 ─────────────────────────────────────────────────

type ChatSpy = (req: ChatRequest) => Promise<ChatResponse>;

function installChatSpy(spy: ChatSpy): { restore: () => void; calls: ChatRequest[] } {
  const router = getLlmRouter();
  const original = router.chat;
  const calls: ChatRequest[] = [];
  (router as unknown as { chat: typeof original }).chat = async (req) => {
    calls.push(req);
    return spy(req);
  };
  return {
    restore: () => {
      (router as unknown as { chat: typeof original }).chat = original;
    },
    calls,
  };
}

function textResponse(content: string, totalTokens = 15): ChatResponse {
  return {
    content,
    toolCalls: undefined,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens },
    provider: 'trae',
    model: 'test',
    finishReason: 'stop',
  };
}

function toolCallResponse(
  toolCalls: Array<{ name: string; arguments: string }>,
  totalTokens = 15,
): ChatResponse {
  return {
    content: '',
    toolCalls: toolCalls.map((tc, i) => ({
      id: `tc-${i}`,
      type: 'function' as const,
      function: tc,
    })),
    usage: { promptTokens: 10, completionTokens: 5, totalTokens },
    provider: 'trae',
    model: 'test',
    finishReason: 'tool_calls' as const,
  };
}

function clearHooks(): void {
  for (const hook of hookManager.getHooks()) hookManager.unload(hook.id);
}

function registerHookSpy(point: HookPoint, events: string[], label = point): string {
  const id = `test-spy-${point}-${Math.random().toString(36).slice(2, 8)}`;
  hookManager.register({
    id,
    point,
    type: 'function',
    timeout: 1000,
    fn: async () => {
      events.push(label);
      return { success: true };
    },
  });
  return id;
}

function makeFailingTool(name: string, errorMessage: string): ToolHandler {
  return {
    name,
    description: `always fails with ${errorMessage}`,
    source: 'builtin',
    permissionLevel: 'none',
    parameters: {},
    execute: async () => {
      throw new Error(errorMessage);
    },
  };
}

function makeSpyTool(name: string, executed: { value: boolean }): ToolHandler {
  return {
    name,
    description: `records whether executed: ${name}`,
    source: 'builtin',
    permissionLevel: 'none',
    parameters: {},
    execute: async () => {
      executed.value = true;
      return `${name}-ok`;
    },
  };
}

describe('runL1 直接行为：触发 / 边界决策 / 失败恢复 / 结果路径', () => {
  toolRegistry.register(readTool);

  beforeEach(() => {
    clearHooks();
    resetGoalManager();
    resetLoopStateManager();
    getDb();
  });

  after(() => {
    clearHooks();
  });

  // ========== 1. 触发（triggering） ==========

  it('触发：全新对话按序触发 session_start → user_prompt_submit → session_stop', async () => {
    const events: string[] = [];
    registerHookSpy('session_start', events);
    registerHookSpy('user_prompt_submit', events);
    registerHookSpy('session_stop', events);

    const spy = installChatSpy(async () => textResponse('hello done'));
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 3 });
      const result = await loop.runL1('test prompt');

      assert.equal(result.terminated, false);
      assert.equal(result.finalText, 'hello done');
      assert.deepEqual(events, ['session_start', 'user_prompt_submit', 'session_stop'],
        '全新对话应按序触发三个生命周期 hook');
      assert.equal(spy.calls.length, 1, '应恰好调用一次 LLM');
    } finally {
      spy.restore();
    }
  });

  it('触发：resume 时跳过 session_start / user_prompt_submit，仅触发 session_stop', async () => {
    const events: string[] = [];
    registerHookSpy('session_start', events);
    registerHookSpy('user_prompt_submit', events);
    registerHookSpy('session_stop', events);

    // 快照 turn=1 + maxTurns=3 → resume 后循环继续执行 1 轮（LLM 返回文本结束）
    const reactState = createReActState('resume-hook-conv');
    reactState.turn = 1;
    const snapshot: LoopSnapshot = {
      reactState,
      messages: [{ role: 'user', content: 'prev' }],
      turn: 1,
      totalTokens: 100,
      finalText: '',
      terminated: false,
    };

    const spy = installChatSpy(async () => textResponse('resumed'));
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 3 });
      const result = await loop.runL1('', { resumeFrom: snapshot });

      assert.equal(result.terminated, false);
      assert.equal(result.finalText, 'resumed');
      assert.equal(spy.calls.length, 1, 'resume 后应继续执行一轮');
      assert.deepEqual(events, ['session_stop'],
        'resume 不应触发 session_start / user_prompt_submit');
    } finally {
      spy.restore();
    }
  });

  // ========== 2. 边界决策（boundary decisions） ==========

  it('边界：maxTurns 耗尽且无 finalText → terminated=true + 达到最大轮数', async () => {
    const spy = installChatSpy(async () =>
      toolCallResponse([{ name: 'read', arguments: JSON.stringify({ path: PKG_PATH }) }]),
    );
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 2 });
      const result = await loop.runL1('x');

      assert.equal(result.terminated, true, 'maxTurns 耗尽且无 finalText 应终止');
      assert.equal(result.terminationReason, '达到 L1 最大轮数 2');
      assert.equal(result.totalTurns, 2);
      assert.equal(result.finalText, '');
      assert.equal(spy.calls.length, 2, '应恰好调用 maxTurns 次 LLM');
    } finally {
      spy.restore();
    }
  });

  it('边界：LLM 返回文本 → 正常结束 terminated=false + finalText + totalTokens 累计', async () => {
    const spy = installChatSpy(async () => textResponse('answer', 42));
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 3 });
      const result = await loop.runL1('q');

      assert.equal(result.terminated, false);
      assert.equal(result.finalText, 'answer');
      assert.equal(result.totalTurns, 1);
      assert.equal(result.totalTokens, 42, 'totalTokens 应累计本次 LLM usage');
    } finally {
      spy.restore();
    }
  });

  it('边界：excludedTools 中的工具被拦截 → 不执行 + error observation + 循环继续', async () => {
    const executed = { value: false };
    const blockedTool = makeSpyTool('test-blocked-tool', executed);
    toolRegistry.register(blockedTool);

    let call = 0;
    const spy = installChatSpy(async () => {
      call++;
      if (call === 1) return toolCallResponse([{ name: 'test-blocked-tool', arguments: '{}' }]);
      return textResponse('done');
    });
    try {
      const loop = new AgentLoop({
        cwd: process.cwd(),
        enableL2: false,
        maxTurns: 3,
        excludedTools: ['test-blocked-tool'],
      });
      const result = await loop.runL1('x');

      assert.equal(executed.value, false, '被排除的工具不应执行');
      assert.equal(result.terminated, false);
      assert.equal(result.finalText, 'done');
      const obs = result.reactState.observations;
      assert.equal(obs.length, 1);
      assert.equal(obs[0].toolName, 'test-blocked-tool');
      assert.equal(obs[0].isError, true);
      assert.match(obs[0].errorMessage ?? '', /unavailable/, '拦截应记录 unavailable 错误');
    } finally {
      spy.restore();
    }
  });

  it('边界：无效 tool arguments → error observation + 循环继续', async () => {
    let call = 0;
    const spy = installChatSpy(async () => {
      call++;
      if (call === 1) return toolCallResponse([{ name: 'read', arguments: 'not-json{' }]);
      return textResponse('done');
    });
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 3 });
      const result = await loop.runL1('x');

      assert.equal(result.terminated, false);
      assert.equal(result.finalText, 'done');
      const obs = result.reactState.observations;
      assert.equal(obs.length, 1);
      assert.equal(obs[0].isError, true);
      assert.match(obs[0].errorMessage ?? '', /Invalid tool arguments/);
    } finally {
      spy.restore();
    }
  });

  it('边界：pre_tool_use hook 阻断 → 工具不执行且不记录 observation', async () => {
    const executed = { value: false };
    const spyTool = makeSpyTool('test-hook-blocked-tool', executed);
    toolRegistry.register(spyTool);

    const hookId = `block-${Date.now()}`;
    hookManager.register({
      id: hookId,
      point: 'pre_tool_use',
      type: 'function',
      timeout: 1000,
      fn: async () => ({ success: true, block: true, blockReason: 'blocked by test' }),
    });

    let call = 0;
    const spy = installChatSpy(async () => {
      call++;
      if (call === 1) return toolCallResponse([{ name: 'test-hook-blocked-tool', arguments: '{}' }]);
      return textResponse('done');
    });
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 3 });
      const result = await loop.runL1('x');

      assert.equal(executed.value, false, '被 block 的工具不应执行');
      assert.equal(result.terminated, false);
      assert.equal(result.finalText, 'done');
      assert.equal(result.reactState.observations.length, 0,
        'blocked 时不产生 observation');
    } finally {
      spy.restore();
      hookManager.unload(hookId);
    }
  });

  // ========== 3. 失败恢复（failure recovery） ==========

  it('失败恢复：LLM 连续失败 3 次 → 终止 + checkpoint 标记 terminated + ledger fatal', async () => {
    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-llm-3-strike',
      description: 'LLM consecutive failure',
      owner: 'test',
      hao: [],
    });

    const spy = installChatSpy(async () => {
      throw new Error('llm down');
    });
    try {
      const loop = new AgentLoop({
        cwd: process.cwd(),
        enableL2: false,
        goalId: goal.id,
        maxTurns: 5,
      });
      const result = await loop.runL1('x');

      assert.equal(result.terminated, true);
      assert.equal(result.terminationReason, 'LLM 连续失败 3 次');
      assert.equal(result.totalTurns, 3);
      assert.equal(spy.calls.length, 3);

      // checkpoint 应被标记 terminated（不再 resume）
      const convId = result.reactState.conversationId;
      const loaded = getLoopStateManager().loadCheckpoint(convId);
      assert.ok(loaded, 'checkpoint 应存在');
      assert.equal(loaded!.terminated, true);
      assert.equal(loaded!.terminationReason, 'LLM 连续失败 3 次');

      // corrections ledger 应记录 fatal 失败证据
      const rows = getCorrectionsLedger().list({ source: 'loop_monitor', goalId: goal.id });
      assert.ok(
        rows.some((r) => r.severity === 'fatal' && r.error_text.includes('LLM 连续失败 3 次')),
        'ledger 应记录 fatal 级连续失败',
      );
    } finally {
      spy.restore();
    }
  });

  it('失败恢复：LLM 失败 1 次后恢复 → 正常完成（fail-open 不终止）', async () => {
    let call = 0;
    const spy = installChatSpy(async () => {
      call++;
      if (call === 1) throw new Error('transient');
      return textResponse('recovered');
    });
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 3 });
      const result = await loop.runL1('x');

      assert.equal(result.terminated, false, '单次失败不应终止循环');
      assert.equal(result.finalText, 'recovered');
      assert.equal(result.totalTurns, 2, '失败轮也计入 turn');
    } finally {
      spy.restore();
    }
  });

  it('失败恢复：token 异常增长 → terminated(token anomaly)', async () => {
    const tokens = [10, 10, 100];
    let call = 0;
    const spy = installChatSpy(async () => {
      const token = tokens[call] ?? 15;
      call++;
      return toolCallResponse([{ name: 'read', arguments: JSON.stringify({ path: PKG_PATH }) }], token);
    });
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 5 });
      const result = await loop.runL1('x');

      assert.equal(result.terminated, true);
      assert.equal(result.terminationReason, 'token anomaly');
      assert.equal(result.finalText, '[token 异常增长，循环已终止]');
    } finally {
      spy.restore();
    }
  });

  it('失败恢复：resumeFrom 后继续执行 → LLM 收到快照 messages + 状态累计', async () => {
    const snapshotMessages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'prev task' },
      { role: 'assistant', content: 'prev thinking' },
    ];
    const reactState = createReActState('resume-continue-conv');
    reactState.turn = 1;
    const snapshot: LoopSnapshot = {
      reactState,
      messages: snapshotMessages,
      turn: 1,
      totalTokens: 200,
      finalText: '',
      terminated: false,
    };

    let captured: ChatMessage[] = [];
    const spy = installChatSpy(async (req) => {
      // 拷贝，避免后续 messages.push 通过引用污染捕获结果
      captured = [...req.messages];
      return textResponse('continued', 30);
    });
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 3 });
      const result = await loop.runL1('ignored input', { resumeFrom: snapshot });

      assert.equal(result.terminated, false);
      assert.equal(result.finalText, 'continued');
      assert.equal(result.totalTurns, 2, 'turn 应从快照 1 继续递增');
      assert.equal(result.totalTokens, 230, 'totalTokens = 200(快照) + 30(新增)');
      assert.equal(spy.calls.length, 1);
      assert.deepEqual(captured, snapshotMessages,
        'LLM 应收到快照 messages，不追加新 userInput');
    } finally {
      spy.restore();
    }
  });

  // ========== 4. 结果路径（result paths） ==========

  it('结果：tool_call 成功执行 → observation + checkpoint 快照保留', async () => {
    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-tool-success',
      description: 'tool success path',
      owner: 'test',
      hao: [],
    });

    let call = 0;
    const spy = installChatSpy(async () => {
      call++;
      if (call === 1) return toolCallResponse([{ name: 'read', arguments: JSON.stringify({ path: PKG_PATH }) }]);
      return textResponse('done');
    });
    try {
      const loop = new AgentLoop({
        cwd: process.cwd(),
        enableL2: false,
        goalId: goal.id,
        maxTurns: 3,
      });
      const result = await loop.runL1('x');

      assert.equal(result.terminated, false);
      assert.equal(result.totalTurns, 2);
      const obs = result.reactState.observations;
      assert.equal(obs.length, 1);
      assert.equal(obs[0].toolName, 'read');
      assert.equal(obs[0].isError, false);
      assert.match(obs[0].result, /awkn-engine-runtime/, '工具结果应包含读取的包名');

      // checkpoint 快照应保留 observation（工具执行后保存的 checkpoint 内容）
      const loaded = getLoopStateManager().loadCheckpoint(result.reactState.conversationId);
      assert.ok(loaded, 'checkpoint 应存在');
      assert.equal(loaded!.reactState.totalObservations, 1);
      assert.equal(loaded!.reactState.observations[0].toolName, 'read');
    } finally {
      spy.restore();
    }
  });

  it('结果：工具执行抛错 → isError observation + 循环继续正常结束', async () => {
    toolRegistry.register(makeFailingTool('test-failing-tool', 'boom'));

    let call = 0;
    const spy = installChatSpy(async () => {
      call++;
      if (call === 1) return toolCallResponse([{ name: 'test-failing-tool', arguments: '{}' }]);
      return textResponse('done');
    });
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 3 });
      const result = await loop.runL1('x');

      assert.equal(result.terminated, false, '单次工具失败不应终止循环');
      assert.equal(result.finalText, 'done');
      const obs = result.reactState.observations;
      assert.equal(obs.length, 1);
      assert.equal(obs[0].toolName, 'test-failing-tool');
      assert.equal(obs[0].isError, true);
      assert.equal(obs[0].errorMessage, 'boom');
    } finally {
      spy.restore();
    }
  });

  it('结果：连续 2 次工具失败 → reflection stop 终止', async () => {
    toolRegistry.register(makeFailingTool('test-failing-tool-2', 'boom'));

    const spy = installChatSpy(async () =>
      toolCallResponse([{ name: 'test-failing-tool-2', arguments: '{}' }]),
    );
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 5 });
      const result = await loop.runL1('x');

      assert.equal(result.terminated, true);
      assert.match(result.terminationReason ?? '', /^reflection stop: /);
      assert.match(result.finalText, /\[reflection stop\]/);
    } finally {
      spy.restore();
    }
  });

  it('结果：同工具连续重复调用 → repeating pattern 终止', async () => {
    const spy = installChatSpy(async () =>
      toolCallResponse([{ name: 'read', arguments: JSON.stringify({ path: PKG_PATH }) }]),
    );
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false, maxTurns: 8 });
      const result = await loop.runL1('x');

      assert.equal(result.terminated, true);
      assert.equal(result.terminationReason, 'repeating pattern');
      assert.equal(result.totalTurns, 4);
      assert.equal(result.reactState.totalObservations, 4);
    } finally {
      spy.restore();
    }
  });
});

// 清理
process.on('beforeExit', () => {
  try { closeDb(); } catch { /* ignore */ }
});
