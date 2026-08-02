import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(runtimeRoot, 'test');
const mode = process.argv[2] ?? 'all';

if (!['unit', 'contracts', 'verify', 'all'].includes(mode)) {
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

/**
 * Discover verify-*.ts scripts in test/ root (non-recursive).
 * These are historical validation scripts that were previously not
 * included in the default gate.
 */
function listVerifyScripts(directory) {
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

/**
 * Check if a file uses node:test API (import from 'node:test').
 * Files using node:test can be run with `node --test`.
 * Files with custom assert need to be run with `tsx` directly.
 */
function usesNodeTest(filePath) {
  const source = readFileSync(filePath, 'utf8');
  return /from\s+['"]node:test['"]/.test(source);
}

const unitTests = listTests(testRoot, false);
const contractTests = listTests(join(testRoot, 'contracts'), true);
const verifyScripts = listVerifyScripts(testRoot);

let selected;
if (mode === 'unit') {
  selected = unitTests;
} else if (mode === 'contracts') {
  selected = contractTests;
} else if (mode === 'verify') {
  selected = verifyScripts;
} else {
  selected = [...unitTests, ...contractTests, ...verifyScripts];
}

if (selected.length === 0) {
  console.error(`No ${mode} tests found under ${testRoot}`);
  process.exit(1);
}

// 隔离 EventStore：契约/单元测试绝不允许写生产 data/awkn-engine.db。
// 除非调用方已显式设置 AWKN_DB_PATH，否则注入临时 db，避免：
// - 测试 run 污染生产 EventStore（stale 'running' 记录阻塞真实 pipeline）
// - 与并发 pipeline（win-cicd 等）争抢同一 SQLite 写锁导致偶发失败
let isolatedDbDir = null;
if (!process.env.AWKN_DB_PATH && mode !== 'verify') {
  isolatedDbDir = mkdtempSync(join(tmpdir(), 'awkn-tests-'));
  process.env.AWKN_DB_PATH = join(isolatedDbDir, 'test.db');
  console.log(`Isolated AWKN_DB_PATH=${process.env.AWKN_DB_PATH}`);
}

/**
 * 测试进程净化 env：剔除宿主运行配置（runtime/.env 经 loadRuntimeEnv 注入），
 * 避免策略/路由/密钥类变量泄漏进断言（例如 AWKN_APPROVED_TOOLS=exec,write
 * 使 tool-policy 判定 write 已批准；AWKN_LLM_PROVIDER=codex 劫持 router
 * provider 选择，导致 CICD（经 action-cli 启动）与本地直跑行为不一致）。
 * 仅保留隔离 DB 路径，其余 AWKN_* 一律移除（verify 脚本依赖宿主配置，不净化）。
 */
function buildTestEnv() {
  if (mode === 'verify') return process.env;
  const sanitized = { ...process.env };
  for (const key of Object.keys(sanitized)) {
    if (key.startsWith('AWKN_') && key !== 'AWKN_DB_PATH') delete sanitized[key];
  }
  return sanitized;
}
const testEnv = buildTestEnv();

const relativeFiles = selected.map((file) => toPosix(relative(runtimeRoot, file)));
console.log(`Running ${relativeFiles.length} ${mode} test file(s)`);
for (const file of relativeFiles) console.log(`- ${file}`);
console.log('');

// Split files into node:test compatible and standalone (custom assert)
const nodeTestFiles = [];
const standaloneFiles = [];
for (let i = 0; i < selected.length; i++) {
  if (usesNodeTest(selected[i])) {
    nodeTestFiles.push(relativeFiles[i]);
  } else {
    standaloneFiles.push(relativeFiles[i]);
  }
}

let overallStatus = 0;

// Run node:test compatible files with `node --import tsx --test`
if (nodeTestFiles.length > 0) {
  console.log(`--- node:test files (${nodeTestFiles.length}) ---`);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', ...nodeTestFiles],
    {
      cwd: runtimeRoot,
      stdio: 'inherit',
      env: testEnv,
    },
  );
  if (result.error) {
    console.error(result.error);
    overallStatus = 1;
  } else {
    overallStatus = overallStatus || (result.status ?? 1);
  }
}

// Run standalone scripts (custom assert) with `tsx` directly
for (const file of standaloneFiles) {
  console.log(`\n--- standalone verify script: ${file} ---`);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', file],
    {
      cwd: runtimeRoot,
      stdio: 'inherit',
      env: testEnv,
    },
  );
  if (result.error) {
    console.error(result.error);
    overallStatus = 1;
  } else {
    overallStatus = overallStatus || (result.status ?? 1);
  }
}

if (isolatedDbDir) {
  try {
    rmSync(isolatedDbDir, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不阻塞退出码
  }
}

process.exit(overallStatus);
