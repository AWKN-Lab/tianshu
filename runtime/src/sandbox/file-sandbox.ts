import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SandboxArtifact, SandboxExecutionResult, WriteSandboxRequest } from './types.js';

function hashFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function atomicSandboxWrite(request: WriteSandboxRequest): SandboxExecutionResult {
  const startedAt = Date.now();
  const target = resolve(request.workspaceRoot, request.path);
  const beforeSha256 = hashFile(target);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.awkn-${randomUUID()}.tmp`;

  try {
    writeFileSync(temp, request.content, { encoding: 'utf-8', flag: 'wx' });
    try {
      renameSync(temp, target);
    } catch {
      if (existsSync(target)) unlinkSync(target);
      renameSync(temp, target);
    }
    const artifact: SandboxArtifact = {
      path: target,
      beforeSha256,
      afterSha256: hashFile(target),
      bytes: Buffer.byteLength(request.content, 'utf-8'),
    };
    return {
      backend: 'file',
      status: 'success',
      exitCode: 0,
      stdout: `Wrote ${artifact.bytes} bytes to ${target}`,
      stderr: '',
      durationMs: Date.now() - startedAt,
      artifacts: [artifact],
    };
  } catch (err) {
    try { unlinkSync(temp); } catch { /* noop */ }
    return {
      backend: 'file',
      status: 'error',
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
      artifacts: [],
    };
  }
}
