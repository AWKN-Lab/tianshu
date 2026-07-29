/**
 * mark-w5-passed.ts — 标记 W5-ExitGate 为 passed
 *
 * W5-ExitGate: exact-SHA灰度发布演练+回滚验证通过(不实际生产发布)
 * 证据：W5a 回滚演练 PASS + F-P0-16 修复 Staging 验证 PASS (commit e3e227ef)
 */
import { GoalManager } from '../src/goal/goal-manager.js';

const GOAL_ID = 'goal_1785177796630_waumxp';
const W5_HAO_DESC = 'W5-ExitGate:exact-SHA灰度发布演练+回滚验证通过(不实际生产发布)';
const W5_PROOF =
  'docs/99证据与运行日志/W5-ExitGate_2026-07-28.md (exact-SHA e3e227ef + Staging E2E 12/13 PASS + W5a rollback drill PASS)';

const gm = new GoalManager();
const goal = gm.read(GOAL_ID);
if (!goal) {
  console.error(`[FATAL] Goal not found: ${GOAL_ID}`);
  process.exit(1);
}

console.log(`[before] goal.state=${goal.state}`);
const newHao = goal.hao.map((h) => {
  if (h.description === W5_HAO_DESC) {
    return { ...h, passed: true, proof: W5_PROOF };
  }
  return h;
});

const updated = gm.updateGoal(GOAL_ID, { hao: newHao, reason: 'W5-ExitGate PASS: exact-SHA drill + rollback verified' }, 'model');

if (!updated) {
  console.error('[FATAL] updateGoal returned null');
  process.exit(1);
}

console.log('\n[after] hao:');
for (const h of updated.hao) {
  console.log(`  - passed=${h.passed} | ${h.description}`);
}

const w5 = updated.hao.find((h) => h.description === W5_HAO_DESC);
if (w5 && w5.passed) {
  console.log('\n[OK] W5-ExitGate marked as PASSED');
} else {
  console.error('\n[FAIL] W5-ExitGate not marked as PASSED');
  process.exit(1);
}
