import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { GateResult } from '../gates/quality-gates.js';

const execFileAsync = promisify(execFile);

export interface ArtifactBundle {
  schemaVersion: '1.0';
  collectedAt: string;
  cwd: string;
  finalText: string;
  git: {
    available: boolean;
    baseCommit?: string;
    status?: string;
    diff?: string;
    diffSha256?: string;
    error?: string;
  };
  gates: Array<{
    name: string;
    passed: boolean;
    details?: string;
    suggestion?: string;
    durationMs: number;
  }>;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
  return `${result.stdout}${result.stderr}`.trim();
}

export async function collectArtifactBundle(input: {
  cwd: string;
  finalText: string;
  gates?: GateResult[];
}): Promise<ArtifactBundle> {
  const bundle: ArtifactBundle = {
    schemaVersion: '1.0',
    collectedAt: new Date().toISOString(),
    cwd: input.cwd,
    finalText: input.finalText,
    git: { available: false },
    gates: (input.gates ?? []).map((gate) => ({ ...gate })),
  };

  try {
    const [baseCommit, status, diff] = await Promise.all([
      runGit(input.cwd, ['rev-parse', 'HEAD']),
      runGit(input.cwd, ['status', '--short']),
      runGit(input.cwd, ['diff', '--no-ext-diff', '--unified=3', '--', '.']),
    ]);
    bundle.git = {
      available: true,
      baseCommit,
      status,
      diff: diff.slice(0, 200000),
      diffSha256: createHash('sha256').update(diff).digest('hex'),
    };
  } catch (err) {
    bundle.git = { available: false, error: err instanceof Error ? err.message : String(err) };
  }

  return bundle;
}
