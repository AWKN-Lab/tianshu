'use strict';
// tianhuo/scripts/check-markdown-assets.js
// ────────────────────────────────────────────────────────────────────────────
// agents/ 派生产物机械门：Markdown 最小完整性校验
//
// 扫描范围（仅派生产物，不做全仓库语义审查）：
//   - agents/** 下位于任意 derived/ 目录内的 *.md
//   - agents/** 下文件名形如 EXP-DRV-*.md 的文件
//
// 只拦机械性损坏，明确不做：排版风格、中文文案质量、链接联网验证、runtime 编译。
//   1. 文件可按 UTF-8 严格解码（fatal 解码器）
//   2. 文件大小 > 0
//   3. 去除空白后仍有内容
//   4. 不含 NUL 字节
//   5. 大小不超过 5 MB（异常巨型文件报警）
// 任何错误 → exit code 1（本地/pre-push 门拦截）
// ────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');

const agentsRoot = path.resolve(__dirname, '..', '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.archive', '_archived']);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const errors = [];
const stats = { checked: 0, derived: 0, expDrv: 0 };

function isTarget(rel, base) {
  const norm = rel.split(path.sep).join('/');
  if (/(^|\/)derived\//.test(norm)) return 'derived';
  if (/^EXP-DRV-.*\.md$/.test(base)) return 'expdrv';
  return null;
}

function checkFile(full, rel) {
  stats.checked += 1;
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch (error) {
    errors.push(`unreadable ${rel}: ${error.message}`);
    return;
  }

  if (buf.length === 0) {
    errors.push(`empty file ${rel}`);
    return;
  }
  if (buf.length > MAX_BYTES) {
    errors.push(`oversized file ${rel}: ${buf.length} bytes > ${MAX_BYTES}`);
    return;
  }
  if (buf.includes(0)) {
    errors.push(`NUL byte present ${rel}`);
    return;
  }

  let text;
  try {
    text = decoder.decode(buf);
  } catch (error) {
    errors.push(`invalid UTF-8 ${rel}: ${error.message}`);
    return;
  }
  if (text.trim().length === 0) {
    errors.push(`blank after trim ${rel}`);
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const rel = path.relative(agentsRoot, full);
      const kind = isTarget(rel, entry.name);
      if (!kind) continue;
      if (kind === 'derived') stats.derived += 1;
      else stats.expDrv += 1;
      checkFile(full, rel);
    }
  }
}

walk(agentsRoot);

const report = {
  checkedRoot: agentsRoot,
  filesChecked: stats.checked,
  derivedMd: stats.derived,
  expDrvMd: stats.expDrv,
  errors,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (errors.length > 0) process.exitCode = 1;
