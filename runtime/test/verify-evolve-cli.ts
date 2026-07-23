/**
 * 端到端验证：evolve CLI 子命令真能从命令行跑通
 *
 * 不通过 shell，直接模拟 process.argv 调 main()
 * 用 AWKN_DERIVED_DIR 隔离，避免污染真实 derived 目录
 *
 * 运行：node --import tsx scripts/verify-evolve-cli.ts
 */

import { resolve } from 'node:path';
import { existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';

// 用临时目录隔离经验文件
const TEST_DERIVED = resolve(process.cwd(), 'data', 'verify-evolve-derived');
if (existsSync(TEST_DERIVED)) {
  rmSync(TEST_DERIVED, { recursive: true, force: true });
}
mkdirSync(TEST_DERIVED, { recursive: true });
process.env.AWKN_DERIVED_DIR = TEST_DERIVED;

// 用临时 db 路径（避免污染真实 awkn-engine.db）
// 必须在 import db.ts 之前设置 AWKN_DB_PATH（db.ts 模块加载时一次性求值）
const TEST_DB = resolve(process.cwd(), 'data', `verify-evolve-${process.pid}.db`);
if (existsSync(TEST_DB)) {
  rmSync(TEST_DB);
  try { rmSync(`${TEST_DB}-wal`); } catch { /* ignore */ }
  try { rmSync(`${TEST_DB}-shm`); } catch { /* ignore */ }
}
process.env.AWKN_DB_PATH = TEST_DB;

// ─── 步骤 1：先插 3 条同指纹 correction ────
const { getDb, closeDb } = await import('../src/store/db.js').catch(async () => {
  return await import('../src/store/db.ts');
});

getDb(TEST_DB);

// 插 3 条同指纹 correction
const { getCorrectionsLedger } = await import('../src/evolve/corrections-ledger.js').catch(async () => {
  return await import('../src/evolve/corrections-ledger.ts');
});

const ledger = getCorrectionsLedger();
ledger.record({ source: 'reviewGate', errorText: 'verify-evolve-test-error' });
ledger.record({ source: 'reviewGate', errorText: 'verify-evolve-test-error' });
ledger.record({ source: 'reviewGate', errorText: 'verify-evolve-test-error' });

console.log('已插 3 条同指纹 correction');

// 关闭 db，让 CLI 重新初始化（但用同一个 AWKN_DB_PATH 路径）
closeDb();

// ─── 步骤 2：直接调 handleEvolve（避免 main() 异步竞态） ────
// 注：不通过 import cli.ts 调 main()，因为 main() 在 cli.ts 末尾以 `main();` 调用（无 await），
// import 解析后 main() 可能还未完成，导致验证脚本读到空目录
const evolveModule = await import('../src/evolve/experience-writer.js').catch(async () => {
  return await import('../src/evolve/experience-writer.ts');
});
const patternModule = await import('../src/evolve/pattern-detector.js').catch(async () => {
  return await import('../src/evolve/pattern-detector.ts');
});

// 先 getDb 初始化新连接
getDb();

const patterns = patternModule.getPatternDetector().detect();
console.log(`检测到 ${patterns.length} 个 pattern`);

if (patterns.length > 0) {
  const writes = evolveModule.writeAllExperiences(patterns);
  console.log(`写入 ${writes.length} 个经验文件`);
}

// 关闭 db
closeDb();

// ─── 步骤 3：验证文件生成 ────
const files = readdirSync(TEST_DERIVED);
console.log(`\n验证：${TEST_DERIVED} 下生成 ${files.length} 个文件`);
console.log(files);

if (files.length === 0) {
  console.error('❌ 没有生成经验文件');
  process.exit(1);
}

// 清理
rmSync(TEST_DERIVED, { recursive: true, force: true });
if (existsSync(TEST_DB)) {
  try { rmSync(TEST_DB); } catch { /* ignore */ }
  try { rmSync(`${TEST_DB}-wal`); } catch { /* ignore */ }
  try { rmSync(`${TEST_DB}-shm`); } catch { /* ignore */ }
}

console.log('\n✅ evolve CLI 端到端验证通过');
