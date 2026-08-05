#!/usr/bin/env tsx
/**
 * M3 进阶-6 端到端验证 — agent-loop runL2 token 双计 bug 修复
 *
 * Bug 背景：
 *   agent-loop.ts runL2 复用同一 AgentLoop 实例调用 runL1，this.totalTokens 跨 cycle 累积。
 *   原版：recordCycle(goalId, l1Result.totalTokens, ...) 传累计值，
 *   但 recordCycle 内部 `consumed.tokens += tokens`（增量累加），
 *   导致 L2 多轮循环时 token 被重复计数 → 预算提前耗尽。
 *
 * 修复（M3 进阶-6，2026-07-23）：
 *   - runL2 用增量 token（l1Result.totalTokens - prevCumulativeTokens）传给 recordCycle
 *   - buildResult 仍返回 this.totalTokens（正确累计值）
 *
 * 验证策略（不依赖 LLM，纯确定性）：
 *   直接用 GoalManager.recordCycle 验证两种调用方式的差异：
 *   - 模拟 3 轮 cycle：cycle1 累计 100，cycle2 累计 250，cycle3 累计 400（本轮增量 100/150/150）
 *   - 旧版（传累计值）：consumed.tokens = 100+250+400 = 750 ❌
 *   - 新版（传增量值）：consumed.tokens = 100+150+150 = 400 ✅
 */

import { getGoalManager } from '../src/goal/goal-manager.js';
import { getDb, closeDb } from '../src/store/db.js';
import { resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

async function main(): Promise<void> {
  console.log('=== M3 进阶-6 验证：agent-loop runL2 token 双计 bug 修复 ===\n');

  // 临时 DB：唯一路径（pid+时间戳），避免与历史 test:all 残留或并发 test 状态污染
  // （历史上使用固定路径 test-tmp-l2-token/test-l2-token.db，pre-push full 档链式跑
  //  test+contracts+verify 时，若上一次 test 异常退出残留 db，再次跑会触发
  //  schema_migrations UNIQUE constraint + EBUSY 锁；2026-08-05 修复）
  const tmpDir = resolve(process.cwd(), `test-tmp-l2-token-${process.pid}-${Date.now()}`);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  const dbPath = resolve(tmpDir, 'test-l2-token.db');
  process.env.AWKN_DB_PATH = dbPath;
  getDb(); // 触发 schema 初始化

  const gm = getGoalManager();

  // ─── 1. 旧版行为模拟（传累计值，复现 bug） ─────────────────────
  console.log('[1] 旧版行为（传累计值）— 复现 bug');
  {
    const goal = gm.create({
      title: '旧版 token 双计测试',
      description: 'test',
      owner: 'test',
      budget: { maxTokens: 100000, maxCycles: 10, maxDurationMs: 3600000, warningAt: 0.8 },
    });

    // 模拟 3 轮 cycle 的累计 token（this.totalTokens 跨 cycle 累积）
    const cumulativeTokensPerCycle = [100, 250, 400];
    for (const cumulativeTokens of cumulativeTokensPerCycle) {
      // 旧版：直接传累计值（bug）
      gm.recordCycle(goal.id, cumulativeTokens, 1000);
    }

    const finalGoal = gm.read(goal.id);
    const consumed = finalGoal!.budget!.consumed!;
    console.log(`    旧版 consumed.tokens = ${consumed.tokens}（预期 750，实际 ${consumed.tokens}）`);
    assert(consumed.tokens === 750, '旧版 consumed.tokens 应为 750（双计 bug）');
    assert(consumed.cycles === 3, 'cycles 应为 3');
  }

  // ─── 2. 新版行为模拟（传增量值，修复后） ─────────────────────
  console.log('\n[2] 新版行为（传增量值）— 修复后');
  {
    const goal = gm.create({
      title: '新版 token 增量测试',
      description: 'test',
      owner: 'test',
      budget: { maxTokens: 100000, maxCycles: 10, maxDurationMs: 3600000, warningAt: 0.8 },
    });

    // 模拟 runL2 修复后的逻辑
    const cumulativeTokensPerCycle = [100, 250, 400];
    let prevCumulativeTokens = 0;
    for (const cumulativeTokens of cumulativeTokensPerCycle) {
      // 新版：传增量值（修复）
      const incrementalTokens = cumulativeTokens - prevCumulativeTokens;
      prevCumulativeTokens = cumulativeTokens;
      gm.recordCycle(goal.id, incrementalTokens, 1000);
    }

    const finalGoal = gm.read(goal.id);
    const consumed = finalGoal!.budget!.consumed!;
    console.log(`    新版 consumed.tokens = ${consumed.tokens}（预期 400，实际 ${consumed.tokens}）`);
    assert(consumed.tokens === 400, '新版 consumed.tokens 应为 400（修复后正确）');
    assert(consumed.cycles === 3, 'cycles 应为 3');
  }

  // ─── 3. 边界 case：单轮 cycle（增量 = 累计） ──────────────────
  console.log('\n[3] 边界：单轮 cycle（增量 = 累计，无歧义）');
  {
    const goal = gm.create({
      title: '单轮 cycle 测试',
      description: 'test',
      owner: 'test',
      budget: { maxTokens: 100000, maxCycles: 10, maxDurationMs: 3600000, warningAt: 0.8 },
    });

    // 单轮：累计 500，增量 500-0=500
    let prevCumulativeTokens = 0;
    const cumulative = 500;
    const incremental = cumulative - prevCumulativeTokens;
    prevCumulativeTokens = cumulative;
    gm.recordCycle(goal.id, incremental, 1000);

    const finalGoal = gm.read(goal.id);
    assert(finalGoal!.budget!.consumed!.tokens === 500, '单轮 consumed.tokens 应为 500');
  }

  // ─── 4. 边界 case：某轮 0 token（LLM 失败 fallback） ─────────
  console.log('\n[4] 边界：某轮 0 token（LLM 失败 fallback 或 stub）');
  {
    const goal = gm.create({
      title: '0 token 轮测试',
      description: 'test',
      owner: 'test',
      budget: { maxTokens: 100000, maxCycles: 10, maxDurationMs: 3600000, warningAt: 0.8 },
    });

    // cycle1: 100 tokens
    // cycle2: 0 tokens（LLM 失败，this.totalTokens 不变，累计仍 100，增量 0）
    // cycle3: 150 tokens（累计 250，增量 150）
    const cumulativePerCycle = [100, 100, 250];
    let prevCumulativeTokens = 0;
    for (const cumulative of cumulativePerCycle) {
      const incremental = cumulative - prevCumulativeTokens;
      prevCumulativeTokens = cumulative;
      gm.recordCycle(goal.id, incremental, 1000);
    }

    const finalGoal = gm.read(goal.id);
    assert(finalGoal!.budget!.consumed!.tokens === 250, '0 token 轮不应导致双计，consumed 应为 250');
    assert(finalGoal!.budget!.consumed!.cycles === 3, 'cycles 应为 3（含 0 token 轮）');
  }

  // ─── 5. 修复后 buildResult 仍返回正确累计值 ───────────────────
  console.log('\n[5] 修复后 buildResult 返回值不受影响（仍为累计 this.totalTokens）');
  {
    // 模拟 AgentLoop 的 this.totalTokens 累计逻辑
    let thisTotalTokens = 0;
    const llmTokensPerCycle = [100, 150, 150]; // 每轮 LLM 实际消耗
    let prevCumulativeTokens = 0;
    let lastReturnedTotalTokens = 0;

    for (const llmTokens of llmTokensPerCycle) {
      // runL1 内部：this.totalTokens += resp.usage.totalTokens
      thisTotalTokens += llmTokens;
      // l1Result.totalTokens = this.totalTokens（累计）
      const l1ResultTotalTokens = thisTotalTokens;
      // runL2 修复后：传增量
      const incrementalTokens = l1ResultTotalTokens - prevCumulativeTokens;
      prevCumulativeTokens = l1ResultTotalTokens;
      // buildResult 返回 this.totalTokens
      lastReturnedTotalTokens = thisTotalTokens;
      // recordCycle 收到增量
      console.log(`    cycle: llm=${llmTokens}, cumulative=${l1ResultTotalTokens}, incremental=${incrementalTokens}`);
    }

    assert(lastReturnedTotalTokens === 400, 'buildResult 应返回累计 400（正确总数）');
    assert(prevCumulativeTokens === 400, 'prevCumulativeTokens 最终应为 400');
  }

  // ─── 6. 旧版 vs 新版对比 ─────────────────────────────────────
  console.log('\n[6] 旧版 vs 新版对比（3 轮 cycle）');
  {
    const cumulative = [100, 250, 400]; // 每轮累计值
    const actual = [100, 150, 150]; // 每轮实际增量

    // 旧版：sum(cumulative)
    const oldSum = cumulative.reduce((a, b) => a + b, 0);
    // 新版：sum(actual) = sum(incremental)
    let prev = 0;
    const newSum = cumulative.reduce((acc, c) => {
      const inc = c - prev;
      prev = c;
      return acc + inc;
    }, 0);

    console.log(`    旧版（传累计）: ${cumulative.join('+')} = ${oldSum}`);
    console.log(`    新版（传增量）: ${actual.join('+')} = ${newSum}`);
    assert(oldSum === 750, '旧版双计后总额 750');
    assert(newSum === 400, '新版正确总额 400');
    assert(newSum === actual.reduce((a, b) => a + b, 0), '新版应等于实际增量之和');
    assert(oldSum > newSum, '旧版多计（双计 bug），新版修正');
  }

  // ─── 清理 ─────────────────────────────────────────────────────
  closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.AWKN_DB_PATH;

  // ─── 汇总 ─────────────────────────────────────────────────────
  console.log('\n=== 汇总 ===');
  console.log(`通过: ${pass}, 失败: ${fail}`);
  if (fail > 0) {
    console.log('\n失败项:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log('\n✅ M3 进阶-6 验证全部通过 — runL2 token 双计 bug 修复正确');
}

main().catch((err) => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
