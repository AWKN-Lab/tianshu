import { DockerSandboxExecutor } from './docker-executor.js';
import { RestrictedProcessSandboxExecutor } from './process-executor.js';
import type { SandboxExecutor } from './types.js';

let override: SandboxExecutor | null = null;
let instance: SandboxExecutor | null = null;

export function getSandboxExecutor(): SandboxExecutor {
  if (override) return override;
  if (instance) return instance;
  const backend = process.env.AWKN_SANDBOX_BACKEND ?? 'docker';
  instance = backend === 'process'
    ? new RestrictedProcessSandboxExecutor()
    : new DockerSandboxExecutor();
  return instance;
}

export function setSandboxExecutorForTests(executor: SandboxExecutor | null): void {
  override = executor;
  instance = null;
}

export type { SandboxExecutor, SandboxExecutionResult } from './types.js';
