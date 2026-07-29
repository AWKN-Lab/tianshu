/**
 * 查找凌扬健身闭环计划 goal
 */
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'data', 'awkn-engine.db');
const db = new Database(dbPath, { readonly: true });

const cols = db.prepare("PRAGMA table_info(goals)").all();
console.log('Columns:', cols.map(c => c.name).join(', '));

const rows = db.prepare(
  "SELECT id, title, state FROM goals WHERE title LIKE '%凌扬%' OR title LIKE '%Annie%' OR title LIKE '%闭环%' ORDER BY rowid DESC LIMIT 10"
).all();

console.log(JSON.stringify(rows, null, 2));

db.close();
