import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load runtime/.env without overwriting values injected by the MCP host. */
export function loadRuntimeEnv(): void {
  const envPath = resolve(__dirname, '..', '..', '.env');
  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // A host may provide every required value directly. Missing optional .env is valid.
  }
}
