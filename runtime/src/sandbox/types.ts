export type SandboxBackend = 'docker' | 'process' | 'file' | 'test';

export interface CommandSandboxRequest {
  command: string;
  workspaceRoot: string;
  cwd: string;
  timeoutMs?: number;
  sessionId: string;
  runId?: string;
  stepId?: string;
}

export interface WriteSandboxRequest {
  path: string;
  content: string;
  workspaceRoot: string;
  sessionId: string;
  runId?: string;
  stepId?: string;
}

export interface SandboxArtifact {
  path: string;
  beforeSha256?: string;
  afterSha256?: string;
  bytes: number;
}

export interface SandboxExecutionResult {
  backend: SandboxBackend;
  status: 'success' | 'error';
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  artifacts: SandboxArtifact[];
}

export interface SandboxExecutor {
  readonly backend: SandboxBackend;
  executeCommand(request: CommandSandboxRequest): Promise<SandboxExecutionResult>;
  writeFile(request: WriteSandboxRequest): Promise<SandboxExecutionResult>;
}
