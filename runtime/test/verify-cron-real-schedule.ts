/**
 * L3 真实时间驱动调度 端到端验证
 *
 * 目的：证明 cron engine 的 setTimeout 时间驱动调度真实工作（非 triggerJob 手动触发）
 *
 * 流程：
 * 1. 插入 3 条同指纹 correction
 * 2. 注册 evolve cron job（`* * * * *` 每分钟触发）
 * 3. 启动 cron engine（startCronEngine）
 * 4. 等待 setTimeout 真实到期触发（dynamic wait: next_run_at - now + 10s buffer）
 * 5. 检查 cron_run_log 有自动触发记录
 * 6. 检查经验文件被生成
 * 7. 停止 cron engine
 *
 * 运行：node --import tsx test/verify-cron-real-schedule.ts
 * 退出码：0 = 时间驱动验证通过，1 = 失败
 */

import { existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb, closeDb, queryAll } from '../src/store/db.js';
import { getCorrectionsLedger } from '../src/evolve/corrections-ledger.js';
import { getCronJobsManager } from '../src/cron/jobs-manager.js';
import { startCronEngine, stopCronEngine } from '../src/cron/engine.js';

// ─── 测试隔离 ─────────────────────────────────────────────────────
const TMP_DB = resolve(process.cwd(), 'data', `test-cron-real-${process.pid}.db`);
const TMP_DERIVED = resolve(process.cwd(), 'data', `test-cron-real-derived-${process.pid}`);

for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`, TMP_DERIVED]) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}
mkdirSync(TMP_DERIVED, { recursive: true });

process.env.AWKN_DB_PATH = TMP_DB;
process.env.AWKN_DERIVED_DIR = TMP_DERIVED;

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

// ─── 1. 初始化 + 插入 correction ─────────────────────────────────
console.log('\n=== 1. 插入 3 条同指纹 correction ===');

getDb(TMP_DB);
const ledger = getCorrectionsLedger();
for (let i = 0; i < 3; i++) {
  ledger.record({
    source: 'cron-real-schedule-test',
    severity: 'error',
    errorText: `ReferenceError: process is not defined\n    at eval (runtime.ts:15:3)`,
    goalId: 'goal-real-test',
  });
}
console.log('  ℹ️  3 条 correction 已插入');

// ─── 2. 注册每分钟 evolve cron job ───────────────────────────────
console.log('\n=== 2. 注册 evolve cron job（`* * * * *` 每分钟触发）===');

const job = getCronJobsManager().add({
  name: '真实时间驱动验证',
  cronExpr: '* * * * *',
  actionType: 'evolve',
  actionPayload: {},
});

console.log(`  ℹ️  job id: ${job.id}`);
console.log(`  ℹ️  next_run_at: ${job.next_run_at}`);

// ─── 3. 启动 cron engine ─────────────────────────────────────────
console.log('\n=== 3. 启动 cron engine（startCronEngine）===');

startCronEngine();
console.log('  ℹ️  cron engine 已启动，setTimeout 已注册');

// ─── 4. 等待 setTimeout 真实到期触发 ───────────────────────────────
console.log('\n=== 4. 等待 setTimeout 真实到期触发（时间驱动）===');

const nextRun = new Date(job.next_run_at!).getTime();
const now = Date.now();
const waitMs = Math.max(1000, nextRun - now + 5000); // next_run + 5s buffer

console.log(`  ℹ️  当前时间: ${new Date().toISOString()}`);
console.log(`  ℹ️  预计触发: ${job.next_run_at}`);
console.log(`  ℹ️  等待: ${Math.ceil(waitMs / 1000)}s（setTimeout delay + 5s buffer）`);

await new Promise<void>((resolve) => {
  setTimeout(resolve, waitMs);
});

console.log(`  ℹ️  等待结束: ${new Date().toISOString()}`);

// ─── 5. 检查 cron_run_log 有自动触发记录 ──────────────────────────
console.log('\n=== 5. 检查 cron_run_log（自动触发证据）===');

const logs = queryAll<{ status: string; result_text: string; duration_ms: number }>(
  'SELECT status, result_text, duration_ms FROM cron_run_log WHERE job_id = ?',
  [job.id],
);

assert(logs.length >= 1, `cron_run_log 有 ${logs.length} 条记录（setTimeout 自动触发）`);

if (logs.length >= 1) {
  const log = logs[0]!;
  assert(log.status === 'success', `log status = success（时间驱动执行成功）`);
  assert(
    log.result_text?.startsWith('evolve: detected'),
    `log result_text = "${log.result_text}"（含 evolve: detected）`,
  );
  console.log(`  ℹ️  duration: ${log.duration_ms}ms`);
}

// ─── 6. 检查经验文件被生成 ───────────────────────────────────────
console.log('\n=== 6. 检查经验文件被生成（时间驱动 → 自进化闭环）===');

const files = readdirSync(TMP_DERIVED);
const expFiles = files.filter((f) => f.startsWith('EXP-DRV-') && f.endsWith('.md'));
assert(expFiles.length >= 1, `derived 目录生成 ${expFiles.length} 个经验文件`);

if (expFiles.length >= 1) {
  console.log(`  ℹ️  生成文件: ${expFiles.join(', ')}`);
}

// ─── 7. 停止 cron engine ─────────────────────────────────────────
console.log('\n=== 7. 停止 cron engine ===');

stopCronEngine();
console.log('  ℹ️  cron engine 已停止');

// ─── 清理 ─────────────────────────────────────────────────────────
closeDb();
for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`, TMP_DERIVED]) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

// ─── 汇总 ─────────────────────────────────────────────────────────
console.log('\n=== 汇总 ===');
console.log(`通过: ${passed}, 失败: ${failed}`);
console.log('');
if (failed > 0) {
  console.log('❌ L3 真实时间驱动调度验证失败');
  process.exit(1);
} else {
  console.log('✅ L3 真实时间驱动调度验证通过');
  console.log('   证据：cron engine setTimeout 真实到期 → executeJob 自动执行 → 经验文件生成');
  console.log('   闭环维度：自动（L3 时间驱动）+ 自进化（M3 检测+起草）');
  console.log('   注：本次为 setTimeout 真实触发（非 triggerJob 手动触发），证明时间驱动真实工作');
  process.exit(0);
}
