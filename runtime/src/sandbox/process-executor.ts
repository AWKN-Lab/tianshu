import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicSandboxWrite } from './file-sandbox.js';
import type { CommandSandboxRequest, SandboxExecutionResult, SandboxExecutor, WriteSandboxRequest } from './types.js';

const execFileAsync = promisify(execFile);

function safeEnv(): NodeJS.ProcessEnv {
  const keys = [
    'PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'LANG',
    // GitHub CLI auth (keyring not accessible from sandbox; GH_TOKEN overrides it)
    'GH_TOKEN', 'GH_HOST',
    // Git identity (for read-only git operations)
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  ];
  return Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

export class RestrictedProcessSandboxExecutor implements SandboxExecutor {
  readonly backend = 'process' as const;

  constructor() {
    if (process.env.AWKN_ALLOW_PROCESS_SANDBOX !== '1') {
      throw new Error('Process sandbox is disabled. Set AWKN_ALLOW_PROCESS_SANDBOX=1 only for controlled development environments.');
    }
  }

  async executeCommand(request: CommandSandboxRequest): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    const windows = process.platform === 'win32';
    const executable = windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
    const args = windows ? ['/d', '/s', '/c', request.command] : ['-lc', request.command];
    try {
      const result = await execFileAsync(executable, args, {
        cwd: request.cwd,
        env: safeEnv(),
        timeout: request.timeoutMs ?? 60_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      return {
        backend: this.backend,
        status: 'success',
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - startedAt,
        artifacts: [],
      };
    } catch (err) {
      const error = err as Error & { code?: number; stdout?: string; stderr?: string };
      return {
        backend: this.backend,
        status: 'error',
        exitCode: typeof error.code === 'number' ? error.code : 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? error.message,
        durationMs: Date.now() - startedAt,
        artifacts: [],
      };
    }
  }

  async writeFile(request: WriteSandboxRequest): Promise<SandboxExecutionResult> {
    return atomicSandboxWrite(request);
  }
}
