/**
 * L3 自动触发自进化 端到端验证
 *
 * 验证链路：
 * 1. 插入 3 条同指纹 correction 到 corrections_ledger
 * 2. 注册 evolve cron job
 * 3. triggerJob 立即触发
 * 4. executeJob 调 runEvolveOnce → pattern-detector.detect → experience-writer.writeAllExperiences
 * 5. 验证经验文件被生成到 derived 目录
 * 6. 验证 cron_run_log 记录成功
 *
 * 这是"自动（L3 cron）+ 自进化（M3 evolve）"闭环的首个端到端验证。
 * 不依赖 LLM provider — pattern-detector 和 experience-writer 都是确定性代码。
 *
 * 运行：node --import tsx test/verify-cron-evolve.ts
 * 退出码：0 = 全部通过，1 = 有失败
 */

import { existsSync, readdirSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb, closeDb, queryAll } from '../src/store/db.js';
import { getCorrectionsLedger } from '../src/evolve/corrections-ledger.js';
import { getCronJobsManager } from '../src/cron/jobs-manager.js';
import { getCronEngine } from '../src/cron/engine.js';

// ─── 测试隔离：临时目录 ───────────────────────────────────────────
const TMP_DB = resolve(process.cwd(), 'data', `test-cron-evolve-${process.pid}.db`);
const TMP_DERIVED = resolve(process.cwd(), 'data', `test-cron-evolve-derived-${process.pid}`);

// 清理旧数据
for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`, TMP_DERIVED]) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}
mkdirSync(TMP_DERIVED, { recursive: true });

// 设置环境变量（experience-writer 和 db 都会读）
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

// ─── 1. 初始化 db + 插入 3 条同指纹 correction ───────────────────
console.log('\n=== 1. 插入 3 条同指纹 correction（模拟 3 次同源错误）===');

getDb(TMP_DB);

const ledger = getCorrectionsLedger();
const records: Array<{ id: string; fingerprint: string }> = [];
for (let i = 0; i < 3; i++) {
  const r = ledger.record({
    source: 'cron-evolve-test',
    severity: 'error',
    errorText: `TypeError: Cannot read property 'config' of undefined\n    at loadConfig (config.ts:42:15)`,
    goalId: 'goal-cron-evolve-test',
  });
  records.push(r);
}

assert(records.length === 3, `插入 3 条 correction`);
assert(
  records[0]!.fingerprint === records[1]!.fingerprint &&
    records[1]!.fingerprint === records[2]!.fingerprint,
  `3 条 correction 同指纹（${records[0]!.fingerprint}）`,
);

// ─── 2. 注册 evolve cron job ─────────────────────────────────────
console.log('\n=== 2. 注册 evolve cron job ===');

const job = getCronJobsManager().add({
  name: '每日自进化检测',
  cronExpr: '0 0 * * *', // 每天 00:00
  actionType: 'evolve',
  actionPayload: {},
});

assert(!!job.id, `cron job 创建成功 (id=${job.id})`);
assert(job.action_type === 'evolve', `action_type = evolve`);
assert(job.enabled === 1, `job enabled = 1`);

// ─── 3. triggerJob 立即触发 ─────────────────────────────────────
console.log('\n=== 3. triggerJob 立即触发（模拟 cron 到期）===');

const engine = getCronEngine();
const triggerResult = await engine.triggerJob(job.id);

assert(triggerResult.ok === true, `triggerJob ok=true`);
assert(!triggerResult.error, `triggerJob 无错误`);
console.log(`  ℹ️  duration: ${triggerResult.durationMs}ms`);

// ─── 4. 验证经验文件被生成 ───────────────────────────────────────
console.log('\n=== 4. 验证经验文件被生成到 derived 目录 ===');

const files = readdirSync(TMP_DERIVED);
const expFiles = files.filter((f) => f.startsWith('EXP-DRV-') && f.endsWith('.md'));
// 3 条同指纹+同 goal 的 correction 触发 2 种 pattern：
//   - repeated_fingerprint（同指纹 >= 3 次）
//   - goal_repeat（同 goal >= 2 次）
assert(expFiles.length === 2, `derived 目录生成 ${expFiles.length} 个经验文件（期望 2：repeated_fingerprint + goal_repeat）`);

if (expFiles.length >= 1) {
  const content = readFileSync(resolve(TMP_DERIVED, expFiles[0]!), 'utf-8');
  assert(
    content.includes('**状态**: 待人工补充'),
    '经验文件含"待人工补充"标记（等待 awkn-复盘总结 补全）',
  );
  assert(
    content.includes('cron-evolve-test'),
    '经验文件含 source=cron-evolve-test',
  );
  // 两个文件分别含 repeated_fingerprint 和 goal_repeat
  const allContent = expFiles
    .map((f) => readFileSync(resolve(TMP_DERIVED, f), 'utf-8'))
    .join('\n---\n');
  assert(
    allContent.includes('repeated_fingerprint') || allContent.includes('goal_repeat'),
    '经验文件含 pattern kind（repeated_fingerprint 或 goal_repeat）',
  );
}

// ─── 5. 验证 cron_run_log 记录成功 ───────────────────────────────
console.log('\n=== 5. 验证 cron_run_log 记录成功 ===');

const logs = queryAll<{ status: string; result_text: string; error_text: string | null }>(
  'SELECT status, result_text, error_text FROM cron_run_log WHERE job_id = ?',
  [job.id],
);
assert(logs.length === 1, `cron_run_log 有 ${logs.length} 条记录（期望 1）`);

if (logs.length >= 1) {
  const log = logs[0]!;
  assert(log.status === 'success', `log status = success`);
  assert(
    log.result_text?.startsWith('evolve: detected 2 patterns, wrote 2 files'),
    `log result_text = "${log.result_text}"（含 detected 2 patterns, wrote 2 files）`,
  );
  assert(log.error_text === null, `log error_text = null`);
}

// ─── 6. 验证 corrections_ledger 在候选激活前保持开放 ──────────────
console.log('\n=== 6. 验证 corrections_ledger 在 DRAFT 阶段保持 open ===');

const openCorrections = queryAll<{ status: string }>(
  'SELECT status FROM corrections_ledger WHERE fingerprint = ?',
  [records[0]!.fingerprint],
);
const openCount = openCorrections.filter((c) => c.status === 'open').length;
assert(
  openCount === 3,
  `3 条 correction 在候选激活前保持 open`,
);

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
  console.log('❌ L3 自动触发自进化端到端验证失败');
  process.exit(1);
} else {
  console.log('✅ L3 自动触发自进化端到端验证通过');
  console.log('   闭环验证：cron trigger → executeJob → runEvolveOnce → pattern-detector → experience-writer → 经验文件生成');
  console.log('   闭环维度：自动（L3 cron 调度）+ 自进化（M3 检测+起草）');
  process.exit(0);
}
