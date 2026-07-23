#!/usr/bin/env node
// bin/awkn-engine.js — 直接调用 src/cli.ts（用 tsx 运行）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '..', 'src', 'cli.ts');

// 查找本地 tsx（node_modules/.bin/tsx），避免 npx 联网下载
const tsxBin = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
const tsxCmd = existsSync(tsxBin) ? tsxBin : 'tsx';

const child = spawn(tsxCmd, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
