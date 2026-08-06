#!/usr/bin/env node

/**
 * AWKN TRAE hook — repository-owned, secret-free integration layer.
 *
 * Responsibilities:
 * - route prompts to the appropriate AWKN execution level;
 * - enforce local safety and GitHub Actions policy;
 * - record non-sensitive operation evidence under .trae/state and .trae/logs;
 * - run deterministic stop gates when repository files changed.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2] ?? '';
const projectDir = resolve(process.env.TRAE_PROJECT_DIR || process.cwd());
const traeDir = join(projectDir, '.trae');
const stateDir = join(traeDir, 'state');
const logDir = join(traeDir, 'logs');
const sessionFile = join(stateDir, 'session.json');
const taskFile = join(stateDir, 'current-task.json');
const evidenceFile = join(stateDir, 'last-evidence.json');
const operationLog = join(logDir, 'hooks.jsonl');

mkdirSync(stateDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

const ALLOW_GITHUB_ACTIONS = process.env.AWKN_ALLOW_GITHUB_ACTIONS === '1';
const GITHUB_ACTIONS_COMMANDS = [
  /\bgh(?:\.exe)?\s+workflow\b/i,
  /\bgh(?:\.exe)?\s+run\b/i,
  /\bgh(?:\.exe)?\s+api\b[^\r\n]*(?:\/actions\/|actions\/workflows|actions\/runs)/i,
  /(?:api\.github\.com|github\.com\/api\/v3)[^\r\n]*(?:\/actions\/|actions\/workflows|actions\/runs)/i,
];
const GITHUB_WORKFLOW_PATH = /(?:^|[\\/])\.github[\\/]workflows(?:[\\/]|$)/i;

function readStdin() {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readJson(path, fallback = {}) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function hookOutput(eventName, fields = {}) {
  printJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      ...fields,
    },
  });
}

function denyPreTool(reason) {
  printJson({
    success: false,
    block: true,
    blockReason: reason,
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectDir,
    encoding: 'utf8',
    timeout: options.timeout ?? 8000,
    shell: false,
    windowsHide: true,
    env: process.env,
  });

  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message ?? result.error) : '',
  };
}

function gitStatus() {
  const result = commandResult('git', ['status', '--porcelain=v1'], { timeout: 5000 });
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function normalizePath(value) {
  return String(value ?? '')
    .replace(/^["']|["']$/g, '')
    .replaceAll('\\', '/')
    .replace(/^\.?\//, '');
}

function toProjectPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const absolute = resolve(projectDir, raw);
  const rel = relative(projectDir, absolute);
  if (rel.startsWith('..') || rel === '') return normalizePath(raw);
  return normalizePath(rel);
}

function statusPath(line) {
  const raw = line.slice(3).trim();
  const renameTarget = raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw;
  return normalizePath(renameTarget ?? '');
}

function findFilePath(input) {
  const candidates = [
    input.file_path,
    input.filePath,
    input.path,
    input.target_file,
    input.targetFile,
    input.target_path,
    input.targetPath,
    input.new_path,
    input.old_path,
  ];
  return toProjectPath(candidates.find((item) => typeof item === 'string') ?? '');
}

function findCommand(input) {
  const value =
    input.command ??
    input.cmd ??
    input.script ??
    input.shell_command ??
    input.shellCommand ??
    '';
  return Array.isArray(value) ? value.join(' ') : String(value);
}

function getPrompt(payload) {
  return String(
    payload.prompt ??
    payload.user_prompt ??
    payload.userPrompt ??
    payload.input ??
    '',
  ).trim();
}

function routePrompt(prompt) {
  if (/(定时|周期|每天|每日|每周|每月|轮询|监控|到点|延迟执行|cron|schedule|recurring|monitor)/i.test(prompt)) {
    return {
      level: 'L3',
      reason: '检测到时间触发、周期执行或监控语义',
      entry: '使用 AWKN Cron 工作流',
    };
  }

  if (/(多\s*agent|多智能体|交叉审查|双模型|三堂会审|并行编排|orchestrat)/i.test(prompt)) {
    return {
      level: 'L4',
      reason: '检测到多 Agent 分工、交叉审查或编排语义',
      entry: '使用 AWKN Orchestrator',
    };
  }

  if (/(验收条件|持续推进|直到.*通过|重构|架构升级|状态机|协议|数据流|跨模块|完整闭环|goal|loop)/i.test(prompt) || prompt.length >= 500) {
    return {
      level: 'L2',
      reason: '检测到明确验收、多轮修复或跨模块语义',
      entry: '创建 Goal 并运行 L2 Loop',
    };
  }

  if (/(解释|分析|检查|评审|看看|阅读|总结|检索|搜索)/i.test(prompt) &&
      !/(修改|实现|修复|新增|删除|重写|开发|升级)/i.test(prompt)) {
    return {
      level: 'L0',
      reason: '检测到只读分析语义',
      entry: '只读检索与证据输出',
    };
  }

  return {
    level: 'L1',
    reason: '任务适合单个可验收闭环',
    entry: '形成工作包后执行',
  };
}

function protectedPathReason(path) {
  const p = `/${normalizePath(path).toLowerCase()}`;
  const base = basename(p);

  if (p.includes('/.git/') || base === '.git') return 'Git 内部目录禁止直接修改';
  if (base === '.env' || base.startsWith('.env.')) return '环境变量文件可能包含密钥';
  if (/(^|\/)(credentials?|secrets?|tokens?)(\.|\/|$)/i.test(p)) return '路径可能包含凭据或密钥';
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(p)) return '证书或私钥文件受保护';
  if (/(^|\/)(id_rsa|id_ed25519)(\.pub)?$/i.test(p)) return 'SSH 密钥文件受保护';
  if (p.includes('/runtime/data/')) return '运行时持久化数据禁止直接编辑';
  if (/\.(db|sqlite|sqlite3)$/i.test(p)) return '数据库文件禁止直接编辑';
  return '';
}

function isLockfile(path) {
  const base = basename(normalizePath(path).toLowerCase());
  return [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ].includes(base);
}

function riskyCommandReason(command) {
  const rules = [
    [/\brm\s+-[^\n]*r[^\n]*f|\brm\s+-rf\b/i, '检测到递归强制删除'],
    [/\bremove-item\b[^\n]*(?:-recurse[^\n]*-force|-force[^\n]*-recurse)/i, '检测到 PowerShell 递归强制删除'],
    [/\bdel\b[^\n]*(?:\/s[^\n]*\/q|\/q[^\n]*\/s)/i, '检测到 Windows 递归静默删除'],
    [/\bgit\s+reset\s+--hard\b/i, '检测到 Git 强制重置'],
    [/\bgit\s+clean\s+-[^\n]*f/i, '检测到 Git 清理未跟踪文件'],
    [/\bgit\s+push\b[^\n]*(?:--force|-f\b)/i, '检测到 Git 强制推送'],
    [/\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+npm\s+publish\b/i, '检测到包发布'],
    [/\b(drop|truncate)\s+(database|table)\b/i, '检测到破坏性 SQL'],
    [/\bformat\s+[a-z]:/i, '检测到磁盘格式化命令'],
    [/\bmkfs(?:\.|\s)/i, '检测到文件系统格式化命令'],
    [/\bdd\s+if=/i, '检测到底层块设备写入命令'],
    [/\bshutdown\b|\breboot\b|\brestart-computer\b/i, '检测到系统关机或重启'],
  ];

  for (const [pattern, reason] of rules) {
    if (pattern.test(command)) return reason;
  }
  return '';
}

function dependencyCommand(command) {
  return /\b(?:npm\s+(?:i|install|uninstall|update)|pnpm\s+(?:add|remove|update|install)|yarn\s+(?:add|remove|upgrade|install)|bun\s+(?:add|remove|install))\b/i.test(command);
}

function summarizeRoute(route) {
  return [
    `天枢路由：${route.level}`,
    `路由原因：${route.reason}`,
    `执行入口：${route.entry}`,
    '执行前明确目标、产出、约束、验收、验证和回滚。',
    '先检索现有实现，再做最小可验证升级。',
  ].join('\n');
}

function handleSessionStart() {
  const baselineStatus = gitStatus();
  const runtimePackage = join(projectDir, 'runtime', 'package.json');
  const session = {
    startedAt: new Date().toISOString(),
    projectDir,
    baselineStatus,
    runtimeDetected: existsSync(runtimePackage),
  };
  writeJson(sessionFile, session);

  hookOutput('SessionStart', {
    additionalContext: [
      '已启用 AWKN 天枢调度层。',
      `项目根目录：${projectDir}`,
      `Runtime：${session.runtimeDetected ? '已检测到' : '未检测到'}`,
      '主链：Intent → Goal → Work Package → Loop → Gate → Evidence → Writeback → Evolve。',
    ].join('\n'),
  });
}

function handleDispatch(payload) {
  const prompt = getPrompt(payload);
  const route = routePrompt(prompt);
  const session = readJson(sessionFile, {});
  const task = {
    id: createHash('sha256').update(`${Date.now()}:${prompt}`).digest('hex').slice(0, 16),
    startedAt: new Date().toISOString(),
    promptHash: createHash('sha256').update(prompt).digest('hex'),
    promptPreview: prompt.slice(0, 300),
    route,
    changedFiles: [],
    operations: 0,
    baselineStatus: session.baselineStatus ?? gitStatus(),
  };
  writeJson(taskFile, task);
  hookOutput('UserPromptSubmit', { additionalContext: summarizeRoute(route) });
}

function handlePreTool(payload) {
  const toolName = String(payload.tool_name ?? payload.toolName ?? '');
  const input = payload.tool_input ?? payload.toolInput ?? {};
  const filePath = findFilePath(input);
  const command = findCommand(input);

  if (!ALLOW_GITHUB_ACTIONS && toolName === 'RunCommand' &&
      GITHUB_ACTIONS_COMMANDS.some((pattern) => pattern.test(command))) {
    denyPreTool(
      'AWKN policy: GitHub Actions is not an execution or deployment trigger. Run validation locally and use GitHub for code hosting and CI evidence.',
    );
    return;
  }

  if (!ALLOW_GITHUB_ACTIONS && ['Write', 'SearchReplace', 'DeleteFile'].includes(toolName) &&
      GITHUB_WORKFLOW_PATH.test(filePath)) {
    denyPreTool(
      'AWKN policy: direct edits under .github/workflows require an explicit policy change and independent review.',
    );
    return;
  }

  if (filePath) {
    const protectedReason = protectedPathReason(filePath);
    if (protectedReason) {
      hookOutput('PreToolUse', {
        permissionDecision: 'ask',
        permissionDecisionReason: `${protectedReason}：${filePath}`,
      });
      return;
    }

    if (isLockfile(filePath)) {
      hookOutput('PreToolUse', {
        permissionDecision: 'ask',
        permissionDecisionReason: `即将修改依赖锁文件：${filePath}。请确认依赖来源与版本。`,
      });
      return;
    }
  }

  if (/DeleteFile/i.test(toolName)) {
    hookOutput('PreToolUse', {
      permissionDecision: 'ask',
      permissionDecisionReason: `即将删除文件：${filePath || '未识别路径'}。请确认范围和回滚方式。`,
    });
    return;
  }

  if (command) {
    const risk = riskyCommandReason(command);
    if (risk) {
      hookOutput('PreToolUse', {
        permissionDecision: 'ask',
        permissionDecisionReason: `${risk}：${command.slice(0, 500)}`,
      });
      return;
    }

    if (dependencyCommand(command)) {
      hookOutput('PreToolUse', {
        permissionDecision: 'ask',
        permissionDecisionReason: `即将变更项目依赖：${command.slice(0, 500)}。请确认包来源与 lockfile 变化。`,
      });
      return;
    }
  }

  hookOutput('PreToolUse', { permissionDecision: 'allow' });
}

function handlePostTool(payload) {
  const toolName = String(payload.tool_name ?? payload.toolName ?? 'unknown');
  const input = payload.tool_input ?? payload.toolInput ?? {};
  const filePath = findFilePath(input);
  const command = findCommand(input);
  const entry = {
    at: new Date().toISOString(),
    toolName,
    filePath,
    command: command.slice(0, 1000),
  };
  appendFileSync(operationLog, `${JSON.stringify(entry)}\n`, 'utf8');

  const task = readJson(taskFile, { changedFiles: [], operations: 0 });
  task.operations = Number(task.operations ?? 0) + 1;
  if (filePath && /Write|SearchReplace|DeleteFile/i.test(toolName)) {
    const changed = new Set(Array.isArray(task.changedFiles) ? task.changedFiles : []);
    changed.add(normalizePath(filePath));
    task.changedFiles = [...changed];
  }
  task.lastOperationAt = entry.at;
  writeJson(taskFile, task);
  printJson({});
}

function changedFilesForTask(task) {
  const baseline = new Set(Array.isArray(task.baselineStatus) ? task.baselineStatus : []);
  const fromStatus = gitStatus()
    .filter((line) => !baseline.has(line))
    .map(statusPath);
  const fromHooks = Array.isArray(task.changedFiles) ? task.changedFiles : [];
  const ignoredPrefixes = ['.trae/state/', '.trae/logs/'];

  return [...new Set([...fromStatus, ...fromHooks])]
    .map(normalizePath)
    .filter(Boolean)
    .filter((path) => !ignoredPrefixes.some((prefix) => path.startsWith(prefix)));
}

function tail(text, max = 5000) {
  const value = String(text ?? '');
  return value.length <= max ? value : value.slice(-max);
}

function handleStop() {
  const task = readJson(taskFile, {});
  const changedFiles = changedFilesForTask(task);

  if (changedFiles.length === 0) {
    writeJson(evidenceFile, {
      checkedAt: new Date().toISOString(),
      route: task.route ?? null,
      changedFiles: [],
      gates: [{ name: 'no-write-task', passed: true }],
    });
    printJson({});
    return;
  }

  const gates = [];
  const diffCheck = commandResult('git', ['diff', '--check'], { timeout: 10000 });
  gates.push({
    name: 'git diff --check',
    passed: diffCheck.ok,
    output: tail(`${diffCheck.stdout}\n${diffCheck.stderr}`),
  });

  if (!diffCheck.ok) {
    writeJson(evidenceFile, {
      checkedAt: new Date().toISOString(),
      route: task.route ?? null,
      changedFiles,
      gates,
    });
    printJson({
      decision: 'block',
      reason: `Git diff 检查未通过。\n${tail(`${diffCheck.stdout}\n${diffCheck.stderr}`, 3500)}`,
    });
    return;
  }

  const runtimeChanged = changedFiles.some((path) =>
    path === 'runtime/package.json' ||
    path === 'runtime/package-lock.json' ||
    path.startsWith('runtime/src/') ||
    path.startsWith('runtime/test/') ||
    path.startsWith('runtime/tsconfig'),
  );

  if (runtimeChanged) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const check = commandResult(npmCommand, ['run', 'check'], {
      cwd: join(projectDir, 'runtime'),
      timeout: 165000,
    });
    gates.push({
      name: 'runtime npm run check',
      passed: check.ok,
      output: tail(`${check.stdout}\n${check.stderr}`),
    });

    if (!check.ok) {
      writeJson(evidenceFile, {
        checkedAt: new Date().toISOString(),
        route: task.route ?? null,
        changedFiles,
        gates,
      });
      printJson({
        decision: 'block',
        reason: [
          '天枢结束门禁未通过，请修复后再次结束任务。',
          `变更文件：${changedFiles.join(', ')}`,
          tail(`${check.stdout}\n${check.stderr}`, 4000),
        ].join('\n'),
      });
      return;
    }
  }

  writeJson(evidenceFile, {
    checkedAt: new Date().toISOString(),
    route: task.route ?? null,
    changedFiles,
    gates,
  });
  printJson({});
}

const payload = readStdin();

try {
  switch (mode) {
    case 'session-start':
      handleSessionStart();
      break;
    case 'dispatch':
      handleDispatch(payload);
      break;
    case 'pre-tool':
      handlePreTool(payload);
      break;
    case 'post-tool':
      handlePostTool(payload);
      break;
    case 'stop':
      handleStop();
      break;
    default:
      printJson({});
  }
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  appendFileSync(operationLog, `${JSON.stringify({ at: new Date().toISOString(), mode, error: message })}\n`, 'utf8');

  if (mode === 'pre-tool') {
    hookOutput('PreToolUse', {
      permissionDecision: 'ask',
      permissionDecisionReason: `天枢 Hook 执行异常，请人工确认：${message.slice(0, 800)}`,
    });
  } else if (mode === 'stop') {
    printJson({ decision: 'block', reason: `天枢结束门禁执行异常：${message.slice(0, 1200)}` });
  } else {
    printJson({});
  }
}
