'use strict';
// tianhuo/scripts/check-markdown-assets.js
// ────────────────────────────────────────────────────────────────────────────
// agents/ 派生产物门禁：Markdown 机械完整性 + INDEX 一致性
//
// 扫描范围（仅派生产物，不做全仓库语义审查）：
//   - agents/** 下位于任意 derived/ 目录内的 *.md
//   - agents/** 下文件名形如 EXP-DRV-*.md 的文件
//   - 所有 INDEX.md 与 EXP-{DRV,FIX,CAP}-YYYYMMDD-NNN.md 的引用关系
//
// 机械层（只拦损坏，明确不做：排版风格、中文文案质量、链接联网验证、runtime 编译）：
//   1. 文件可按 UTF-8 严格解码（fatal 解码器）
//   2. 文件大小 > 0
//   3. 去除空白后仍有内容
//   4. 不含 NUL 字节
//   5. 大小不超过 5 MB（异常巨型文件报警）
// INDEX 一致性层（语义关系，防索引悬空 / 漏索引）：
//   - error   ：INDEX.md 引用的 EXP-{DRV,FIX,CAP} ID 无对应文件（阻塞）
//   - warning ：非 DRAFT 的 EXP 文件未被任何 INDEX.md 引用（不阻塞）
// 任何 error → exit code 1（本地/pre-push 门拦截）；warning 仅提示
// ────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');

const agentsRoot = path.resolve(__dirname, '..', '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.archive', '_archived']);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const errors = [];
const warnings = [];
const stats = { checked: 0, derived: 0, expDrv: 0 };

// INDEX 一致性收集器：所有 INDEX.md 的引用集 与 所有 EXP-DRV/FIX/CAP 文件清单
const indexFiles = [];
const expFiles = new Map(); // id -> { file, status }
const DRAFT_RE = /DRAFT|待人工|待回放/;

// 统一 EXP 资产 ID 形状（DRV/FIX/CAP + YYYYMMDD-NNN）。文件收集与 INDEX 引用共用同一模式，
// 避免两套正则漂移导致“INDEX 引用了未跟踪类型”被误判为悬空而阻塞推送。
const EXP_ID_PATTERN = 'EXP-(?:DRV|FIX|CAP)-\\d{8}-\\d{3}';

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

function readStatusLine(full) {
  try {
    const head = fs.readFileSync(full, 'utf8').slice(0, 2048);
    const m = head.match(/状态[^:\n]*[:：]\s*([^\n]+)/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

// INDEX ↔ 派生文件一致性：
//   error   - INDEX.md 引用的 EXP-ID 找不到对应文件（防索引悬空）
//   warning - 非 DRAFT 状态的 EXP-DRV/FIX/CAP 文件未被任何 INDEX.md 引用（防漏索引）
function checkIndexConsistency() {
  const refs = new Set();
  for (const indexFile of indexFiles) {
    let text;
    try {
      text = fs.readFileSync(indexFile, 'utf8');
    } catch (error) {
      errors.push(`unreadable index ${path.relative(agentsRoot, indexFile)}: ${error.message}`);
      continue;
    }
    for (const m of text.matchAll(new RegExp(EXP_ID_PATTERN, 'g'))) refs.add(m[0]);
  }
  for (const id of refs) {
    if (!expFiles.has(id)) {
      errors.push(`INDEX references missing file: ${id}`);
    }
  }
  for (const [id, info] of expFiles) {
    if (refs.has(id)) continue;
    if (!DRAFT_RE.test(info.status)) {
      warnings.push(`non-draft EXP not indexed: ${id} (status: ${info.status || '(none)'})`);
    }
  }
  stats.indexFiles = indexFiles.length;
  stats.indexRefs = refs.size;
  stats.expFiles = expFiles.size;
  stats.unindexedNonDraft = warnings.filter((w) => w.startsWith('non-draft EXP not indexed')).length;
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const rel = path.relative(agentsRoot, full);
      if (entry.name === 'INDEX.md') indexFiles.push(full);
      const expMatch = entry.name.match(new RegExp(`^(${EXP_ID_PATTERN})\\.md$`));
      if (expMatch && !expFiles.has(expMatch[1])) {
        expFiles.set(expMatch[1], { file: full, status: readStatusLine(full) });
      }
      const kind = isTarget(rel, entry.name);
      if (!kind) continue;
      if (kind === 'derived') stats.derived += 1;
      else stats.expDrv += 1;
      checkFile(full, rel);
    }
  }
}

walk(agentsRoot);
checkIndexConsistency();

const report = {
  checkedRoot: agentsRoot,
  filesChecked: stats.checked,
  derivedMd: stats.derived,
  expDrvMd: stats.expDrv,
  indexConsistency: {
    indexFiles: stats.indexFiles,
    indexRefs: stats.indexRefs,
    expFiles: stats.expFiles,
    unindexedNonDraft: stats.unindexedNonDraft,
  },
  warnings,
  errors,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (errors.length > 0) process.exitCode = 1;
