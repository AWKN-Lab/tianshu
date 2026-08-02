import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function isEngineRoot(path: string): boolean {
  return existsSync(resolve(path, 'skills'))
    && existsSync(resolve(path, 'capabilities', 'project', 'manifest.yaml'));
}

/** Resolve the engine root (repo root) by walking up from startDir. */
export function resolveEngineRoot(startDir: string): string {
  if (process.env.AWKN_ENGINE_ROOT) return resolve(process.env.AWKN_ENGINE_ROOT);
  let cursor = resolve(startDir);
  for (let depth = 0; depth < 8; depth++) {
    if (isEngineRoot(cursor)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`AWKN engine root not found from ${startDir}; set AWKN_ENGINE_ROOT`);
}
