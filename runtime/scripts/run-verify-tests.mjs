import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(runtimeRoot, 'test');

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

const verifyTests = listVerifyTests(testRoot);

if (verifyTests.length === 0) {
  console.error(`No verify-*.ts tests found under ${testRoot}`);
  process.exit(1);
}

console.log(`Running ${verifyTests.length} verify test file(s)`);
for (const file of verifyTests) console.log(`- ${toPosix(relative(runtimeRoot, file))}`);
console.log('');

let passed = 0;
let failed = 0;
const failures = [];

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
  } else {
    failed++;
    failures.push(`${rel} (exit ${result.status ?? 'null'})`);
  }
  console.log('');
}

console.log('=== Verify Tests Summary ===');
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailed:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`\nAll ${passed} verify test file(s) passed`);
