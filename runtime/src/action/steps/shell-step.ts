/**
 * awkn-local-action-runner — Shell Step
 *
 * 对标 qoder-action bash-tools.ts。
 * 参考 sandbox/process-executor.ts 的 Windows 兼容模式。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ShellStepDef, StepResult } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Windows 路径盘符大写规范化。
 *
 * Vite/vitest 的 server.fs.allow 对盘符大小写敏感：
 * cmd.exe 继承的 cwd 可能是小写 d:，而 Vite 内部用大写 D:，
 * 大小写不匹配会导致 ESM import 解析失败（"No test suite found"）。
 * 在源头将盘符统一为大写，避免下游大小写敏感问题。
 */
function normalizeWindowsCwd(cwd: string): string {
  if (process.platform !== 'win32') return cwd;
  if (/^[a-z]:[\\/]/.test(cwd)) {
    return cwd.charAt(0).toUpperCase() + cwd.slice(1);
  }
  return cwd;
}

export async function runShellStep(step: ShellStepDef, cwd: string): Promise<StepResult> {
  const started = Date.now();
  const windows = process.platform === 'win32';
  const executable = windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  const args = windows ? ['/d', '/s', '/c', step.command] : ['-lc', step.command];

  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd: normalizeWindowsCwd(step.cwd ?? cwd),
      maxBuffer: 20 * 1024 * 1024,
      timeout: step.timeout * 1000,
      windowsHide: true,
    });
    return {
      name: step.name,
      type: 'shell',
      status: 'passed',
      output: (stdout + stderr).slice(0, 5000),
      durationMs: Date.now() - started,
      exitCode: 0,
    };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      name: step.name,
      type: 'shell',
      status: 'failed',
      output: ((e.stdout ?? '') + (e.stderr ?? '')).slice(0, 5000) || e.message,
      durationMs: Date.now() - started,
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}
