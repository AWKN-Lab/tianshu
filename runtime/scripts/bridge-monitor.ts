#!/usr/bin/env tsx
/**
 * 桥接监控脚本：检查 llm-bridge 目录健康状态
 * 用法: npx tsx runtime/scripts/bridge-monitor.ts
 *
 * 检查项：
 * - 超时 req 文件（createdAt 超过 5 分钟，可能 runtime 已 timeout）
 * - 孤儿 resp 文件（无对应 req，可能 runtime 已退出）
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BRIDGE_DIR = process.env.AWKN_LLM_BRIDGE_DIR
  ?? resolve(process.cwd(), 'runtime', 'data', 'llm-bridge');

if (!existsSync(BRIDGE_DIR)) {
  console.log('✅ 桥接目录不存在（无活跃桥接）');
  process.exit(0);
}

const files = readdirSync(BRIDGE_DIR);
const reqFiles = files.filter(f => f.startsWith('req-'));
const respFiles = files.filter(f => f.startsWith('resp-'));
const now = Date.now();
const FIVE_MIN = 5 * 60 * 1000;

let orphan = 0;
let stuck = 0;

for (const f of reqFiles) {
  const stat = statSync(resolve(BRIDGE_DIR, f));
  const age = now - stat.mtimeMs;
  if (age > FIVE_MIN) {
    console.log(`⚠️ 超时 req: ${f} (${Math.round(age / 1000)}s)`);
    stuck++;
  }
}

for (const f of respFiles) {
  const reqName = f.replace('resp-', 'req-');
  if (!reqFiles.includes(reqName)) {
    console.log(`⚠️ 孤儿 resp: ${f}（无对应 req）`);
    orphan++;
  }
}

console.log(`\n汇总: ${reqFiles.length} req, ${respFiles.length} resp, ${stuck} 超时, ${orphan} 孤儿`);
if (stuck === 0 && orphan === 0 && reqFiles.length === 0 && respFiles.length === 0) {
  console.log('✅ 桥接目录为空（健康）');
} else if (stuck === 0 && orphan === 0) {
  console.log('✅ 桥接目录健康（有活跃请求在处理中）');
} else {
  console.log('❌ 桥接目录需要清理');
  process.exit(1);
}
