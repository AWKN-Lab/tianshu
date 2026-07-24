import { execFile } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { atomicSandboxWrite } from './file-sandbox.js';
import type { CommandSandboxRequest, SandboxExecutionResult, SandboxExecutor, WriteSandboxRequest } from './types.js';

const execFileAsync = promisify(execFile);

export function buildDockerArgs(request: CommandSandboxRequest): string[] {
  const root = resolve(request.workspaceRoot);
  const cwd = resolve(root, request.cwd);
  const rel = relative(root, cwd).split(sep).join('/');
  const containerCwd = rel ? `/workspace/${rel}` : '/workspace';
  const image = process.env.AWKN_SANDBOX_IMAGE ?? 'node:22-bookworm-slim';
  const network = process.env.AWKN_SANDBOX_NETWORK ?? 'none';
  const memory = process.env.AWKN_SANDBOX_MEMORY ?? '512m';
  const cpus = process.env.AWKN_SANDBOX_CPUS ?? '1';

  return [
    'run', '--rm', '--init',
    '--network', network,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '64',
    '--memory', memory,
    '--cpus', cpus,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--mount', `type=bind,src=${root},dst=/workspace`,
    '--workdir', containerCwd,
    image,
    'sh', '-lc', request.command,
  ];
}

export class DockerSandboxExecutor implements SandboxExecutor {
  readonly backend = 'docker' as const;

  async executeCommand(request: CommandSandboxRequest): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    try {
      const result = await execFileAsync('docker', buildDockerArgs(request), {
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
