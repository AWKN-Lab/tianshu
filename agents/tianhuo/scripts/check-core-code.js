'use strict';
// tianhuo/scripts/check-core-code.js
// ────────────────────────────────────────────────────────────────────────────
// harness 核心边界配置机械门：.better-harness/core-code 校验
// core-code 是纯文本 pattern 文件（每行一个路径 pattern；`!` 前缀排除；`#` 注释）
// 只拦机械性损坏与漂移，不做语义审查：
//   1. 文件存在、可读、UTF-8 可解码
//   2. 每行 pattern 语法合法（无空白、`!` 仅行首、允许 ** 通配）
//   3. include 规则至少 1 条（configured-core-boundary 前提）
//   4. 引用的 runtime/src/<模块> 目录必须存在于仓库（防 owner 路由漂移）
//   5. 无重复 pattern
// 任何错误 → exit code 1（本地/pre-push/CI 门拦截）
// ────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const coreCodeFile = path.resolve(repoRoot, '.better-harness', 'core-code');

const errors = [];
const warnings = [];
const stats = { include: 0, exclude: 0, patterns: [] };

// 1. 文件存在且可读
let text;
try {
  text = fs.readFileSync(coreCodeFile, 'utf8');
} catch (error) {
  errors.push(`unreadable ${path.relative(repoRoot, coreCodeFile)}: ${error.message}`);
  printReport();
  return;
}

// 逐行解析：去注释与空白
const seen = new Set();
for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;

  const exclude = line.startsWith('!');
  const pattern = exclude ? line.slice(1) : line;

  // 2. pattern 语法：非空、无空白字符、`!` 仅行首
  if (!pattern || /\s/.test(pattern)) {
    errors.push(`invalid pattern (whitespace or empty): ${JSON.stringify(line)}`);
    continue;
  }
  if (/^[!].*[!]/.test(line)) {
    errors.push(`'!' only allowed as first char: ${JSON.stringify(line)}`);
    continue;
  }

  // 3. 模块目录存在性：仅检查 runtime/src/<模块> 形态的 pattern
  const moduleMatch = pattern.match(/^runtime\/src\/([^/]+)\/\*\*$/);
  if (moduleMatch) {
    const moduleDir = path.join(repoRoot, 'runtime', 'src', moduleMatch[1]);
    if (!fs.existsSync(moduleDir)) {
      errors.push(`pattern references missing module dir: runtime/src/${moduleMatch[1]}/ (${line})`);
    }
  } else if (!pattern.startsWith('runtime/src/')) {
    warnings.push(`pattern outside runtime/src/ boundary (not checked for module existence): ${line}`);
  }

  // 5. 无重复 pattern
  if (seen.has(pattern)) {
    errors.push(`duplicate pattern: ${line}`);
  }
  seen.add(pattern);

  if (exclude) stats.exclude += 1;
  else stats.include += 1;
  stats.patterns.push(line);
}

// 3. include 至少 1 条
if (stats.include === 0) {
  errors.push('no include pattern found (configured-core-boundary requires >= 1 include)');
}

function printReport() {
  const report = {
    checkedFile: path.relative(repoRoot, coreCodeFile),
    includeCount: stats.include,
    excludeCount: stats.exclude,
    warnings,
    errors,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (errors.length > 0) process.exitCode = 1;
}

printReport();
