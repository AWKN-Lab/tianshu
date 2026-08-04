'use strict';
// tianhuo/scripts/check-structured-assets.js
// ────────────────────────────────────────────────────────────────────────────
// agents/ 变更域机械门：结构化资产语法校验
// - 遍历 agents/ 下所有 *.json → JSON.parse 严格校验（零依赖，必跑）
// - 遍历 agents/ 下所有 *.yaml / *.yml → js-yaml 加载校验
//   （js-yaml 可选：优先复用 tianhuo/gates 的依赖；不可用时跳过 YAML 校验，
//    仅警告，JSON 校验仍然强制）
// 任何校验错误 → exit code 1（CI 门拦截）
// ────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');

const agentsRoot = path.resolve(__dirname, '..', '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.archive']);
const errors = [];
const warnings = [];
const stats = { json: 0, yaml: 0 };

// 可选依赖：优先复用 gates 子系统已声明的 js-yaml
let yaml = null;
try {
  yaml = require(require.resolve('js-yaml', { paths: [path.resolve(agentsRoot, 'tianhuo', 'gates')] }));
} catch {
  warnings.push('js-yaml unavailable: YAML structural checks skipped (JSON checks still enforced)');
}

function checkJson(full) {
  stats.json += 1;
  try {
    JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    errors.push(`invalid JSON ${path.relative(agentsRoot, full)}: ${error.message}`);
  }
}

function checkYaml(full) {
  stats.yaml += 1;
  if (!yaml) return;
  try {
    yaml.load(fs.readFileSync(full, 'utf8'), { filename: full });
  } catch (error) {
    errors.push(`invalid YAML ${path.relative(agentsRoot, full)}: ${error.message}`);
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith('.json')) checkJson(full);
      else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) checkYaml(full);
    }
  }
}

walk(agentsRoot);

const report = {
  checkedRoot: agentsRoot,
  jsonFilesChecked: stats.json,
  yamlFilesChecked: stats.yaml,
  warnings,
  errors,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (errors.length > 0) process.exitCode = 1;
