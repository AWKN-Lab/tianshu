/**
 * 内置工具：read/write/grep/glob/exec/skill
 *
 * 简化版，供 agent-loop 在 L1 循环中调用
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative } from 'node:path';
import { createLogger } from '../../core/logger.js';
import type { ToolHandler } from '../types.js';
import { skillTool } from './skill-tool.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('BuiltinTools');
void logger; // reserved for future diagnostic logging

export const readTool: ToolHandler = {
  name: 'read',
  description: '读取文件内容',
  source: 'builtin',
  isReadOnly: true,
  concurrentSafe: true,
  permissionLevel: 'none',
  priority: 'critical',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
    },
    required: ['path'],
  },
  async execute(args) {
    const path = args.path as string;
    // M3 进阶-25（2026-07-23）：File not found 必须 throw，不能返回字符串
    //   原版：return `File not found: ${path}` → agent-loop 视为成功（isError=false）
    //   问题：绕过 consecutiveErrors / 3-strike / recordLoopFailure → 自进化闭环对工具错误盲区
    //   修复：throw，让 agent-loop catch 记录 isError + recordLoopFailure（与 skill-tool M3 进阶-7 一致）
    if (!existsSync(path)) throw new Error(`File not found: ${path}`);
    return readFileSync(path, 'utf-8');
  },
};

export const writeTool: ToolHandler = {
  name: 'write',
  description: '写入文件（覆盖）',
  source: 'builtin',
  isReadOnly: false,
  concurrentSafe: false,
  permissionLevel: 'confirm',
  priority: 'critical',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      content: { type: 'string', description: '文件内容' },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const path = args.path as string;
    const content = args.content as string;
    writeFileSync(path, content, 'utf-8');
    return `Wrote ${content.length} chars to ${path}`;
  },
};

export const execTool: ToolHandler = {
  name: 'exec',
  description: '执行 shell 命令',
  source: 'builtin',
  isReadOnly: false,
  concurrentSafe: false,
  permissionLevel: 'confirm',
  priority: 'high',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '命令' },
      cwd: { type: 'string', description: '工作目录（可选）' },
    },
    required: ['command'],
  },
  async execute(args: Record<string, unknown>) {
    const command = args.command as string;
    const cwd = (args.cwd as string) ?? process.cwd();
    try {
      const { stdout, stderr } = await execFileAsync(command, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
        shell: true,
      });
      return (stdout + stderr).slice(0, 50000);
    } catch (err) {
      // M3 进阶-24（2026-07-23）：命令执行失败必须 throw，不能返回 [error] 字符串
      //   原版：return `[error] ${stderr+stdout}` → agent-loop 视为成功（isError=false）
      //   问题：
      //     1. 绕过 consecutiveErrors / 3-strike / recordLoopFailure → 自进化闭环对工具错误盲区
      //     2. ENOENT（命令不存在）时 stderr/stdout 为空 → 返回 `[error] `（近空串）→ 无信号被当作成功
      //   修复：throw enriched error（含 stdout/stderr 供 LLM 推理），让 agent-loop catch 记录 isError
      //   LLM 仍能看到输出：agent-loop line 310 会把 errorMessage 格式化为 `[error] ${errorMessage}` 传给 LLM
      const e = err as Error & { stdout?: string; stderr?: string };
      const combined = (e.stderr ?? '') + (e.stdout ?? '');
      const enriched = combined
        ? `${e.message}\n--- stdout/stderr ---\n${combined.slice(0, 10000)}`
        : e.message;
      throw new Error(enriched);
    }
  },
};

export const grepTool: ToolHandler = {
  name: 'grep',
  description: '正则搜索文件内容（递归）',
  source: 'builtin',
  isReadOnly: true,
  concurrentSafe: true,
  permissionLevel: 'none',
  priority: 'high',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索目录（默认 cwd）' },
      glob: { type: 'string', description: '文件名 glob 过滤（如 *.ts）' },
    },
    required: ['pattern'],
  },
  async execute(args: Record<string, unknown>) {
    const pattern = args.pattern as string;
    const root = (args.path as string) ?? process.cwd();
    const globFilter = args.glob as string | undefined;
    const regex = new RegExp(pattern, 'i');
    const results: string[] = [];
    const maxResults = 200;

    const walk = (dir: string): void => {
      if (results.length >= maxResults) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        const full = join(dir, entry);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
          walk(full);
        } else if (st.isFile()) {
          if (globFilter && !matchGlob(entry, globFilter)) continue;
          try {
            const content = readFileSync(full, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i]!)) {
                results.push(`${relative(root, full)}:${i + 1}:${lines[i]}`);
                if (results.length >= maxResults) break;
              }
            }
          } catch {
            // 二进制文件等，跳过
          }
        }
      }
    };

    walk(root);
    return results.length === 0
      ? `No matches for /${pattern}/`
      : results.join('\n');
  },
};

export const globTool: ToolHandler = {
  name: 'glob',
  description: '按 glob 模式查找文件',
  source: 'builtin',
  isReadOnly: true,
  concurrentSafe: true,
  permissionLevel: 'none',
  priority: 'high',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式（如 **/*.ts）' },
      path: { type: 'string', description: '搜索根目录（默认 cwd）' },
    },
    required: ['pattern'],
  },
  async execute(args: Record<string, unknown>) {
    const pattern = args.pattern as string;
    const root = (args.path as string) ?? process.cwd();
    const results: string[] = [];
    const maxResults = 500;

    const walk = (dir: string): void => {
      if (results.length >= maxResults) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        const full = join(dir, entry);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
          walk(full);
        } else if (st.isFile()) {
          const rel = relative(root, full).replace(/\\/g, '/');
          if (matchGlob(rel, pattern)) {
            results.push(rel);
          }
        }
      }
    };

    walk(root);
    return results.length === 0
      ? `No files match ${pattern}`
      : results.join('\n');
  },
};

/** 简易 glob 匹配（支持 * 和 ** 和 ?） */
function matchGlob(name: string, pattern: string): boolean {
  // 将 glob 转 RegExp
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/{{DOUBLESTAR}}/g, '.*');
  return new RegExp(`^${re}$`).test(name);
}

export const builtinTools: ToolHandler[] = [readTool, writeTool, execTool, grepTool, globTool, skillTool];
