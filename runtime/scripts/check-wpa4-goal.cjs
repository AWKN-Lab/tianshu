// 检查 WP-A4 主目标状态
const sqlite3 = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '..', 'data', 'awkn-engine.db');
const s = new sqlite3(dbPath);

const GOAL_ID = 'goal_1785177796630_waumxp';
const row = s.prepare('SELECT id, title, state, hao, budget FROM goals WHERE id = ?').get(GOAL_ID);

if (!row) {
  console.log('Goal not found:', GOAL_ID);
  console.log('Listing all non-test goals:');
  const rows = s.prepare("SELECT id, title, state FROM goals WHERE title NOT LIKE 'test-%' AND title NOT LIKE 'verify-%' LIMIT 30").all();
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('=== Goal Found ===');
  console.log('ID:', row.id);
  console.log('Title:', row.title);
  console.log('State:', row.state);
  console.log('Budget:', JSON.parse(row.budget));
  const hao = JSON.parse(row.hao);
  console.log('=== Hao (验收条件) ===');
  hao.forEach((c, i) => {
    console.log(`[${i}] ${c.passed ? 'PASS' : 'NOT-PASS'} | ${c.description}`);
    if (c.proof) console.log(`     proof: ${c.proof.substring(0, 200)}${c.proof.length > 200 ? '...' : ''}`);
  });
}
