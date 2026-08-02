import Database from 'better-sqlite3';
const db = new Database('D:/awkn-lab/awkn引擎/runtime/data/awkn-engine.db');
const rows = db.prepare(
  "SELECT workflow_name, status, COUNT(*) AS c FROM runs WHERE status IN ('created','queued','running','waiting_tool','waiting_approval','retrying') GROUP BY workflow_name, status",
).all();
console.log(JSON.stringify(rows, null, 2));
db.close();
