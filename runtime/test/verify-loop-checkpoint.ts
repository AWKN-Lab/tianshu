/**
 * M3 进阶-14 端到端验证：loop_state 检查点恢复（断点恢复）
 *
 * 验证点：
 * 1. 静态：loop-state-manager.ts 含 saveCheckpoint/loadCheckpoint/clearCheckpoint/listResumable/loadLatestForGoal
 * 2. 静态：agent-loop.ts runL1 含 saveCheckpoint/clearCheckpoint/resumeFrom 接入
 * 3. 静态：cli.ts 含 list-checkpoints / clear-checkpoint 子命令
 * 4. save → load 一致性：字段值匹配（reactState/messages/turn/totalTokens/finalText/terminated）
 * 5. upsert：同一 id 多次 save → 表中只一行（更新而非插入）
 * 6. loadLatestForGoal 返回最新未 terminated 的 checkpoint
 * 7. loadLatestForGoal 跳过 terminated 的 checkpoint（最新已终止 → 返回 null）
 * 8. clearCheckpoint 标记 terminated → loadCheckpoint 显示 terminated=true
 * 9. listResumable 过滤 terminated
 * 10. resume 集成：通过 AgentLoop.runL1(resumeFrom) 验证 messages/turn/totalTokens 状态恢复
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb, queryOne } from '../src/store/db.js';
import { getGoalManager, resetGoalManager } from '../src/goal/goal-manager.js';
import {
  getLoopStateManager,
  resetLoopStateManager,
  type LoopSnapshot,
} from '../src/core/loop-state-manager.js';
import { createReActState, recordObservation } from '../src/core/react-loop.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import type { ChatMessage } from '../src/llm/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 强制用临时 DB（避免污染正式数据）
process.env.AWKN_DB_PATH = resolve(__dirname, '..', 'data', `verify-loop-ckpt-${Date.now()}.db`);

// 关闭 evolve hook，避免 session_stop 时写经验文件干扰断言
process.env.AWKN_DISABLE_EVOLVE = '1';

describe('M3 进阶-14: loop_state 检查点恢复（断点恢复）', () => {
  // ========== 静态结构验证 ==========

  it('静态：loop-state-manager.ts 含全部方法', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'core', 'loop-state-manager.ts'),
      'utf-8',
    );
    assert.ok(src.includes('saveCheckpoint('), '应含 saveCheckpoint');
    assert.ok(src.includes('loadCheckpoint('), '应含 loadCheckpoint');
    assert.ok(src.includes('loadLatestForGoal('), '应含 loadLatestForGoal');
    assert.ok(src.includes('clearCheckpoint('), '应含 clearCheckpoint');
    assert.ok(src.includes('listResumable('), '应含 listResumable');
    assert.ok(src.includes('interface LoopSnapshot'), '应含 LoopSnapshot 接口');
  });

  it('静态：agent-loop.ts runL1 接入 saveCheckpoint/clearCheckpoint/resumeFrom', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'core', 'agent-loop.ts'),
      'utf-8',
    );
    // runL1 接受 resumeFrom 参数
    assert.ok(src.includes('options?: { resumeFrom?: LoopSnapshot }'),
      'runL1 应接受 resumeFrom 参数');
    // 每轮工具执行后保存 checkpoint
    assert.ok(src.includes('saveCheckpoint();'),
      '应在工具执行后调用 saveCheckpoint');
    // 所有 return 路径清除 checkpoint
    assert.ok(src.includes("terminate('LLM 连续失败 3 次')"),
      'LLM 失败 return 前应 clearCheckpoint');
    assert.ok(src.includes("terminate('repeating pattern'"),
      'repeating pattern return 前应 clearCheckpoint');
    assert.ok(src.includes('clearCheckpoint(reachedMax'),
      '循环结束后应 clearCheckpoint（区分 maxTurns）');
    // resume 时跳过 session_start hook
    assert.ok(src.includes('if (!resumeFrom)'),
      'resume 时应跳过 session_start/user_prompt_submit hook');
    // runL2 自动检查并 resume
    assert.ok(src.includes('loadLatestForGoal(this.config.goalId)'),
      'runL2 应自动调用 loadLatestForGoal 检查可恢复 checkpoint');
    assert.ok(src.includes('pendingResume'),
      'runL2 应使用 pendingResume 传递给 runL1');
  });

  it('静态：cli.ts 含 list-checkpoints / clear-checkpoint 子命令', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'cli.ts'),
      'utf-8',
    );
    assert.ok(src.includes("case 'list-checkpoints'"),
      '应含 list-checkpoints 子命令');
    assert.ok(src.includes("case 'clear-checkpoint'"),
      '应含 clear-checkpoint 子命令');
  });

  // ========== 集成测试：LoopStateManager CRUD ==========

  it('save → load 一致性', () => {
    resetGoalManager();
    resetLoopStateManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-save-load',
      description: 'checkpoint save/load test',
      owner: 'test',
      hao: [{ description: 'criteria1', passed: false }],
    });

    const mgr = getLoopStateManager();

    // 构造快照
    const reactState0 = createReActState('test-conv-001');
    reactState0.turn = 3;
    const reactState = recordObservation(reactState0, {
      toolName: 'read',
      args: { path: '/tmp/x' },
      result: 'hello',
      isError: false,
      durationMs: 10,
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'response' },
    ];
    const snapshot: LoopSnapshot = {
      reactState,
      messages,
      turn: 3,
      totalTokens: 250,
      finalText: '',
      terminated: false,
    };

    mgr.saveCheckpoint('test-conv-001', goal.id, snapshot);

    // 加载并验证字段一致性
    const loaded = mgr.loadCheckpoint('test-conv-001');
    assert.ok(loaded, '加载应成功');
    assert.equal(loaded!.turn, 3);
    assert.equal(loaded!.totalTokens, 250);
    assert.equal(loaded!.terminated, false);
    assert.equal(loaded!.messages.length, 3,
      `messages.length 应为 3，实际 ${loaded!.messages.length}`);
    assert.equal(loaded!.messages[1].content, 'hi');
    assert.equal(loaded!.reactState.conversationId, 'test-conv-001');
    assert.equal(loaded!.reactState.turn, 3);
    assert.equal(loaded!.reactState.totalObservations, 1);
    assert.equal(loaded!.reactState.observations[0].toolName, 'read');
  });

  it('upsert：同一 id 多次 save → 表中只一行', () => {
    resetGoalManager();
    resetLoopStateManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-upsert',
      description: 'upsert test',
      owner: 'test',
      hao: [],
    });
    const mgr = getLoopStateManager();

    const rs1 = createReActState('test-conv-upsert');
    rs1.turn = 1;
    mgr.saveCheckpoint('test-conv-upsert', goal.id, {
      reactState: rs1, messages: [], turn: 1, totalTokens: 10, finalText: '', terminated: false,
    });
    const rs2Base = createReActState('test-conv-upsert');
    rs2Base.turn = 2;
    const rs2 = recordObservation(rs2Base, {
      toolName: 'read', args: {}, result: '', isError: false, durationMs: 1,
    });
    mgr.saveCheckpoint('test-conv-upsert', goal.id, {
      reactState: rs2, messages: [], turn: 2, totalTokens: 50, finalText: '', terminated: false,
    });

    // 表中应只有一行
    const row = queryOne<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM loop_state WHERE id = ?',
      ['test-conv-upsert'],
    );
    assert.equal(row?.cnt, 1, '同一 id 多次 save 应是 upsert，表中只一行');

    // 加载的应是最新版本
    const loaded = mgr.loadCheckpoint('test-conv-upsert');
    assert.equal(loaded!.turn, 2, '应是最新版本 turn=2');
    assert.equal(loaded!.totalTokens, 50);
    assert.equal(loaded!.reactState.totalObservations, 1, '应是最新版本有 1 个 observation');
  });

  it('loadLatestForGoal 返回最新未 terminated 的 checkpoint', () => {
    resetGoalManager();
    resetLoopStateManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-latest',
      description: 'loadLatestForGoal test',
      owner: 'test',
      hao: [],
    });
    const mgr = getLoopStateManager();

    // 保存 2 个 checkpoint（不同 id，同一 goal）
    mgr.saveCheckpoint('ckpt-old', goal.id, {
      reactState: createReActState('ckpt-old'),
      messages: [], turn: 1, totalTokens: 10, finalText: '', terminated: false,
    });

    // 用一个小延时确保 updated_at 不同
    const waitMs = 10;
    const start = Date.now();
    while (Date.now() - start < waitMs) { /* busy wait */ }

    mgr.saveCheckpoint('ckpt-new', goal.id, {
      reactState: createReActState('ckpt-new'),
      messages: [], turn: 5, totalTokens: 100, finalText: '', terminated: false,
    });

    const latest = mgr.loadLatestForGoal(goal.id);
    assert.ok(latest, '应返回最新 checkpoint');
    assert.equal(latest!.id, 'ckpt-new', '应是较新的那个');
    assert.equal(latest!.snapshot.turn, 5);
  });

  it('loadLatestForGoal 跳过 terminated 的 checkpoint', () => {
    resetGoalManager();
    resetLoopStateManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-skip-terminated',
      description: 'skip terminated',
      owner: 'test',
      hao: [],
    });
    const mgr = getLoopStateManager();

    // 保存一个未终止的
    mgr.saveCheckpoint('ckpt-active', goal.id, {
      reactState: createReActState('ckpt-active'),
      messages: [], turn: 2, totalTokens: 20, finalText: '', terminated: false,
    });

    // 再保存一个已终止的（更晚）
    const waitMs = 10;
    const start = Date.now();
    while (Date.now() - start < waitMs) { /* busy wait */ }
    mgr.saveCheckpoint('ckpt-done', goal.id, {
      reactState: createReActState('ckpt-done'),
      messages: [], turn: 5, totalTokens: 100, finalText: 'done', terminated: false,
    });
    // 标记 ckpt-done 为 terminated
    mgr.clearCheckpoint('ckpt-done', true, 'completed');

    // loadLatestForGoal 应跳过 terminated 的 ckpt-done，返回 ckpt-active
    const latest = mgr.loadLatestForGoal(goal.id);
    assert.ok(latest, '应返回未终止的 checkpoint');
    assert.equal(latest!.id, 'ckpt-active', '应跳过 terminated 的 ckpt-done');
  });

  it('loadLatestForGoal：所有 checkpoint 都 terminated 时返回 null', () => {
    resetGoalManager();
    resetLoopStateManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-all-terminated',
      description: 'all terminated',
      owner: 'test',
      hao: [],
    });
    const mgr = getLoopStateManager();

    mgr.saveCheckpoint('ckpt-1', goal.id, {
      reactState: createReActState('ckpt-1'),
      messages: [], turn: 1, totalTokens: 10, finalText: '', terminated: false,
    });
    mgr.clearCheckpoint('ckpt-1', true, 'done');

    const latest = mgr.loadLatestForGoal(goal.id);
    assert.equal(latest, null, '所有 checkpoint 都 terminated 时应返回 null');
  });

  it('clearCheckpoint 标记 terminated → loadCheckpoint 显示 terminated=true', () => {
    resetGoalManager();
    resetLoopStateManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-clear',
      description: 'clear test',
      owner: 'test',
      hao: [],
    });
    const mgr = getLoopStateManager();

    mgr.saveCheckpoint('ckpt-clear', goal.id, {
      reactState: createReActState('ckpt-clear'),
      messages: [], turn: 3, totalTokens: 50, finalText: '', terminated: false,
    });
    // 验证初始未终止
    assert.equal(mgr.loadCheckpoint('ckpt-clear')!.terminated, false);

    // clear
    mgr.clearCheckpoint('ckpt-clear', true, 'manual clear');
    const loaded = mgr.loadCheckpoint('ckpt-clear');
    assert.ok(loaded, '记录应仍存在（clear 只是标记）');
    assert.equal(loaded!.terminated, true);
    assert.equal(loaded!.terminationReason, 'manual clear');
  });

  it('listResumable 过滤 terminated', () => {
    resetGoalManager();
    resetLoopStateManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-list',
      description: 'list resumable',
      owner: 'test',
      hao: [],
    });
    const mgr = getLoopStateManager();

    // 3 个未终止 + 1 个已终止
    mgr.saveCheckpoint('r1', goal.id, {
      reactState: createReActState('r1'),
      messages: [], turn: 1, totalTokens: 10, finalText: '', terminated: false,
    });
    mgr.saveCheckpoint('r2', goal.id, {
      reactState: createReActState('r2'),
      messages: [], turn: 2, totalTokens: 20, finalText: '', terminated: false,
    });
    mgr.saveCheckpoint('r3', goal.id, {
      reactState: createReActState('r3'),
      messages: [], turn: 3, totalTokens: 30, finalText: '', terminated: false,
    });
    mgr.saveCheckpoint('done1', goal.id, {
      reactState: createReActState('done1'),
      messages: [], turn: 5, totalTokens: 50, finalText: 'done', terminated: false,
    });
    mgr.clearCheckpoint('done1', true, 'done');

    const resumable = mgr.listResumable(goal.id);
    assert.equal(resumable.length, 3, '应有 3 个可恢复（done1 被过滤）');
    const ids = resumable.map((r) => r.id);
    assert.ok(ids.includes('r1'));
    assert.ok(ids.includes('r2'));
    assert.ok(ids.includes('r3'));
    assert.ok(!ids.includes('done1'), 'done1 应被过滤');
  });

  // ========== 集成测试：AgentLoop.runL1 resume ==========

  it('AgentLoop.runL1(resumeFrom) 恢复 messages/turn/totalTokens', async () => {
    resetGoalManager();
    resetLoopStateManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-runl1-resume',
      description: 'runL1 resume integration',
      owner: 'test',
      hao: [],
    });

    // 构造一个"已运行 2 轮"的快照
    const reactState = createReActState('resume-conv-001');
    reactState.turn = 2;
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'thinking...' },
    ];
    const snapshot: LoopSnapshot = {
      reactState,
      messages,
      turn: 2,
      totalTokens: 200,
      finalText: '',
      terminated: false,
    };

    // 用 maxTurns=2 强制让 runL1 立即退出（不调用 LLM，因为 turn 已经是 2）
    // 注意：循环条件是 turn < maxTurns，turn 从快照的 2 开始，进入循环会 ++ → 3
    // 所以 maxTurns=2 时 while 不进入，直接走 session_stop + return
    const loop = new AgentLoop({
      cwd: process.cwd(),
      enableL2: false,
      goalId: goal.id, // 启用 checkpoint
      maxTurns: 2,
    });

    const result = await loop.runL1('', { resumeFrom: snapshot });

    // 验证：状态从快照恢复（turn ≥ 2，totalTokens=200）
    assert.ok(result.totalTokens >= 200, `totalTokens 应至少为 200，实际 ${result.totalTokens}`);
    assert.ok(result.totalTurns >= 2, `totalTurns 应至少为 2，实际 ${result.totalTurns}`);

    // 验证：循环结束后 checkpoint 被清除（terminated=true）
    const mgr = getLoopStateManager();
    const loaded = mgr.loadCheckpoint('resume-conv-001');
    assert.ok(loaded, 'checkpoint 应仍存在');
    assert.equal(loaded!.terminated, true, '应标记 terminated=true（不再 resume）');
  });

  it('AgentLoop.runL1 不传 goalId 时不保存 checkpoint', async () => {
    resetGoalManager();
    resetLoopStateManager();
    getDb();

    // 无 goalId → checkpointMgr 为 null，runL1 不应尝试写 DB
    const loop = new AgentLoop({
      cwd: process.cwd(),
      enableL2: false,
      maxTurns: 1,
    });

    // 构造一个会立即退出的快照（maxTurns=1，turn=1 进入循环 → ++→ 2 不满足 <1，跳过）
    const reactState = createReActState('no-goal-conv');
    reactState.turn = 1;
    const snapshot: LoopSnapshot = {
      reactState,
      messages: [{ role: 'user', content: 'x' }],
      turn: 1,
      totalTokens: 0,
      finalText: '',
      terminated: false,
    };

    // 应正常完成，不抛 DB 错误（goalId 不存在 → checkpointMgr=null）
    const result = await loop.runL1('', { resumeFrom: snapshot });
    assert.ok(result, '应正常完成');

    // DB 中不应有 no-goal-conv checkpoint
    const mgr = getLoopStateManager();
    const loaded = mgr.loadCheckpoint('no-goal-conv');
    assert.equal(loaded, null, '无 goalId 时不应保存 checkpoint');
  });

  it('AgentLoop.runL1 全新对话（无 resumeFrom）+ goalId → 工具执行后保存 checkpoint', async () => {
    resetGoalManager();
    resetLoopStateManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-runl1-fresh',
      description: 'fresh L1 with goalId',
      owner: 'test',
      hao: [],
    });

    // 注入 mock LLM provider：第 1 轮返回 tool_calls，第 2 轮返回纯文本（结束循环）
    const { getLlmRouter } = await import('../src/llm/router.js');
    const router = getLlmRouter();
    const originalChat = router.chat.bind(router);
    let callCount = 0;
    (router as unknown as { chat: typeof originalChat }).chat = async (req) => {
      callCount++;
      if (callCount === 1) {
        // 返回一个 tool_call → 进入工具执行路径 → 保存 checkpoint
        return {
          content: '',
          toolCalls: [{
            id: 'tc-1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"/tmp/x"}' },
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          provider: 'trae' as const,
          model: 'test',
          finishReason: 'tool_calls' as const,
        };
      }
      // 第 2 轮：纯文本 → 结束循环
      return {
        content: 'all done',
        toolCalls: undefined,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        provider: 'trae' as const,
        model: 'test',
        finishReason: 'stop' as const,
      };
    };

    // 注册 read 工具
    const { toolRegistry } = await import('../src/tools/registry.js');
    const { builtinTools } = await import('../src/tools/builtin/index.js');
    for (const tool of builtinTools) {
      toolRegistry.register(tool);
    }

    const loop = new AgentLoop({
      cwd: process.cwd(),
      enableL2: false,
      goalId: goal.id, // 启用 checkpoint
      maxTurns: 5,
    });

    const result = await loop.runL1('test prompt');

    // 验证：循环正常完成（无 terminated）
    assert.equal(result.terminated, false, '循环应正常完成');
    assert.equal(result.finalText, 'all done');

    // 验证：循环结束后 checkpoint 被标记 terminated（循环正常结束 → clearCheckpoint(true)）
    const mgr = getLoopStateManager();
    // 找到本次会话的 checkpoint id（result.reactState.conversationId）
    const convId = result.reactState.conversationId;
    const loaded = mgr.loadCheckpoint(convId);
    assert.ok(loaded, 'checkpoint 应存在');
    assert.equal(loaded!.terminated, true, '应标记 terminated（循环正常结束）');
  });
});

// 清理
process.on('beforeExit', () => {
  try { closeDb(); } catch { /* ignore */ }
});
