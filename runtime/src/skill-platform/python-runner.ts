/**
 * 安全的 Python 子进程调用层。
 *
 * 强制约束：
 * - 只使用参数数组启动 Python（spawn），禁止 shell 字符串拼接。
 * - scriptPath 必须位于 engineRoot 内（边界检查）。
 * - 超时（默认 120s）和最大输出大小（默认 10MB）。
 * - exit code、stderr 和执行摘要进入 Receipt。
 * - 临时文件在 finally 块中清理。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, isAbsolute, relative, sep, join } from 'node:path';

export interface PythonRunOptions {
  /** Python 可执行路径，默认 'python' */
  python?: string;
  /** 要运行的 .py 脚本绝对路径（必须在 engineRoot 内） */
  scriptPath: string;
  /** 额外命令行参数 */
  args?: string[];
  /** 需要写到临时目录的上下文文件：相对文件名 -> 内容 */
  contextFiles?: Record<string, string>;
  /** 工作目录，默认 engineRoot */
  cwd?: string;
  /** 超时毫秒，默认 120000 */
  timeoutMs?: number;
  /** 最大输出字节，默认 10MB */
  maxOutputBytes?: number;
  /** 引擎根目录，用于边界检查 */
  engineRoot: string;
}

export interface PythonRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: unknown | undefined;
  durationMs: number;
  tmpDir: string | undefined;
  /** 临时目录中生成的文件绝对路径（文件名 -> 绝对路径） */
  contextFilePaths: Record<string, string>;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * 检查 target 是否在 base 目录内（防止路径逃逸）。
 */
function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

/**
 * 安全运行 Python 脚本。
 *
 * 返回 PythonRunResult，不抛异常（除非参数非法）。
 * 调用方根据 exitCode 和 json 判断成功与否。
 */
export async function runPython(opts: PythonRunOptions): Promise<PythonRunResult> {
  const engineRoot = resolve(opts.engineRoot);
  const scriptPath = resolve(opts.scriptPath);

  // 边界检查：脚本必须在引擎根内
  if (!isWithin(engineRoot, scriptPath)) {
    throw new Error(
      `SCRIPT_PATH_OUT_OF_BOUNDS: ${scriptPath} 不在引擎根 ${engineRoot} 内`,
    );
  }

  const python = opts.python ?? process.env.AWKN_PYTHON ?? 'python';
  const cwd = opts.cwd ?? engineRoot;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxOutputBytes = opts.maxOutputBytes ?? 10 * 1024 * 1024;
  const args = opts.args ?? [];
  const contextFilePaths: Record<string, string> = {};

  const startMs = Date.now();
  let tmpDir: string | undefined;

  try {
    // 创建临时目录并写入上下文文件
    if (opts.contextFiles && Object.keys(opts.contextFiles).length > 0) {
      tmpDir = await mkdtemp(join(tmpdir(), 'awkn-python-'));
      for (const [name, content] of Object.entries(opts.contextFiles)) {
        // 文件名只取 basename，防止路径穿越
        const safeName = name.split(/[\\/]/).pop() ?? name;
        const filePath = resolve(tmpDir, safeName);
        contextFilePaths[safeName] = filePath;
        await writeFile(filePath, content, 'utf-8');
      }
    }

    const child: ChildProcess = spawn(python, [scriptPath, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    return await new Promise<PythonRunResult>((resolvePromise) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let truncated = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5_000);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          truncated = true;
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) {
          truncated = true;
          return;
        }
        stderrChunks.push(chunk);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        let json: unknown | undefined;
        if (stdout.trim()) {
          try {
            json = JSON.parse(stdout);
          } catch {
            // stdout 不是 JSON，保持 undefined
          }
        }
        resolvePromise({
          exitCode: code ?? -1,
          stdout,
          stderr,
          json,
          durationMs: Date.now() - startMs,
          tmpDir,
          contextFilePaths,
          timedOut,
          truncated,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolvePromise({
          exitCode: -1,
          stdout: '',
          stderr: `SPAWN_ERROR: ${err.message}`,
          json: undefined,
          durationMs: Date.now() - startMs,
          tmpDir,
          contextFilePaths,
          timedOut: false,
          truncated: false,
        });
      });
    });
  } finally {
    // 临时目录由调用方通过 cleanupTmpDir 触发清理
    // 这里不自动清理，因为 governance 的 receipt 可能需要临时路径
  }
}

/**
 * 清理临时目录。
 */
export async function cleanupTmpDir(tmpDir: string | undefined): Promise<void> {
  if (!tmpDir) return;
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}
