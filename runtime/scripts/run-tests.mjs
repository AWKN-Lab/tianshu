import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(runtimeRoot, 'test');
const mode = process.argv[2] ?? 'all';

if (!['unit', 'contracts', 'all'].includes(mode)) {
  console.error(`Unknown test mode: ${mode}`);
  process.exit(2);
}

function toPosix(value) {
  return value.split(sep).join('/');
}

function listTests(directory, recursive) {
  const files = [];
  for (const entry of readdirSync(directory).sort()) {
    const fullPath = join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (recursive) files.push(...listTests(fullPath, true));
      continue;
    }
    if (stat.isFile() && entry.endsWith('.test.ts')) files.push(fullPath);
  }
  return files;
}

const unitTests = listTests(testRoot, false);
const contractTests = listTests(join(testRoot, 'contracts'), true);
const selected = mode === 'unit'
  ? unitTests
  : mode === 'contracts'
    ? contractTests
    : [...unitTests, ...contractTests];

if (selected.length === 0) {
  console.error(`No ${mode} tests found under ${testRoot}`);
  process.exit(1);
}

const relativeFiles = selected.map((file) => toPosix(relative(runtimeRoot, file)));
console.log(`Running ${relativeFiles.length} ${mode} test file(s)`);
for (const file of relativeFiles) console.log(`- ${file}`);

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...relativeFiles],
  {
    cwd: runtimeRoot,
    stdio: 'inherit',
    env: process.env,
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
