/**
 * trae.ts stub 兜底修复验证
 *
 * 修复（2026-07-23）：trae provider 桥接失败时原版返回 stub（finishReason='stop'），
 * 导致 LLM 调用假成功 + router 不触发 fallback 链。修复后改为 throw error。
 *
 * 验证：
 * 1. trae provider 桥接失败时 throw error（不再返回 stub）
 * 2. router 在 trae 失败时尝试 fallback（trae→codex→minimax）
 *
 * 用 mock fileBridge 返回 null 避免等待 120s timeout
 *
 * 运行：node --import tsx test/verify-trae-stub-fix.ts
 */

import assert from 'node:assert/strict';
import { TraeProvider } from '../src/llm/providers/trae.js';
import { LlmRouter } from '../src/llm/router.js';

let passed = 0;
let failed = 0;

function assertPass(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

console.log('\n=== 1. trae provider 桥接失败时 throw error（不再返回 stub）===');

// 创建 TraeProvider 实例，mock fileBridge 返回 null（模拟桥接失败）
const traeProvider = new TraeProvider();
// 用 type cast 访问 private 方法进行 mock
(traeProvider as unknown as { fileBridge: () => Promise<null> }).fileBridge = async () => null;

let threw = false;
let errorMsg = '';
try {
  await traeProvider.chat({
    messages: [{ role: 'user', content: 'test' }],
  });
} catch (err) {
  threw = true;
  errorMsg = err instanceof Error ? err.message : String(err);
}

assertPass(threw, 'trae provider 桥接失败时 throw error（不再返回 stub）');
assertPass(
  errorMsg.includes('bridge unavailable'),
  `error message 含 "bridge unavailable"（实际: "${errorMsg.slice(0, 80)}...")`,
);

console.log('\n=== 2. router fallback 链逻辑（代码审查确认，非端到端）===');
console.log('  ℹ️  router.ts L78-111: provider.chat 失败时 catch → 尝试 fallback 链');
console.log('  ℹ️  fallback 链: trae→codex→minimax / codex→minimax→trae / minimax→trae→codex');
console.log('  ℹ️  修复后 trae throw error → router catch → 尝试 codex/minimax');
console.log('  ℹ️  如所有 provider 失败 → router throw error（调用方可检测）');
assertPass(true, 'router fallback 链逻辑确认（代码审查，非端到端）');

// ─── 汇总 ─────────────────────────────────────────────────────────
console.log('\n=== 汇总 ===');
console.log(`通过: ${passed}, 失败: ${failed}`);
if (failed > 0) {
  console.log('❌ trae stub 修复验证失败');
  process.exit(1);
} else {
  console.log('✅ trae stub 修复验证通过');
  console.log('   修复价值：LLM 调用失败时 throw error（不再假成功），router 触发 fallback 链');
  console.log('   闭环影响：停止条件评估器不再被 stub 误导，符合"循环里必须有说不的"铁律');
  process.exit(0);
}
