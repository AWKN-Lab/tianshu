#!/usr/bin/env node
// bin/awkn-action-runner.js — 本地 Action Runner 入口
// 与 awkn-engine.js 同模式：tsx 启动 TypeScript CLI
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '..', 'src', 'action', 'action-cli.ts');

// 查找本地 tsx
const tsxBin = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
const tsxCmd = existsSync(tsxBin) ? tsxBin : 'tsx';

const child = spawn(tsxCmd, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
