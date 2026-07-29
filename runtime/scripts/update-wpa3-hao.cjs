/**
 * 更新 goal hao[5] proof — WP-A3 PASS
 *
 * hao[5] = "Goal-D:PRD-v4-WP-A0-A6实现并通过验收"
 * 之前: WP-A0/A1/A2 PASS, WP-A3-A6 NOT STARTED
 * 现在: WP-A0/A1/A2/A3 PASS, WP-A4-A6 NOT STARTED
 */
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'data', 'awkn-engine.db');
const db = new Database(dbPath);

const GOAL_ID = 'goal_1785177796630_waumxp';

// 读取当前 goal
const row = db.prepare('SELECT hao, history FROM goals WHERE id = ?').get(GOAL_ID);
if (!row) {
  console.error('Goal not found:', GOAL_ID);
  process.exit(1);
}

const hao = JSON.parse(row.hao);
const history = JSON.parse(row.history);

// 更新 hao[5] proof
const newProof = [
  'WP-A0 PASS: docs/99证据与运行日志/WPA0-ExitGate_2026-07-28.md (7 findings fixed, E2E 12/13 no regression, Staging verified) commit 49d7e795',
  'WP-A1 PASS: docs/99证据与运行日志/WPA1-ExitGate_2026-07-28.md (MemoryOrchestrator + Schema + Lifecycle + Scene Query Planner + Budgeter, smoke test ALL PASSED, E2E 12/13 no regression) commit 6f89125e/0860ad0a',
  'WP-A2 PASS: docs/99证据与运行日志/WPA2-ExitGate_2026-07-28.md (Episode/Segment/Segment-Episode M:N/memory_job outbox + Hybrid Retrieval + MMR 2-gram + Rerank + Temporal + Worker; Staging /opt/runtime-verify 烟雾测试 23/23 PASS; E2E 12/13 no regression) commit 885a16ef',
  'WP-A3 PASS: docs/99证据与运行日志/WPA3-ExitGate_2026-07-28.md (Persona Contract 版本发布流水线 + Protected Persona policy_hash + Mutable Expression Preferences + 多维关系模型 familiarity 独立计算 + Aside Gate 7 条件门禁 + 24h 冷却 + 服务型信号替代 socialNeed; migration 052 persona_versions+user_relationship+aside_log; Staging /opt/runtime-verify 烟雾测试 66/66 PASS; E2E 12/13 no regression) commit 39a47df5',
  'WP-A4 Memory Center: NOT STARTED',
  'WP-A5 Action / Proactive Loop: NOT STARTED',
  'WP-A6 Trace / Quality Review: NOT STARTED',
  'hao[5] passed=false (WP-A4-A6 待启动); production_deployment=NOT AUTHORIZED'
].join(' | ');

hao[5].proof = newProof;
// passed 保持 false（WP-A4-A6 尚未完成）

// 添加 history 条目
history.push({
  ts: new Date().toISOString(),
  from: 'active',
  to: 'active',
  reason: 'WP-A3-ExitGate PASS: 66/66 smoke test, E2E no regression. hao[5] proof updated (WP-A0/A1/A2/A3 PASS, WP-A4-A6 NOT STARTED). passed=false preserved.',
  actor: 'model'
});

// 写回
db.prepare('UPDATE goals SET hao = ?, history = ?, updated_at = ? WHERE id = ?')
  .run(JSON.stringify(hao), JSON.stringify(history), new Date().toISOString(), GOAL_ID);

console.log('✅ Goal hao[5] proof updated successfully');
console.log('Goal ID:', GOAL_ID);
console.log('hao[5] passed:', hao[5].passed);
console.log('hao[5] proof length:', hao[5].proof.length);

db.close();
