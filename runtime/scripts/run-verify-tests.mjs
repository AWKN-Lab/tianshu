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

function listVerifyTests(directory) {
  const files = [];
  for (const entry of readdirSync(directory).sort()) {
    const fullPath = join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isFile() && entry.startsWith('verify-') && entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/** 读取已知失败白名单 */
function loadKnownFailures() {
  if (!existsSync(knownFailuresPath)) {
    return new Set();
  }
  try {
    const data = JSON.parse(readFileSync(knownFailuresPath, 'utf-8'));
    const files = (data.knownFailures ?? []).map((f) => f.file);
    return new Set(files.map(toPosix));
  } catch (err) {
    console.error(`Warning: Failed to parse ${knownFailuresPath}: ${err.message}`);
    return new Set();
  }
}

const knownFailures = loadKnownFailures();

const verifyTests = listVerifyTests(testRoot);

if (verifyTests.length === 0) {
  console.error(`No verify-*.ts tests found under ${testRoot}`);
  process.exit(1);
}

console.log(`Running ${verifyTests.length} verify test file(s)`);
for (const file of verifyTests) console.log(`- ${toPosix(relative(runtimeRoot, file))}`);
if (knownFailures.size > 0) {
  console.log(`\nKnown failures (whitelisted, non-blocking): ${knownFailures.size}`);
  for (const f of knownFailures) console.log(`  - ${f}`);
}
console.log('');

let passed = 0;
let failed = 0;
const failures = [];
const newFailures = []; // 不在白名单中的失败（阻断 CI）

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
    // 如果文件在白名单中但现在通过了，提示移除
    if (knownFailures.has(rel)) {
      console.log(`  ℹ️  ${rel} 现在通过了！请从 verify-known-failures.json 中移除。`);
    }
  } else {
    failed++;
    failures.push(`${rel} (exit ${result.status ?? 'null'})`);
    if (knownFailures.has(rel)) {
      console.log(`  ⚠️  已知失败（白名单，不阻断）: ${rel}`);
    } else {
      newFailures.push(rel);
      console.log(`  🚨 新失败（不在白名单，将阻断 CI）: ${rel}`);
    }
  }
  console.log('');
}

console.log('=== Verify Tests Summary ===');
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (knownFailures.size > 0) {
  console.log(`Known failures (whitelisted): ${knownFailures.size}`);
}
if (newFailures.length > 0) {
  console.log(`New failures (blocking): ${newFailures.length}`);
}
if (failed > 0) {
  console.log('\nFailed:');
  failures.forEach((f) => console.log(`  - ${f}`));
}
// 只有新失败（不在白名单中）才阻断 CI
if (newFailures.length > 0) {
  console.log(`\n❌ ${newFailures.length} new failure(s) detected — CI blocked`);
  console.log('New failures:');
  newFailures.forEach((f) => console.log(`  - ${f}`));
  console.log('\nTo fix: either fix the test or add it to verify-known-failures.json');
  process.exit(1);
}
console.log(`\n✅ All ${passed} verify test(s) passed (excluding ${knownFailures.size} known failure(s))`);
