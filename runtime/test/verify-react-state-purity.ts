#!/usr/bin/env tsx
/**
 * M3 进阶-27 验证 — react-loop 纯函数返回值被接住 + loop-monitor NaN 防御
 *
 * 原版 bug：
 * 1. agent-loop.ts 调用 recordObservation(reactState, ...) / reflect(reactState) 不接 return
 *    → reactState 永远不更新 → observations 空 / consecutiveErrors=0 / lastReflection undefined
 *    → shouldReflect 永远 false（consecutiveErrors=0）→ 反思机制死代码
 *    → reflection stop 永远不触发（lastReflection undefined）
 * 2. agent-loop.ts 调用 recordTokenUsage(...) 不接 return
 *    → token 异常增长被检测 + logged → 但循环不停止 → "假检测"
 * 3. loop-monitor.ts recordTokenUsage 不验证 NaN/负数
 *    → NaN > 2.0 = false → 静默通过 → "无信号被当作成功"
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createReActState, recordObservation, reflect, shouldReflect } from '../src/core/react-loop.js';
import { LoopMonitor } from '../src/core/loop-monitor.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

async function main(): Promise<void> {
  console.log('=== M3 进阶-27 验证：react-loop 纯函数返回值 + loop-monitor NaN 防御 ===\n');

  // ─── 1. 静态：agent-loop.ts 接住纯函数返回值 ────────────────
  console.log('[1] 静态：agent-loop.ts 接住 recordObservation/reflect/recordTokenUsage 返回值');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'src', 'core', 'agent-loop.ts'),
      'utf-8',
    );
    // 接住 recordObservation 返回值
    assert(src.includes('reactState = recordObservation(reactState,'), 'recordObservation 返回值应被接住');
    // 接住 reflect 返回值
    assert(src.includes('reactState = reflect(reactState)'), 'reflect 返回值应被接住');
    // 接住 recordTokenUsage 返回值
    assert(src.includes('const tokenAnomaly = this.loopMonitor.recordTokenUsage'), 'recordTokenUsage 返回值应被接住');
    // tokenAnomaly 检查后会 return（终止循环）
    assert(src.includes('if (tokenAnomaly)'), 'tokenAnomaly 应被检查');
    assert(src.includes("'token anomaly'"), "异常时应返回 'token anomaly' terminated reason");
    // reactState 改为 let
    assert(src.includes('let reactState = resumeFrom'), 'reactState 应为 let（允许重新赋值）');
    assert(!/const reactState = resumeFrom/.test(src), '不应再有 const reactState');
    // reflection stop 接入 corrections-ledger
    assert(src.includes("recordLoopFailure(`反思停止"), 'reflection stop 应记录到 corrections-ledger');
  }

  // ─── 2. 静态：loop-monitor.ts 验证 NaN/负数 ────────────────
  console.log('\n[2] 静态：loop-monitor.ts recordTokenUsage 验证 NaN/负数');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'src', 'core', 'loop-monitor.ts'),
      'utf-8',
    );
    assert(src.includes('Number.isFinite(tokens)'), '应使用 Number.isFinite 验证 tokens');
    assert(src.includes('tokens < 0'), '应检查 tokens < 0');
    assert(src.includes('Invalid token count received'), '应有 warning 日志说明无效输入');
  }

  // ─── 3. 行为：recordObservation 更新 state（纯函数正确接住后） ────
  console.log('\n[3] 行为：recordObservation 更新 state（接住返回值）');
  {
    let state = createReActState('test-session');
    assert(state.observations.length === 0, '初始 observations 应为空');
    assert(state.totalObservations === 0, '初始 totalObservations 应为 0');
    assert(state.consecutiveErrors === 0, '初始 consecutiveErrors 应为 0');

    // 接住返回值（与原版 bug 对比：原版不接 → state 永不更新）
    state = recordObservation(state, {
      toolName: 'test-tool',
      args: { x: 1 },
      result: 'success',
      isError: false,
      durationMs: 100,
    });

    assert(state.observations.length === 1, 'recordObservation 后 observations 应为 1');
    assert(state.totalObservations === 1, 'totalObservations 应为 1');
    assert(state.consecutiveErrors === 0, '成功时 consecutiveErrors 应仍为 0');
    assert(state.observations[0].toolName === 'test-tool', 'observation 应含正确 toolName');
    assert(state.step === 'OBSERVE', 'step 应更新为 OBSERVE');
  }

  // ─── 4. 行为：recordObservation 错误时更新 consecutiveErrors ──
  console.log('\n[4] 行为：recordObservation 错误时更新 consecutiveErrors');
  {
    let state = createReActState('test-session');

    state = recordObservation(state, {
      toolName: 'fail-tool',
      args: {},
      result: 'error',
      isError: true,
      errorMessage: 'something failed',
      durationMs: 50,
    });

    assert(state.consecutiveErrors === 1, '错误后 consecutiveErrors 应为 1');
    assert(state.totalErrors === 1, 'totalErrors 应为 1');
    assert(shouldReflect(state) === true, 'consecutiveErrors=1 应触发 shouldReflect');

    // 第二次错误
    state = recordObservation(state, {
      toolName: 'fail-tool',
      args: {},
      result: 'error',
      isError: true,
      errorMessage: 'failed again',
      durationMs: 50,
    });

    assert(state.consecutiveErrors === 2, '第二次错误后 consecutiveErrors 应为 2');
    assert(state.totalErrors === 2, 'totalErrors 应为 2');
  }

  // ─── 5. 行为：reflect 更新 lastReflection（接住返回值）──────
  console.log('\n[5] 行为：reflect 更新 lastReflection（接住返回值）');
  {
    let state = createReActState('test-session');
    assert(state.lastReflection === undefined, '初始 lastReflection 应为 undefined');

    // 添加一次错误观察让 shouldReflect 返回 true
    state = recordObservation(state, {
      toolName: 'fail-tool',
      args: {},
      result: 'error',
      isError: true,
      errorMessage: 'failed',
      durationMs: 50,
    });

    assert(shouldReflect(state) === true, 'shouldReflect 应返回 true（consecutiveErrors=1）');

    // 接住 reflect 返回值（与原版 bug 对比：原版不接 → lastReflection 永远 undefined）
    state = reflect(state);

    assert(state.lastReflection !== undefined, 'reflect 后 lastReflection 应非 undefined');
    assert(state.reflections.length === 1, 'reflections 数组应含 1 条');
    assert(typeof state.lastReflection.shouldContinue === 'boolean', 'lastReflection.shouldContinue 应为 boolean');
    assert(typeof state.lastReflection.reason === 'string', 'lastReflection.reason 应为 string');
  }

  // ─── 6. 行为：reflect 连续 2 次错误后应停止 ─────────────────
  console.log('\n[6] 行为：reflect 连续 2 次错误后 shouldContinue=false');
  {
    let state = createReActState('test-session');

    state = recordObservation(state, {
      toolName: 'fail-tool',
      args: {},
      result: 'error',
      isError: true,
      errorMessage: 'fail 1',
      durationMs: 50,
    });
    state = recordObservation(state, {
      toolName: 'fail-tool',
      args: {},
      result: 'error',
      isError: true,
      errorMessage: 'fail 2',
      durationMs: 50,
    });

    assert(state.consecutiveErrors === 2, '应为 2 次连续错误');
    state = reflect(state);
    assert(state.lastReflection?.shouldContinue === false, '连续 2 次错误后 shouldContinue 应为 false');
    assert(state.lastReflection?.step === 'DONE', 'step 应为 DONE');
    assert(state.lastReflection?.confidence === 0.95, 'confidence 应为 0.95');
  }

  // ─── 7. 行为：recordTokenUsage NaN 返回 true（anomaly）──────
  console.log('\n[7] 行为：recordTokenUsage NaN 返回 true（fail-closed）');
  {
    const monitor = new LoopMonitor();
    // 第一次正常 token（建立 baseline）
    let result = monitor.recordTokenUsage(100);
    assert(result === false, '第一次 100 tokens 应返回 false（无足够历史）');

    // NaN 输入应立即返回 true（不污染 tokenHistory，因为 isFinite 检查在 push 之前）
    result = monitor.recordTokenUsage(NaN);
    assert(result === true, 'NaN 输入应返回 true（anomaly）');

    // NaN 不应进入 tokenHistory — 后续正常 token 仍能建立 baseline
    // 100 → 150 → 300（如果 NaN 进了历史，会变成 100, NaN, 150, 300，影响后续判断）
    result = monitor.recordTokenUsage(150);
    assert(result === false, 'NaN 后 150 应正常返回 false（NaN 未污染历史）');
    result = monitor.recordTokenUsage(300);
    assert(result === true, '100→300 ratio=3.0 超阈值应返回 true（NaN 未污染历史，baseline 仍是 100）');
  }

  // ─── 8. 行为：recordTokenUsage 负数返回 true（anomaly）───────
  console.log('\n[8] 行为：recordTokenUsage 负数返回 true（fail-closed）');
  {
    const monitor = new LoopMonitor();
    const result = monitor.recordTokenUsage(-100);
    assert(result === true, '负数输入应返回 true（anomaly）');
  }

  // ─── 9. 行为：recordTokenUsage 正常增长不触发 anomaly ────────
  console.log('\n[9] 行为：recordTokenUsage 正常增长不触发 anomaly');
  {
    const monitor = new LoopMonitor();
    // 正常序列：100 → 150 → 200（ratio 2.0，不超阈值）
    let r1 = monitor.recordTokenUsage(100);
    let r2 = monitor.recordTokenUsage(150);
    let r3 = monitor.recordTokenUsage(200);
    assert(r1 === false && r2 === false, '前两次无足够历史应返回 false');
    assert(r3 === false, '100→200 ratio=2.0，不超阈值 2.0 应返回 false');
  }

  // ─── 10. 行为：recordTokenUsage 异常增长触发 anomaly ─────────
  console.log('\n[10] 行为：recordTokenUsage 异常增长触发 anomaly');
  {
    const monitor = new LoopMonitor();
    // 异常序列：100 → 150 → 300（ratio 3.0，超阈值 2.0）
    monitor.recordTokenUsage(100);
    monitor.recordTokenUsage(150);
    const r3 = monitor.recordTokenUsage(300);
    assert(r3 === true, '100→300 ratio=3.0 超阈值 2.0 应返回 true（anomaly）');
  }

  // ─── 11. 行为：Infinity 也被视为 anomaly ────────────────────
  console.log('\n[11] 行为：recordTokenUsage Infinity 返回 true（fail-closed）');
  {
    const monitor = new LoopMonitor();
    const result = monitor.recordTokenUsage(Infinity);
    assert(result === true, 'Infinity 输入应返回 true（anomaly）');
  }

  // ─── 汇总 ─────────────────────────────────────────────────────
  console.log('\n=== 汇总 ===');
  console.log(`通过: ${pass}, 失败: ${fail}`);
  if (fail > 0) {
    console.log('\n失败项:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log('\n✅ M3 进阶-27 验证全部通过 — react-loop 纯函数返回值正确接住 + loop-monitor NaN 防御正确');
  process.exit(0);
}

main().catch((err) => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
