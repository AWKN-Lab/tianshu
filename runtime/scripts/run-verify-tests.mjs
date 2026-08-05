import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(runtimeRoot, 'test');
const knownFailuresPath = join(runtimeRoot, 'verify-known-failures.json');

function toPosix(value) {
  return value.split(sep).join('/');
}

// 门禁白名单：verify-known-failures.json（文档声明见 docs/2026-07-28-授权确认书-Phase5接力与Phase6启动决策.md 决策 C）。
// 兼容两种格式：对象格式 { knownFailures: [{ file, reason, ... }] }（v1/v2 结构）或纯字符串数组。
// 文件缺失/格式无效时按空名单处理（无豁免），保持严格验收边界：任何失败都阻断。
function loadKnownFailures() {
  if (!existsSync(knownFailuresPath)) {
    console.warn(`[verify] 白名单 ${toPosix(relative(runtimeRoot, knownFailuresPath))} 缺失，按空名单处理（无豁免，任何失败均阻断）`);
    return new Set();
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(knownFailuresPath, 'utf8'));
  } catch (err) {
    console.warn(`[verify] 白名单解析失败（${err.message}），按空名单处理（无豁免，任何失败均阻断）`);
    return new Set();
  }
  let entries;
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (Array.isArray(raw?.knownFailures)) {
    entries = raw.knownFailures;
  } else {
    console.warn('[verify] 白名单格式无效（应为 { knownFailures: [...] } 或字符串数组），按空名单处理（无豁免）');
    return new Set();
  }
  const known = new Set();
  for (const entry of entries) {
    const file = typeof entry === 'string' ? entry : entry?.file;
    if (typeof file === 'string' && file.length > 0) {
      known.add(toPosix(file).replace(/^\.\//, ''));
    } else {
      console.warn(`[verify] 白名单条目缺少 file 字段，忽略：${JSON.stringify(entry)}`);
    }
  }
  return known;
}

function listVerifyTests() {
  const files = [];
  for (const entry of readdirSync(testRoot).sort()) {
    const fullPath = join(testRoot, entry);
    const stat = statSync(fullPath);
    if (stat.isFile() && entry.startsWith('verify-') && entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const verifyTests = listVerifyTests();
const knownFailures = loadKnownFailures();

if (verifyTests.length === 0) {
  console.error('No verify-*.ts tests found under test/');
  process.exit(1);
}

const testRels = new Set(verifyTests.map((file) => toPosix(relative(runtimeRoot, file))));

// 白名单 drift 检测：条目不是现有测试 → 过期条目（仅警告，不阻断）
for (const entry of knownFailures) {
  if (!testRels.has(entry)) {
    console.warn(`[verify] 白名单条目 "${entry}" 不是现有 verify 测试（过期条目，可从 verify-known-failures.json 移除）`);
  }
}

console.log(`Running ${verifyTests.length} verify test file(s)`);
for (const file of verifyTests) {
  console.log(`- ${toPosix(relative(runtimeRoot, file))}`);
}
if (knownFailures.size > 0) {
  console.log(`Known-failure whitelist (${knownFailures.size}):`);
  for (const entry of knownFailures) console.log(`- ${entry}`);
}
console.log('');

let passed = 0;
let failed = 0;
let exempted = 0;
const failures = [];
const exemptedList = [];

for (const file of verifyTests) {
  const rel = toPosix(relative(runtimeRoot, file));
  console.log(`▶ ${rel}`);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', file],
    {
      cwd: runtimeRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (result.status === 0) {
    passed++;
    if (knownFailures.has(rel)) {
      console.log(`[verify] 白名单条目 "${rel}" 已通过，可从 verify-known-failures.json 移除（drift 提示，不阻断）`);
    }
  } else if (knownFailures.has(rel)) {
    exempted++;
    exemptedList.push(`${rel} (exit ${result.status})`);
  } else {
    failed++;
    failures.push(`${rel} (exit ${result.status})`);
  }
  console.log('');
}

console.log('===== Verify Test Summary =====');
console.log(`Passed: ${passed}/${verifyTests.length}`);
console.log(`Known-failure exempted (in whitelist): ${exempted}`);
console.log(`Blocking failures (not in whitelist): ${failed}/${verifyTests.length}`);
if (exemptedList.length > 0) {
  console.log('Exempted failures (verify-known-failures.json):');
  for (const f of exemptedList) console.log(`  - ${f}`);
}
if (failures.length > 0) {
  console.log('Blocking failures (NOT in verify-known-failures.json):');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('Gate policy: failures inside verify-known-failures.json are exempt; any other failure blocks (exit 1).');
  process.exit(1);
}
console.log('Gate policy: failures inside verify-known-failures.json are exempt; any other failure blocks (exit 1).');
