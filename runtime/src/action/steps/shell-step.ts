/**
 * awkn-local-action-runner — Shell Step（技能吸收 P0-5 加固）
 *
 * 超时后清理完整进程树：
 * - Windows: taskkill /PID <pid> /T /F（cmd.exe 子进程会留下孙进程）；
 * - POSIX: detached + kill(-pid) 终止进程组。
 * execFile 的 timeout 只杀直接子进程，无法清理 cmd /c 派生的孙进程。
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ShellStepDef, StepResult } from '../types.js';
import { redactText } from '../../core/redaction.js';

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

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

/** 终止进程树：POSIX 用进程组，Windows 用 taskkill /T */
export function killProcessTree(pid: number): void {
  if (pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // 进程已退出，忽略
  }
}

function appendChunk(state: { text: string }, chunk: Buffer): void {
  if (state.text.length >= MAX_OUTPUT_BYTES) return;
  state.text += chunk.toString('utf-8');
}


export async function runShellStep(step: ShellStepDef, cwd: string): Promise<StepResult> {
  const started = Date.now();
  const windows = process.platform === 'win32';
  const executable = windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  const args = windows ? ['/d', '/s', '/c', step.command] : ['-lc', step.command];

  return await new Promise<StepResult>((resolve) => {
    const child = spawn(executable, args, {
      cwd: normalizeWindowsCwd(step.cwd ?? cwd),
      windowsHide: true,
      // POSIX 下脱离会话，便于超时后用负 PID 清理进程组
      detached: !windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: { text: string } = { text: '' };
    const stderr: { text: string } = { text: '' };
    let settled = false;

    const settle = (result: StepResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killProcessTree(child.pid ?? -1);
      settle({
        name: step.name,
        type: 'shell',
        status: 'failed',
        output: redactText(`${stdout.text}${stderr.text}`).slice(0, 5000)
          || `command timed out after ${step.timeout ?? 300}s`,
        durationMs: Date.now() - started,
        exitCode: null,
      });
    }, (step.timeout ?? 300) * 1000);

    child.stdout?.on('data', (chunk: Buffer) => appendChunk(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendChunk(stderr, chunk));

    child.on('error', (err) => {
      killProcessTree(child.pid ?? -1);
      settle({
        name: step.name,
        type: 'shell',
        status: 'failed',
        output: redactText(err.message).slice(0, 5000),
        durationMs: Date.now() - started,
        exitCode: 1,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = redactText(stdout.text + stderr.text);
      settle({
        name: step.name,
        type: 'shell',
        status: code === 0 ? 'passed' : 'failed',
        output: combined.slice(0, 5000) || `exited with code ${code}`,
        durationMs: Date.now() - started,
        exitCode: code,
      });
    });
  });
}
