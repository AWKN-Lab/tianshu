#!/usr/bin/env node
/**
 * install-mcp-config.mjs — AWKN MCP Server 自动配置安装脚本
 *
 * 用法：
 *   node scripts/install-mcp-config.mjs                    # 检测已安装 IDE 并逐一安装
 *   node scripts/install-mcp-config.mjs --ide trae         # 仅安装到 TRAE
 *   node scripts/install-mcp-config.mjs --ide all --force  # 强制覆盖现有配置
 *   node scripts/install-mcp-config.mjs --dry-run          # 仅打印不写入
 *
 * 支持 IDE: trae / claude-code / cursor / windsurf / codex
 *
 * 设计：
 * - 跨平台路径（Windows/macOS/Linux）
 * - 保留现有 mcpServers，仅合并 awkn-engine 条目
 * - 检测引擎根并自动注入 AWKN_ENGINE_ROOT
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 从脚本位置向上查找引擎根（标记：skills/ + capabilities/project/manifest.yaml）
function findEngineRoot(startDir) {
  let cursor = resolve(startDir);
  for (let depth = 0; depth < 6; depth++) {
    if (
      existsSync(join(cursor, 'skills'))
      && existsSync(join(cursor, 'capabilities', 'project', 'manifest.yaml'))
    ) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

const ENGINE_ROOT = process.env.AWKN_ENGINE_ROOT ?? findEngineRoot(dirname(__dirname));
if (!ENGINE_ROOT) {
  console.error('[install-mcp-config] 错误：无法定位引擎根。请设置 AWKN_ENGINE_ROOT 环境变量。');
  process.exit(1);
}

// MCP_ENTRY 解析：先尝试 <ENGINE_ROOT>/awkn引擎/runtime/bin/awkn-mcp-server.js，
// 若不存在则尝试 <ENGINE_ROOT>/runtime/bin/awkn-mcp-server.js（兼容 awkn-lab/awkn引擎 结构）
function resolveMcpEntry(engineRoot) {
  const candidates = [
    join(engineRoot, 'awkn引擎', 'runtime', 'bin', 'awkn-mcp-server.js'),
    join(engineRoot, 'runtime', 'bin', 'awkn-mcp-server.js'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

const MCP_ENTRY = resolveMcpEntry(ENGINE_ROOT);
if (!existsSync(MCP_ENTRY)) {
  console.error(`[install-mcp-config] 错误：MCP 入口不存在：${MCP_ENTRY}`);
  process.exit(1);
}

// 跨平台路径：Windows 正斜杠，macOS/Linux 原样
function toForwardSlash(p) {
  return platform() === 'win32' ? p.replace(/\\/g, '/') : p;
}

const ENGINE_ROOT_FS = toForwardSlash(ENGINE_ROOT);
const MCP_ENTRY_FS = toForwardSlash(MCP_ENTRY);

const IDE_TARGETS = {
  trae: {
    label: 'TRAE',
    configPath: join(homedir(), '.trae', 'mcp.json'),
    format: 'json',
  },
  'claude-code': {
    label: 'Claude Code',
    configPath: join(homedir(), '.claude', 'mcp.json'),
    format: 'json',
  },
  cursor: {
    label: 'Cursor',
    configPath: join(homedir(), '.cursor', 'mcp.json'),
    format: 'json',
  },
  windsurf: {
    label: 'Windsurf',
    configPath: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'json',
  },
  codex: {
    label: 'Codex CLI',
    configPath: join(homedir(), '.codex', 'config.toml'),
    format: 'toml',
  },
};

function resolveLlBridgeDir(engineRoot) {
  const candidates = [
    join(engineRoot, 'awkn引擎', 'runtime', 'data', 'llm-bridge'),
    join(engineRoot, 'runtime', 'data', 'llm-bridge'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

function buildMcpJsonEnv() {
  return {
    AWKN_ENGINE_ROOT: ENGINE_ROOT_FS,
    AWKN_LLM_BRIDGE_DIR: toForwardSlash(resolveLlBridgeDir(ENGINE_ROOT)),
  };
}

function detectInstalledIdes() {
  const installed = [];
  for (const [key, target] of Object.entries(IDE_TARGETS)) {
    const dir = dirname(target.configPath);
    if (existsSync(dir)) installed.push(key);
  }
  return installed;
}

function readJsonSafe(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.warn(`[install-mcp-config] 警告：${path} JSON 解析失败（${err.message}），将覆盖`);
    return {};
  }
}

function writeJsonSafe(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function buildJsonMcpEntry() {
  return {
    command: 'node',
    args: [MCP_ENTRY_FS],
    env: buildMcpJsonEnv(),
  };
}

function readTomlSafe(path) {
  if (!existsSync(path)) return { raw: '', section: null };
  const raw = readFileSync(path, 'utf-8');
  // 极简 TOML 解析：仅检测 [mcp_servers] / [mcp_servers.awkn-engine] 是否存在
  const hasSection = /\[mcp_servers\.awkn-engine\]/.test(raw);
  return { raw, hasSection };
}

function buildTomlMcpEntry() {
  const env = buildMcpJsonEnv();
  return [
    '',
    '[mcp_servers.awkn-engine]',
    `command = "node"`,
    `args = ["${MCP_ENTRY_FS}"]`,
    '',
    '[mcp_servers.awkn-engine.env]',
    `AWKN_ENGINE_ROOT = "${env.AWKN_ENGINE_ROOT}"`,
    `AWKN_LLM_BRIDGE_DIR = "${env.AWKN_LLM_BRIDGE_DIR}"`,
    '',
  ].join('\n');
}

function installJsonIde(ide, options) {
  const target = IDE_TARGETS[ide];
  const existing = readJsonSafe(target.configPath);
  if (!existing.mcpServers) existing.mcpServers = {};
  const alreadyExists = 'awkn-engine' in existing.mcpServers;
  if (alreadyExists && !options.force) {
    console.log(`[install-mcp-config] ${target.label}：awkn-engine 已存在，跳过（用 --force 覆盖）`);
    return { skipped: true };
  }
  existing.mcpServers['awkn-engine'] = buildJsonMcpEntry();
  if (!options.dryRun) writeJsonSafe(target.configPath, existing);
  console.log(`[install-mcp-config] ${target.label}：${alreadyExists ? '覆盖' : '新增'} awkn-engine → ${target.configPath}`);
  return { skipped: false, path: target.configPath };
}

function installTomlIde(ide, options) {
  const target = IDE_TARGETS[ide];
  const { raw, hasSection } = readTomlSafe(target.configPath);
  if (hasSection && !options.force) {
    console.log(`[install-mcp-config] ${target.label}：awkn-engine section 已存在，跳过（用 --force 覆盖）`);
    return { skipped: true };
  }
  // 移除已有 awkn-engine section（force 模式）
  let cleaned = raw;
  if (hasSection) {
    cleaned = raw.replace(/\[mcp_servers\.awkn-engine\][\s\S]*?(?=\n\[|$)/g, '').trimEnd();
  }
  const next = cleaned + (cleaned.endsWith('\n') ? '' : '\n') + buildTomlMcpEntry();
  if (!options.dryRun) {
    mkdirSync(dirname(target.configPath), { recursive: true });
    writeFileSync(target.configPath, next, 'utf-8');
  }
  console.log(`[install-mcp-config] ${target.label}：${hasSection ? '覆盖' : '新增'} awkn-engine section → ${target.configPath}`);
  return { skipped: false, path: target.configPath };
}

function installIde(ide, options) {
  const target = IDE_TARGETS[ide];
  if (!target) {
    console.error(`[install-mcp-config] 错误：不支持的 IDE "${ide}"`);
    console.error(`[install-mcp-config] 支持：${Object.keys(IDE_TARGETS).join(', ')}`);
    return { skipped: true, error: true };
  }
  return target.format === 'toml'
    ? installTomlIde(ide, options)
    : installJsonIde(ide, options);
}

function parseArgs(argv) {
  const args = { ide: null, force: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ide') args.ide = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`用法：
  node scripts/install-mcp-config.mjs                    # 检测已安装 IDE 并安装
  node scripts/install-mcp-config.mjs --ide trae         # 仅安装到 TRAE
  node scripts/install-mcp-config.mjs --ide all --force  # 安装到所有支持的 IDE
  node scripts/install-mcp-config.mjs --dry-run          # 仅打印不写入

支持 IDE：${Object.keys(IDE_TARGETS).join(', ')}`);
}

const args = parseArgs(process.argv);
if (args.help) { printHelp(); process.exit(0); }

console.log(`[install-mcp-config] 引擎根：${ENGINE_ROOT}`);
console.log(`[install-mcp-config] MCP 入口：${MCP_ENTRY_FS}`);
if (args.dryRun) console.log('[install-mcp-config] DRY-RUN 模式，不会写入文件');

const targets = args.ide === 'all'
  ? Object.keys(IDE_TARGETS)
  : args.ide
    ? [args.ide]
    : detectInstalledIdes();

if (targets.length === 0) {
  console.log('[install-mcp-config] 未检测到已安装 IDE。请用 --ide 指定目标。');
  printHelp();
  process.exit(0);
}

console.log(`[install-mcp-config] 目标 IDE：${targets.join(', ')}`);

let installed = 0;
let skipped = 0;
let errored = 0;
for (const ide of targets) {
  const r = installIde(ide, args);
  if (r.error) errored++;
  else if (r.skipped) skipped++;
  else installed++;
}

console.log(`[install-mcp-config] 完成：${installed} 安装，${skipped} 跳过，${errored} 错误`);
process.exit(errored > 0 ? 1 : 0);
