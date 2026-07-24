import { createHash, randomUUID } from 'node:crypto';
import { queryRun } from '../store/db.js';
import type { SandboxExecutionResult } from './types.js';

export function recordSandboxExecution(input: {
  runId?: string;
  stepId?: string;
  sessionId: string;
  toolName: string;
  command?: string;
  cwd?: string;
  result: SandboxExecutionResult;
}): string {
  const id = randomUUID();
  queryRun(
    `INSERT INTO sandbox_executions
     (id, run_id, step_id, session_id, tool_name, backend, command_sha256, cwd,
      status, exit_code, stdout_text, stderr_text, duration_ms, artifacts_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId ?? null,
      input.stepId ?? null,
      input.sessionId,
      input.toolName,
      input.result.backend,
      input.command ? createHash('sha256').update(input.command).digest('hex') : null,
      input.cwd ?? null,
      input.result.status,
      input.result.exitCode,
      input.result.stdout.slice(0, 100000),
      input.result.stderr.slice(0, 100000),
      input.result.durationMs,
      JSON.stringify(input.result.artifacts),
      new Date().toISOString(),
    ],
  );
  return id;
}
