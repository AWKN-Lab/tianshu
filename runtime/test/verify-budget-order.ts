/**
 * M3 进阶-15 端到端验证：recordCycle 必须在 budgetGate 之前
 *
 * 验证点：
 * 1. 静态：prd-centric-loop.ts 中 recordCycle 在 budgetGate 之前（行号顺序）
 * 2. 静态：tianhuo-cicd-loop.ts 中 recordCycle 在 evaluateTianhuoCicdStop 之前
 * 3. 静态：tianhuo-cicd-loop.ts 中 cycleStartedAt 在 cycle 开始时定义（durationMs 不为 0）
 * 4. 行为：budgetGate 读 goal.budget.consumed.tokens（含本轮 recordCycle 累加）
 * 5. 行为：先 recordCycle 再 budgetGate → budgetGate 能感知本轮 token 让 budget 超限 → passed=false（正确）
 * 6. 行为：先 budgetGate 再 recordCycle（模拟旧版 bug 顺序） → budgetGate 拿不到本轮 token → passed=true（假成功）
 *
 * 修复价值：让 budgetGate 能拿到本轮真实 token 消耗，避免预算超限仍"假成功"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../src/store/db.js';
import { getGoalManager, resetGoalManager } from '../src/goal/goal-manager.js';
import { budgetGate } from '../src/gates/quality-gates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 强制用临时 DB
process.env.AWKN_DB_PATH = resolve(__dirname, '..', 'data', `verify-budget-order-${Date.now()}.db`);

describe('M3 进阶-15: recordCycle 必须在 budgetGate 之前', () => {
  // ========== 静态结构验证 ==========

  it('静态：prd-centric-loop.ts 中 recordCycle 在 budgetGate 之前', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'orchestrator', 'prd-centric-loop.ts'),
      'utf-8',
    );
    const lines = src.split('\n');

    let recordCycleLine = -1;
    let budgetGateLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const ln = i + 1;
      if (lines[i].includes('gm.recordCycle(') && !lines[i].includes('//')) {
        recordCycleLine = ln;
      }
      if (lines[i].includes('budgetGate(') && !lines[i].includes('//') && !lines[i].includes('import')) {
        budgetGateLine = ln;
      }
    }

    assert.ok(recordCycleLine > 0, `应找到 recordCycle 调用，实际 line=${recordCycleLine}`);
    assert.ok(budgetGateLine > 0, `应找到 budgetGate 调用，实际 line=${budgetGateLine}`);
    assert.ok(
      recordCycleLine < budgetGateLine,
      `recordCycle (line ${recordCycleLine}) 应在 budgetGate (line ${budgetGateLine}) 之前`,
    );
  });

  it('静态：tianhuo-cicd-loop.ts 中 recordCycle 在 evaluateTianhuoCicdStop 之前', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'orchestrator', 'tianhuo-cicd-loop.ts'),
      'utf-8',
    );
    const lines = src.split('\n');

    let recordCycleLine = -1;
    let stopEvalLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const ln = i + 1;
      if (lines[i].includes('gm.recordCycle(') && !lines[i].includes('//')) {
        recordCycleLine = ln;
      }
      if (lines[i].includes('evaluateTianhuoCicdStop(') && !lines[i].includes('//') && !lines[i].includes('import')) {
        stopEvalLine = ln;
      }
    }

    assert.ok(recordCycleLine > 0, `应找到 recordCycle 调用，实际 line=${recordCycleLine}`);
    assert.ok(stopEvalLine > 0, `应找到 evaluateTianhuoCicdStop 调用，实际 line=${stopEvalLine}`);
    assert.ok(
      recordCycleLine < stopEvalLine,
      `recordCycle (line ${recordCycleLine}) 应在 evaluateTianhuoCicdStop (line ${stopEvalLine}) 之前`,
    );
  });

  it('静态：tianhuo-cicd-loop.ts 中 cycleStartedAt 在 cycle 开头定义 + durationMs 计算', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'orchestrator', 'tianhuo-cicd-loop.ts'),
      'utf-8',
    );
    assert.ok(
      src.includes('const cycleStartedAt = Date.now();'),
      '应定义 cycleStartedAt = Date.now()',
    );
    assert.ok(
      src.includes('const cycleDurationMs = Date.now() - cycleStartedAt;'),
      '应计算 cycleDurationMs = Date.now() - cycleStartedAt（而非传 0）',
    );
    assert.ok(
      !src.includes('gm.recordCycle(config.goalId, tianhuoResult.totalTokens + reviewResult.totalTokens, 0)'),
      '不应再有 durationMs=0 的 recordCycle 调用（旧版 bug）',
    );
  });

  // ========== 行为验证：budgetGate 读 recordCycle 累加值 ==========

  it('行为：先 recordCycle 再 budgetGate → 本轮 token 让 budget 超限 → passed=false（正确）', async () => {
    resetGoalManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-budget-order-correct',
      description: '验证 recordCycle-before-budgetGate 顺序',
      owner: 'test',
      hao: [{ description: 'criteria', passed: false }],
      // 设置小 budget：maxTokens=100，本轮消耗 150 → 应超限
      budget: {
        maxCycles: 10,
        maxTokens: 100,
        maxDurationMs: 60000,
        warningAt: 0.8,
        consumed: { cycles: 0, tokens: 0, durationMs: 0 },
      },
    });

    // 模拟本轮消耗 150 tokens
    gm.recordCycle(goal.id, 150, 5000);

    // budgetGate 应感知到本轮 150 tokens，累计 150 > 100 → 超限 → passed=false
    const result = await budgetGate({ cwd: process.cwd(), goalId: goal.id });

    assert.equal(result.passed, false, '本轮 token 让 budget 超限，budgetGate 应 passed=false');
    assert.ok(
      result.details.includes('超限'),
      `details 应包含"超限"，实际：${result.details}`,
    );
  });

  it('行为：先 budgetGate 再 recordCycle（模拟旧版 bug 顺序） → 拿不到本轮 token → passed=true（假成功）', async () => {
    resetGoalManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-budget-order-buggy',
      description: '模拟旧版 bug 顺序（先 budgetGate 后 recordCycle）',
      owner: 'test',
      hao: [{ description: 'criteria', passed: false }],
      // 设置小 budget：maxTokens=100，本轮消耗 150 → 应超限
      budget: {
        maxCycles: 10,
        maxTokens: 100,
        maxDurationMs: 60000,
        warningAt: 0.8,
        consumed: { cycles: 0, tokens: 0, durationMs: 0 },
      },
    });

    // 模拟旧版 bug 顺序：先 budgetGate（此时 consumed.tokens=0，未超限 → passed=true）
    const buggyResult = await budgetGate({ cwd: process.cwd(), goalId: goal.id });
    assert.equal(buggyResult.passed, true, '旧版 bug 顺序：budgetGate 拿不到本轮 token → 误判 passed=true（假成功）');

    // 然后 recordCycle（让 budget 超限）
    gm.recordCycle(goal.id, 150, 5000);

    // 此时再调 budgetGate → passed=false（但旧版已经 return achieved=true 了，这是 bug）
    const correctResult = await budgetGate({ cwd: process.cwd(), goalId: goal.id });
    assert.equal(correctResult.passed, false, '正确顺序下：recordCycle 后 budgetGate 能感知超限 → passed=false');
  });

  it('行为：多轮循环中 recordCycle 累计正确，budgetGate 在每轮都能感知真实累计', async () => {
    resetGoalManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-multi-cycle',
      description: '多轮循环累计',
      owner: 'test',
      hao: [],
      // maxTokens=300，分 3 轮每轮 100，第 3 轮应刚好达限
      budget: {
        maxCycles: 10,
        maxTokens: 300,
        maxDurationMs: 60000,
        warningAt: 0.8,
        consumed: { cycles: 0, tokens: 0, durationMs: 0 },
      },
    });

    // 第 1 轮：消耗 100，累计 100，未超限
    gm.recordCycle(goal.id, 100, 1000);
    let result = await budgetGate({ cwd: process.cwd(), goalId: goal.id });
    assert.equal(result.passed, true, '第 1 轮累计 100/300，应 passed=true');

    // 第 2 轮：消耗 100，累计 200，未超限
    gm.recordCycle(goal.id, 100, 1000);
    result = await budgetGate({ cwd: process.cwd(), goalId: goal.id });
    assert.equal(result.passed, true, '第 2 轮累计 200/300，应 passed=true');

    // 第 3 轮：消耗 100，累计 300，达限（warning 但未超限，看实现）
    gm.recordCycle(goal.id, 100, 1000);
    result = await budgetGate({ cwd: process.cwd(), goalId: goal.id });
    // maxUsage=300/300=1.0，exceeded 阈值通常是 > 1.0，所以 passed=true 但 warning
    // 验证 details 包含 100.0%（达限）
    assert.ok(
      result.details.includes('100.0%'),
      `第 3 轮累计 300/300=100%，details 应包含 100.0%，实际：${result.details}`,
    );

    // 第 4 轮：消耗 100，累计 400，超限
    gm.recordCycle(goal.id, 100, 1000);
    result = await budgetGate({ cwd: process.cwd(), goalId: goal.id });
    assert.equal(result.passed, false, '第 4 轮累计 400/300 > 100%，应 passed=false');
  });
});

process.on('beforeExit', () => {
  try { closeDb(); } catch { /* ignore */ }
});

// ========== M3 进阶-16: checkBudget 防御性检查（fail-closed）==========

describe('M3 进阶-16: checkBudget 防御性检查（字段缺失/0 时 fail-closed）', () => {
  it('静态：goal-state.ts checkBudget 含 Number.isFinite 防御性检查', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'goal', 'goal-state.ts'),
      'utf-8',
    );
    assert.ok(
      src.includes('Number.isFinite(b.maxCycles)'),
      '应含 Number.isFinite(b.maxCycles) 防御性检查',
    );
    assert.ok(
      src.includes('Number.isFinite(b.maxTokens)'),
      '应含 Number.isFinite(b.maxTokens) 防御性检查',
    );
    assert.ok(
      src.includes('Number.isFinite(b.maxDurationMs)'),
      '应含 Number.isFinite(b.maxDurationMs) 防御性检查',
    );
    assert.ok(
      src.includes('fail-closed'),
      '应含 fail-closed 注释说明设计意图',
    );
  });

  it('行为：maxTokens=undefined 时 → exceeded=true（fail-closed，不再 NaN 假成功）', async () => {
    resetGoalManager();
    getDb();

    const gm = getGoalManager();
    // 故意传错格式（模拟用户传 max: { tokens: 100 } 而非 maxTokens: 100）
    const goal = gm.create({
      title: 'test-defensive-undefined',
      description: '字段缺失',
      owner: 'test',
      hao: [],
      budget: {
        // @ts-expect-error 测试错误格式
        maxTokens: undefined,
        maxCycles: 10,
        maxDurationMs: 60000,
        warningAt: 0.8,
        consumed: { cycles: 0, tokens: 0, durationMs: 0 },
      },
    });

    const result = await budgetGate({ cwd: process.cwd(), goalId: goal.id });
    assert.equal(result.passed, false, '字段缺失应 fail-closed → passed=false（不再 NaN 假成功）');
  });

  it('行为：maxTokens=0 时 → exceeded=true（避免除以 0 → Infinity 误判）', async () => {
    resetGoalManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-defensive-zero',
      description: '字段为 0',
      owner: 'test',
      hao: [],
      budget: {
        maxTokens: 0,  // 0 会导致除以 0 → Infinity
        maxCycles: 10,
        maxDurationMs: 60000,
        warningAt: 0.8,
        consumed: { cycles: 0, tokens: 0, durationMs: 0 },
      },
    });

    const result = await budgetGate({ cwd: process.cwd(), goalId: goal.id });
    assert.equal(result.passed, false, 'maxTokens=0 应 fail-closed → passed=false');
  });

  it('行为：正常 budget 仍正常工作（不破坏正常路径）', async () => {
    resetGoalManager();
    getDb();

    const gm = getGoalManager();
    const goal = gm.create({
      title: 'test-normal-budget',
      description: '正常 budget',
      owner: 'test',
      hao: [],
      budget: {
        maxTokens: 1000,
        maxCycles: 10,
        maxDurationMs: 60000,
        warningAt: 0.8,
        consumed: { cycles: 0, tokens: 0, durationMs: 0 },
      },
    });

    gm.recordCycle(goal.id, 100, 1000);  // 消耗 100/1000 = 10%
    const result = await budgetGate({ cwd: process.cwd(), goalId: goal.id });
    assert.equal(result.passed, true, '正常 budget 10% 使用应 passed=true');
    assert.ok(
      result.details.includes('10.0%'),
      `details 应包含 10.0%，实际：${result.details}`,
    );
  });
});
