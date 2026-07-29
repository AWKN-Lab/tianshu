/**
 * 显示凌扬健身闭环计划 goal 的 hao 状态
 */
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'data', 'awkn-engine.db');
const db = new Database(dbPath, { readonly: true });

const row = db.prepare(
  "SELECT id, title, state, hao, budget, history FROM goals WHERE id = ?"
).get('goal_1785177796630_waumxp');

console.log('=== Goal ===');
console.log('ID:', row.id);
console.log('Title:', row.title);
console.log('State:', row.state);
console.log('\n=== Hao Criteria ===');
const hao = JSON.parse(row.hao);
hao.forEach((c, i) => {
  console.log(`[${i}] ${c.passed ? 'PASS' : '...'} ${c.description}`);
  if (c.proof) console.log(`     proof: ${c.proof}`);
});

console.log('\n=== Budget ===');
const budget = JSON.parse(row.budget);
console.log('Consumed tokens:', budget.consumed?.tokens);
console.log('Max tokens:', budget.maxTokens);
console.log('Consumed cycles:', budget.consumed?.cycles);

console.log('\n=== Recent History (last 5) ===');
const history = JSON.parse(row.history);
history.slice(-5).forEach(h => {
  console.log(`  ${h.ts} ${h.from} → ${h.to} (${h.reason})`);
});

db.close();
