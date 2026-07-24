import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { ToolHandler } from '../types.js';
import { memoryTools } from './memory-tools.js';
import { skillTool } from './skill-tool.js';

const execFileAsync = promisify(execFile);

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
    properties: { path: { type: 'string', description: '文件绝对路径' } },
    required: ['path'],
  },
  async execute(args) {
    const path = args.path as string;
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
      const error = err as Error & { stdout?: string; stderr?: string };
      const combined = (error.stderr ?? '') + (error.stdout ?? '');
      throw new Error(combined
        ? `${error.message}\n--- stdout/stderr ---\n${combined.slice(0, 10000)}`
        : error.message);
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
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        const full = join(dir, entry);
        let stat: ReturnType<typeof statSync>;
        try { stat = statSync(full); } catch { continue; }
        if (stat.isDirectory()) {
          if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
          walk(full);
          continue;
        }
        if (!stat.isFile()) continue;
        if (globFilter && !matchGlob(entry, globFilter)) continue;
        try {
          const lines = readFileSync(full, 'utf-8').split('\n');
          for (let index = 0; index < lines.length; index++) {
            if (!regex.test(lines[index]!)) continue;
            results.push(`${relative(root, full)}:${index + 1}:${lines[index]}`);
            if (results.length >= maxResults) break;
          }
        } catch { /* binary or unreadable file */ }
      }
    };

    walk(root);
    return results.length === 0 ? `No matches for /${pattern}/` : results.join('\n');
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
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        const full = join(dir, entry);
        let stat: ReturnType<typeof statSync>;
        try { stat = statSync(full); } catch { continue; }
        if (stat.isDirectory()) {
          if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
          walk(full);
          continue;
        }
        if (!stat.isFile()) continue;
        const rel = relative(root, full).replace(/\\/g, '/');
        if (matchGlob(rel, pattern)) results.push(rel);
      }
    };

    walk(root);
    return results.length === 0 ? `No files match ${pattern}` : results.join('\n');
  },
};

function matchGlob(name: string, pattern: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/{{DOUBLESTAR}}/g, '.*');
  return new RegExp(`^${expression}$`).test(name);
}

export const builtinTools: ToolHandler[] = [
  readTool,
  writeTool,
  execTool,
  grepTool,
  globTool,
  skillTool,
  ...memoryTools,
];
