/**
 * M3 进阶-10 端到端验证：goal-manager updateGoal canTransition 检查
 *
 * 验证点：
 * 1. 静态：源码含 canTransition 检查
 * 2. active → achieved：合法，应成功
 * 3. paused → achieved：非法（GOAL_TRANSITIONS['paused'] = ['active', 'unmet']），应返回 null
 * 4. budget_limited → achieved：非法（GOAL_TRANSITIONS['budget_limited'] = ['active', 'unmet']），应返回 null
 * 5. unmet → achieved：非法（GOAL_TRANSITIONS['unmet'] = ['active']），应返回 null
 * 6. 已 achieved → achieved：被终态检查拦截（早于 canTransition）
 * 7. 仅更新 hao（不传 state）：应成功，不触发 canTransition 检查
 * 8. audit log 记录失败原因
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../src/store/db.js';
import { getGoalManager, resetGoalManager } from '../src/goal/goal-manager.js';
import { canTransition, GOAL_TRANSITIONS } from '../src/goal/goal-state.js';
import type { GoalState } from '../src/goal/goal-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 强制用临时 DB（避免污染正式数据）
process.env.AWKN_DB_PATH = resolve(__dirname, '..', 'data', `verify-goal-trans-${Date.now()}.db`);

describe('M3 进阶-10: goal-manager updateGoal canTransition 检查', () => {
  it('静态：源码含 canTransition 检查', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'goal', 'goal-manager.ts'),
      'utf-8',
    );
    assert.ok(src.includes('canTransition(goal.state, \'achieved\')'),
      'updateGoal 应含 canTransition(goal.state, "achieved") 检查');
    assert.ok(src.includes('state machine violation'),
      '失败原因应含 "state machine violation"');
  });

  it('GOAL_TRANSITIONS 定义正确（参考基线）', () => {
    // 确认状态机基线：paused / budget_limited / unmet 都不含 achieved
    assert.ok(!GOAL_TRANSITIONS['paused'].includes('achieved' as GoalState),
      'paused 不应能直接转 achieved');
    assert.ok(!GOAL_TRANSITIONS['budget_limited'].includes('achieved' as GoalState),
      'budget_limited 不应能直接转 achieved');
    assert.ok(!GOAL_TRANSITIONS['unmet'].includes('achieved' as GoalState),
      'unmet 不应能直接转 achieved');
    assert.ok(GOAL_TRANSITIONS['active'].includes('achieved' as GoalState),
      'active 应能转 achieved（合法完成路径）');
  });

  it('active → achieved：合法，应成功', () => {
    resetGoalManager();
    getDb(); // 触发 schema 初始化
    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-active',
      description: 'active state goal',
      owner: 'test',
      hao: [{ description: 'criteria1', passed: false }],
    });

    // active → achieved 应成功
    const updated = gm.updateGoal(goal.id, { state: 'achieved' }, 'model');
    assert.ok(updated !== null, 'active → achieved 应成功');
    assert.equal(updated!.state, 'achieved');
  });

  it('paused → achieved：非法，应返回 null', () => {
    resetGoalManager();
    getDb();
    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-paused',
      description: 'paused state goal',
      owner: 'test',
      hao: [{ description: 'criteria1', passed: false }],
    });

    // 先 pause（用户独占）
    gm.pauseGoal(goal.id, 'user paused for review');
    const pausedGoal = gm.read(goal.id);
    assert.equal(pausedGoal!.state, 'paused');

    // paused → achieved 应被拒绝
    const updated = gm.updateGoal(goal.id, { state: 'achieved' }, 'model');
    assert.equal(updated, null, 'paused → achieved 应返回 null');

    // 状态不应改变
    const stillPaused = gm.read(goal.id);
    assert.equal(stillPaused!.state, 'paused', 'goal 应仍为 paused');
  });

  it('budget_limited → achieved：非法，应返回 null', () => {
    resetGoalManager();
    getDb();
    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-budget',
      description: 'budget_limited goal',
      owner: 'test',
      hao: [{ description: 'criteria1', passed: false }],
      // 设一个极小预算，recordCycle 一次就超限
      budget: {
        maxCycles: 1,
        maxTokens: 1,
        maxDurationMs: 1,
        warningAt: 0.8,
        consumed: { cycles: 0, tokens: 0, durationMs: 0 },
      },
    });

    // recordCycle 会触发 autoPauseIfBudgetLimited → budget_limited
    gm.recordCycle(goal.id, 100, 100);
    const budgetGoal = gm.read(goal.id);
    assert.equal(budgetGoal!.state, 'budget_limited',
      `recordCycle 后应自动转 budget_limited，实际: ${budgetGoal!.state}`);

    // budget_limited → achieved 应被拒绝
    const updated = gm.updateGoal(goal.id, { state: 'achieved' }, 'model');
    assert.equal(updated, null, 'budget_limited → achieved 应返回 null');

    // 状态不应改变
    const stillBudget = gm.read(goal.id);
    assert.equal(stillBudget!.state, 'budget_limited', 'goal 应仍为 budget_limited');
  });

  it('unmet → achieved：非法，应返回 null', () => {
    resetGoalManager();
    getDb();
    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-unmet',
      description: 'unmet state goal',
      owner: 'test',
      hao: [{ description: 'criteria1', passed: false }],
    });

    // active → unmet 需通过 updateGoal？看权限：模型不能设 unmet（USER_ONLY）
    // 但 unmet 可以通过 canTransition 从 active 转换
    // 直接手动改 state 模拟 unmet（绕过 updateGoal，因为模型不能设 unmet）
    // 用 pauseGoal → 然后... paused 不能转 unmet？看 GOAL_TRANSITIONS['paused'] = ['active', 'unmet']
    // paused → unmet 合法，但 pauseGoal 是用户操作，unmet 是用户独占
    // 这里直接操作内部状态模拟
    const g = gm.read(goal.id)!;
    g.state = 'unmet';  // 直接改内存状态模拟 unmet
    gm.updateGoal(goal.id, { hao: g.hao }, 'model');  // 持久化

    const unmetGoal = gm.read(goal.id);
    assert.equal(unmetGoal!.state, 'unmet');

    // unmet → achieved 应被拒绝（早于 canTransition 的终态检查）
    // 注意：updateGoal 开头就检查 achieved/unmet 终态，会先返回 null
    const updated = gm.updateGoal(goal.id, { state: 'achieved' }, 'model');
    assert.equal(updated, null, 'unmet → achieved 应返回 null（终态检查）');
  });

  it('已 achieved → achieved：终态检查拦截', () => {
    resetGoalManager();
    getDb();
    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-already-achieved',
      description: 'already achieved goal',
      owner: 'test',
      hao: [{ description: 'criteria1', passed: false }],
    });

    // 先正常标记 achieved
    gm.updateGoal(goal.id, { state: 'achieved' }, 'model');
    assert.equal(gm.read(goal.id)!.state, 'achieved');

    // 再次尝试标记 achieved → 应被终态检查拦截（不需要走到 canTransition）
    const updated = gm.updateGoal(goal.id, { state: 'achieved' }, 'model');
    assert.equal(updated, null, '已 achieved 不应再次标记');
  });

  it('仅更新 hao（不传 state）：应成功，不触发 canTransition', () => {
    resetGoalManager();
    getDb();
    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-hao-only',
      description: 'hao update only',
      owner: 'test',
      hao: [{ description: 'criteria1', passed: false }],
    });

    // 仅更新 hao，不传 state
    const updated = gm.updateGoal(goal.id, {
      hao: [{ description: 'criteria1', passed: true, proof: 'evidence' }],
    }, 'model');

    assert.ok(updated !== null, '仅更新 hao 应成功');
    assert.equal(updated!.hao[0].passed, true);
    assert.equal(updated!.state, 'active', 'state 不应变');
  });

  it('audit log 记录 canTransition 失败', () => {
    resetGoalManager();
    getDb();
    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-audit',
      description: 'audit log test',
      owner: 'test',
      hao: [{ description: 'criteria1', passed: false }],
    });

    gm.pauseGoal(goal.id, 'user paused');
    const beforeLog = gm.getAuditLog();
    const beforeLen = beforeLog.length;

    gm.updateGoal(goal.id, { state: 'achieved' }, 'model');

    const afterLog = gm.getAuditLog();
    // 应新增至少一条失败 audit
    const newEntries = afterLog.slice(beforeLen);
    const failEntry = newEntries.find((e) => !e.ok && e.error?.includes('state machine violation'));
    assert.ok(failEntry, 'audit log 应含 "state machine violation" 失败记录');
  });
});

// 清理
process.on('beforeExit', () => {
  try { closeDb(); } catch { /* ignore */ }
});
