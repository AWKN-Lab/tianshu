#!/usr/bin/env tsx
/**
 * M3 进阶-5 端到端验证 — hook-manager failClosed 修复
 *
 * Bug 背景（与 M3 进阶-4 trae stub 同类）：
 *   hook-manager.ts executeCommandHook 在 command 输出非 JSON 时默认 success:true
 *   - 对 pre_tool_use 安全钩子风险最大：broken hook 静默放行危险工具
 *   - 与 trae stub bug 同类："无信号"被当作"成功"
 *
 * 修复（M3 进阶-5，2026-07-23）：
 *   - Hook 接口新增 opt-in failClosed?: boolean 字段
 *   - failClosed=true 时：
 *     - command 输出非 JSON → success:false + block:true（pre_tool_use）
 *     - command 输出 JSON 但缺 success 字段 → 同上
 *   - 默认（failClosed=false/undefined）：保持原 fail-open 行为（向后兼容 informational hooks）
 *
 * 验证项：
 *   1. failClosed hook 输出非 JSON → success:false
 *   2. failClosed pre_tool_use hook 输出非 JSON → block:true（fail-closed）
 *   3. failClosed hook 输出 JSON 但缺 success 字段 → success:false
 *   4. 默认 hook（failClosed 未设置）输出非 JSON → success:true（向后兼容）
 *   5. 默认 hook 输出合法 JSON → 正常解析
 *   6. failClosed hook 输出合法 JSON（含 success:true）→ success:true（不误伤）
 *   7. failClosed 非 pre_tool_use hook 输出非 JSON → success:false 但 block:undefined（不阻断）
 *   8. Hook 接口类型包含 failClosed 字段（编译时保证）
 */

import { hookManager, HookManager } from '../src/core/hook-manager.js';
import type { Hook, HookResult } from '../src/core/hook-types.js';

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

// 临时 hook manager（避免污染单例）
const mgr = new HookManager();

/**
 * 测试辅助：注册一个 command hook，触发它，返回结果
 * 命令使用 PowerShell 兼容写法（echo 输出，可输出空字符串模拟 broken hook）
 */
async function runHook(opts: {
  point: Hook['point'];
  failClosed?: boolean;
  command: string;
  payload?: Parameters<HookManager['trigger']>[1];
}): Promise<HookResult[]> {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mgr.register({
    id,
    point: opts.point,
    type: 'command',
    command: opts.command,
    timeout: 3000,
    failClosed: opts.failClosed,
  });
  const results = await mgr.trigger(opts.point, opts.payload ?? { point: opts.point });
  mgr.unload(id);
  return results;
}

async function main(): Promise<void> {
  console.log('=== M3 进阶-5 验证：hook-manager failClosed 修复 ===\n');

  // ─── 1. failClosed hook 输出非 JSON → success:false ─────────────
  console.log('[1] failClosed hook 输出非 JSON → success:false');
  {
    const results = await runHook({
      point: 'session_start',
      failClosed: true,
      // cmd /c echo 输出 "broken output"（非 JSON）
      command: process.platform === 'win32' ? 'cmd /c echo broken output' : 'echo broken output',
    });
    assert(results.length === 1, '应返回 1 个结果');
    assert(results[0].success === false, 'success 应为 false（fail-closed）');
    assert(results[0].error !== undefined && results[0].error.includes('not valid JSON'), 'error 应含 "not valid JSON"');
  }

  // ─── 2. failClosed pre_tool_use hook 输出非 JSON → block:true ───
  console.log('\n[2] failClosed pre_tool_use hook 输出非 JSON → block:true');
  {
    const results = await runHook({
      point: 'pre_tool_use',
      failClosed: true,
      command: process.platform === 'win32' ? 'cmd /c echo not-json' : 'echo not-json',
      payload: { point: 'pre_tool_use', toolName: 'rm' },
    });
    assert(results[0].success === false, 'success 应为 false');
    assert(results[0].block === true, 'pre_tool_use 应 block:true（fail-closed 阻断工具）');
    assert(results[0].blockReason !== undefined && results[0].blockReason.includes('not valid JSON'), 'blockReason 应含诊断信息');
  }

  // ─── 3. failClosed hook 输出 JSON 但缺 success 字段 → success:false ─
  console.log('\n[3] failClosed hook 输出 JSON 但缺 success 字段 → success:false');
  {
    const results = await runHook({
      point: 'pre_tool_use',
      failClosed: true,
      // 输出 {"output":"checked"} 但无 success 字段
      command: process.platform === 'win32'
        ? 'cmd /c echo {"output":"checked"}'
        : 'echo \'{"output":"checked"}\'',
      payload: { point: 'pre_tool_use', toolName: 'rm' },
    });
    assert(results[0].success === false, '缺 success 字段应 fail-closed');
    assert(results[0].block === true, 'pre_tool_use 缺 success 应 block:true');
    assert(results[0].error !== undefined && results[0].error.includes('missing "success"'), 'error 应含 "missing success"');
  }

  // ─── 4. 默认 hook（failClosed 未设置）输出非 JSON → success:true ───
  console.log('\n[4] 默认 hook（failClosed 未设置）输出非 JSON → success:true（向后兼容）');
  {
    const results = await runHook({
      point: 'session_start',
      // 不设 failClosed
      command: process.platform === 'win32' ? 'cmd /c echo plain text' : 'echo plain text',
    });
    assert(results[0].success === true, '默认 fail-open，success 应为 true（向后兼容）');
    assert(results[0].block === undefined, '默认行为不 block');
  }

  // ─── 5. 默认 hook 输出合法 JSON → 正常解析 ────────────────────
  console.log('\n[5] 默认 hook 输出合法 JSON → 正常解析');
  {
    const results = await runHook({
      point: 'pre_tool_use',
      command: process.platform === 'win32'
        ? 'cmd /c echo {"success":true,"block":false}'
        : 'echo \'{"success":true,"block":false}\'',
      payload: { point: 'pre_tool_use', toolName: 'ls' },
    });
    assert(results[0].success === true, 'success 应为 true（JSON 显式）');
    assert(results[0].block === false, 'block 应为 false（JSON 显式）');
  }

  // ─── 6. failClosed hook 输出合法 JSON（含 success:true）→ success:true ─
  console.log('\n[6] failClosed hook 输出合法 JSON（含 success:true）→ success:true（不误伤）');
  {
    const results = await runHook({
      point: 'pre_tool_use',
      failClosed: true,
      command: process.platform === 'win32'
        ? 'cmd /c echo {"success":true,"block":false,"blockReason":null}'
        : 'echo \'{"success":true,"block":false}\'',
      payload: { point: 'pre_tool_use', toolName: 'ls' },
    });
    assert(results[0].success === true, '合法 JSON 含 success:true 应通过（不误伤）');
    assert(results[0].block === false, 'block 应为 false');
  }

  // ─── 7. failClosed 非 pre_tool_use hook 输出非 JSON → success:false 但 block:undefined ─
  console.log('\n[7] failClosed 非 pre_tool_use hook 输出非 JSON → success:false 但 block:undefined');
  {
    const results = await runHook({
      point: 'session_stop',
      failClosed: true,
      command: process.platform === 'win32' ? 'cmd /c echo broken' : 'echo broken',
    });
    assert(results[0].success === false, '非 pre_tool_use 也应 success:false');
    assert(results[0].block === undefined, '非 pre_tool_use 不应 block（block 只对 pre_tool_use 有效）');
  }

  // ─── 8. Hook 接口类型包含 failClosed 字段 ─────────────────────
  console.log('\n[8] Hook 接口类型包含 failClosed 字段（编译时保证）');
  {
    // 类型断言：如果 Hook 接口没 failClosed 字段，编译会失败
    const hook: Hook = {
      id: 'type-check',
      point: 'session_start',
      type: 'function',
      fn: async () => ({ success: true }),
      timeout: 1000,
      failClosed: true,
    };
    assert(hook.failClosed === true, 'Hook 接口应支持 failClosed 字段');
  }

  // ─── 汇总 ─────────────────────────────────────────────────────
  console.log('\n=== 汇总 ===');
  console.log(`通过: ${pass}, 失败: ${fail}`);
  if (fail > 0) {
    console.log('\n失败项:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log('\n✅ M3 进阶-5 验证全部通过 — hook-manager failClosed 修复正确');
}

main().catch((err) => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
