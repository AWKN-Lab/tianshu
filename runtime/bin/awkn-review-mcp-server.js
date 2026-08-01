#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, '..', 'dist', 'mcp', 'review-server.js');

if (!existsSync(serverPath)) {
  console.error('[awkn-review-mcp] preflight failed: dist is missing; run npm run build before starting the server');
  process.exit(78);
}

try {
  const envModulePath = resolve(__dirname, '..', 'dist', 'config', 'runtime-env.js');
  const envModule = await import(pathToFileURL(envModulePath).href);
  envModule.loadRuntimeEnv();
  const module = await import(pathToFileURL(serverPath).href);
  await module.main();
} catch (error) {
  console.error(`AWKN Review MCP fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
