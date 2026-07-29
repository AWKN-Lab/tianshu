// update-wpa2-proof.ts — 更新 Goal-D hao[5] proof 字段（仅记录进展，不标记 passed=true）
// 原因：WP-A0/A1/A2 已 PASS，但 WP-A3-A6 还未完成，整体 hao[5] 仍为未通过
import { GoalManager } from '../src/goal/goal-manager.js';

const GOAL_ID = 'goal_1785177796630_waumxp';

// hao[5] = "Goal-D:PRD-v4-WP-A0-A6实现并通过验收"
const WPA2_PROOF = [
  'WP-A0 PASS: docs/99证据与运行日志/WPA0-ExitGate_2026-07-28.md (7 findings fixed, E2E 12/13 no regression, Staging verified) commit 49d7e795',
  'WP-A1 PASS: docs/99证据与运行日志/WPA1-ExitGate_2026-07-28.md (MemoryOrchestrator + Schema + Lifecycle + Scene Query Planner + Budgeter, smoke test ALL PASSED, E2E 12/13 no regression) commit 6f89125e/0860ad0a',
  'WP-A2 PASS: docs/99证据与运行日志/WPA2-ExitGate_2026-07-28.md (Episode/Segment/Segment-Episode M:N/memory_job outbox + Hybrid Retrieval + MMR 2-gram + Rerank + Temporal + Worker; Staging /opt/runtime-verify 烟雾测试 23/23 PASS; E2E 12/13 no regression) commit 885a16ef',
  'WP-A3 Persona & Relationship: NOT STARTED',
  'WP-A4 Memory Center: NOT STARTED',
  'WP-A5 Action / Proactive Loop: NOT STARTED',
  'WP-A6 Trace / Quality Review: NOT STARTED',
  'hao[5] passed=false (WP-A3-A6 待启动); production_deployment=NOT AUTHORIZED'
].join(' | ');

async function main() {
  const gm = new GoalManager();
  const goal = gm.read(GOAL_ID);
  if (!goal) {
    console.error(`[FATAL] Goal not found: ${GOAL_ID}`);
    process.exit(1);
  }

  console.log(`[INFO] Goal found: ${goal.id}`);
  console.log(`[INFO] Goal title: ${goal.title || 'N/A'}`);
  console.log(`[INFO] hao count: ${goal.hao?.length || 0}`);

  if (!goal.hao || goal.hao.length === 0) {
    console.error('[FATAL] Goal has no hao entries');
    process.exit(1);
  }

  // 找到 Goal-D / WP-A0-A6 相关 hao
  const GOAL_D_KEYWORDS = ['Goal-D', 'WP-A0-A6', 'PRD-v4', 'Annie', '进化'];
  let matchedIdx = -1;
  for (let i = 0; i < goal.hao.length; i++) {
    const desc = goal.hao[i].description || '';
    if (GOAL_D_KEYWORDS.some(kw => desc.toLowerCase().includes(kw.toLowerCase()))) {
      matchedIdx = i;
      break;
    }
  }

  if (matchedIdx === -1) {
    console.error('[FATAL] No Goal-D hao found. Listing all hao:');
    goal.hao.forEach((h: any, i: number) => {
      console.log(`  [${i}] passed=${h.passed} desc=${h.description?.slice(0, 100)}`);
    });
    process.exit(1);
  }

  const targetHao = goal.hao[matchedIdx];
  console.log(`[MATCH] hao[${matchedIdx}]: ${targetHao.description}`);
  console.log(`  current passed: ${targetHao.passed}`);
  console.log(`  current proof: ${(targetHao.proof || '').slice(0, 200)}...`);

  // 只更新 proof 字段，不动 passed（WP-A3-A6 未完成）
  if (targetHao.passed) {
    console.log('[WARN] hao already passed=true, NOT modifying (would be regression).');
    console.log('[INFO] To preserve audit trail, only updating proof if passed=false.');
    process.exit(0);
  }

  const newHao = goal.hao.map((h: any, i: number) => {
    if (i === matchedIdx) {
      return { ...h, proof: WPA2_PROOF };
    }
    return h;
  });

  const updated = gm.updateGoal(GOAL_ID, {
    hao: newHao,
    reason: 'WP-A2-ExitGate PASS: 23/23 smoke test, E2E no regression. hao[5] proof updated (WP-A0/A1/A2 PASS, WP-A3-A6 NOT STARTED). passed=false preserved.'
  }, 'model');

  if (!updated) {
    console.error('[FATAL] gm.updateGoal returned null');
    process.exit(1);
  }

  console.log('[SUCCESS] Goal hao[5] proof updated');
  console.log(`  hao passed: ${newHao.filter((h: any) => h.passed).length}/${newHao.length}`);
  console.log(`  hao[5] passed: ${newHao[matchedIdx].passed} (preserved)`);
  console.log(`  hao[5] proof length: ${newHao[matchedIdx].proof?.length || 0} chars`);
}

main().catch(e => {
  console.error('[FATAL]', e);
  process.exit(1);
});
