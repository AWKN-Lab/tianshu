// 临时 wrapper：在 Memory OS 工作目录下运行 cli.ts loop l2
// 用法：npx tsx scripts/run-l2-memory-os.mjs loop l2 <goalId> <prompt>
// 用途：
//   1. 解决 cli.ts 用 process.cwd() 作为 loop cwd 的问题（切换到 Memory OS 目录）
//   2. 解决 ESM 模块加载时机问题（patch 未应用时，codex.ts/router.ts 的常量在
//      cli.ts 的 loadEnv() 之前就固化了，导致 .env 配置被忽略）
//      修复：在加载 cli.ts 之前先把 runtime/.env 注入 process.env
// 运行后请删除
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = resolve(__dirname, '..', 'src', 'cli.ts');
const envPath = resolve(__dirname, '..', '.env');

// 先加载 runtime/.env 到 process.env（不覆盖已有值）
// 这样 ESM 模块加载时就能读到正确的 AWKN_LLM_PROVIDER / AWKN_CODEX_* 配置
try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
} catch {
  // .env 不存在或读取失败，忽略
}

// 切换到 Memory OS 工作目录，再加载 cli.ts
// 这样 cli.ts 中的 process.cwd() 会返回 Memory OS 目录
process.chdir('D:\\awkn-lab\\AWKN Memory OS');

await import(pathToFileURL(cliPath).href);
