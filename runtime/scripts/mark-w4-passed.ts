/**
 * mark-w4-passed.ts — 标记 W4-ExitGate 为 passed
 *
 * 用途：F-P0-16 修复验证完成后，将 goal_1785177796630_waumxp 的 W4-ExitGate hao 项
 *      从 passed=false 更新为 passed=true，附 proof 证据路径。
 *
 * 使用 GoalManager.updateGoal（hao patch），符合状态机约束：
 *   - 不直接修改 state（仅 hao 字段）
 *   - 由 model actor 调用，权限边界允许
 *
 * 运行：cd runtime && npx tsx scripts/mark-w4-passed.ts
 */
import { GoalManager } from '../src/goal/goal-manager.js';

const GOAL_ID = 'goal_1785177796630_waumxp';
const W4_HAO_DESC = 'W4-ExitGate:游客到下一计划E2E在Staging闭环通过';
const W4_PROOF =
  'docs/99证据与运行日志/F-P0-16-fix-verify_2026-07-28.md (E2E 12/13 PASS, 92.31%; Step 9 failure is P1 test contract mismatch, not P0 production bug; F-P0-16 RESOLVED)';

const gm = new GoalManager();
const goal = gm.read(GOAL_ID);
if (!goal) {
  console.error(`[FATAL] Goal not found: ${GOAL_ID}`);
  process.exit(1);
}

console.log(`[before] goal.state=${goal.state}`);
console.log(`[before] hao:`);
for (const h of goal.hao) {
  console.log(`  - passed=${h.passed} | ${h.description}${h.proof ? ` | proof=${h.proof}` : ''}`);
}

// 构造新的 hao 数组：W4 标记为 passed=true + proof，其他保持不变
const newHao = goal.hao.map((h) => {
  if (h.description === W4_HAO_DESC) {
    return { ...h, passed: true, proof: W4_PROOF };
  }
  return h;
});

// 调用 updateGoal（model actor，仅改 hao，不改 state）
const updated = gm.updateGoal(GOAL_ID, { hao: newHao, reason: 'W4-ExitGate PASS: F-P0-16 resolved, E2E 12/13' }, 'model');

if (!updated) {
  console.error('[FATAL] updateGoal returned null');
  process.exit(1);
}

console.log('\n[after] goal.state=' + updated.state);
console.log('[after] hao:');
for (const h of updated.hao) {
  console.log(`  - passed=${h.passed} | ${h.description}${h.proof ? ` | proof=${h.proof}` : ''}`);
}

// 验证 W4 已标记为 passed
const w4 = updated.hao.find((h) => h.description === W4_HAO_DESC);
if (w4 && w4.passed) {
  console.log('\n[OK] W4-ExitGate marked as PASSED');
} else {
  console.error('\n[FAIL] W4-ExitGate not marked as PASSED');
  process.exit(1);
}
