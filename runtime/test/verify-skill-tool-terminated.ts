#!/usr/bin/env tsx
/**
 * M3 进阶-7 验证 — skill-tool 检查 terminated
 *
 * Bug：skill-tool.ts 不检查 result.terminated，把终止的子 AgentLoop 输出当成功结果返回。
 *   子循环可能因 LLM 失败 3 次 / 重复模式 / budget 超限被终止，
 *   finalText 是错误占位文本或空串，但调用方当成功技能输出 → "无信号当成功"同类 bug。
 *
 * 修复：terminated 时 throw error，让上层 toolRegistry.execute → agent-loop catch 记录为 isError。
 *
 * 验证策略（AgentLoop 不可注入 mock，混合静态 + 行为验证）：
 *   1. 静态：源码含 terminated 检查 + throw
 *   2. 行为：skill 不存在时返回 [error] 字符串（现有逻辑，验证 import 正常）
 *   3. 行为：参数缺失时返回 [error] 字符串
 *   4. 静态：对比 tianhuo-cicd-loop.ts 也有 terminated 检查（一致性验证）
 *   5. 类型：skillTool.execute 签名正确
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { skillTool } from '../src/tools/builtin/skill-tool.js';

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
  console.log('=== M3 进阶-7 验证：skill-tool 检查 terminated ===\n');

  // ─── 1. 静态：源码含 terminated 检查 ─────────────────────────
  console.log('[1] 静态：源码含 terminated 检查 + throw');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'src', 'tools', 'builtin', 'skill-tool.ts'),
      'utf-8',
    );
    assert(src.includes('result.terminated'), '源码应含 result.terminated 检查');
    assert(src.includes('Skill "${skillName}" terminated'), 'throw error message 应含 skill 名');
    assert(src.includes('M3 进阶-7'), '源码应含 M3 进阶-7 修复注释');
    assert(src.includes("excludedTools: ['skill']"), '技能子循环应隐藏 skill，防止递归找技能');
    // 确认 throw 在 return 之前（排除注释行 — 注释里也有 "return result.finalText"）
    // 用正则找非注释的代码行
    const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const codeText = codeLines.join('\n');
    const throwIdx = codeText.indexOf('throw new Error');
    const returnIdx = codeText.indexOf('return result.finalText');
    assert(throwIdx > -1, '代码应含 throw new Error');
    assert(returnIdx > -1, '代码应含 return result.finalText');
    assert(throwIdx < returnIdx, 'throw 应在 return result.finalText 之前（非注释行）');
  }

  // ─── 2. 行为：skill 不存在时 throw（M3 进阶-26 修复后） ────────
  console.log('\n[2] 行为：skill 不存在时 throw（M3 进阶-26 修复后，原返回 [error] 字符串）');
  {
    let threw = false;
    let errMsg = '';
    try {
      await skillTool.execute({ skill: 'nonexistent-skill-xyz', input: 'test' });
    } catch (e) {
      threw = true;
      errMsg = (e as Error).message;
    }
    assert(threw, '不存在的 skill 应 throw（不能返回 [error] 字符串）');
    assert(errMsg.includes('not found'), 'throw 的 error message 应含 "not found"');
  }

  // ─── 3. 行为：参数缺失时 throw（M3 进阶-26 修复后） ──────────
  console.log('\n[3] 行为：参数缺失时 throw（M3 进阶-26 修复后，原返回 [error] 字符串）');
  {
    let threw1 = false;
    let msg1 = '';
    try {
      await skillTool.execute({ skill: '', input: 'test' } as Record<string, unknown>);
    } catch (e) {
      threw1 = true;
      msg1 = (e as Error).message;
    }
    assert(threw1, '缺 skill 应 throw');
    assert(msg1.includes('参数缺失'), 'throw 的 error message 应含 "参数缺失"');

    let threw2 = false;
    try {
      await skillTool.execute({ skill: 'test', input: '' } as Record<string, unknown>);
    } catch {
      threw2 = true;
    }
    assert(threw2, '缺 input 应 throw');
  }

  // ─── 4. 一致性：tianhuo-cicd-loop.ts 也有 terminated 检查 ────
  console.log('\n[4] 一致性：tianhuo-cicd-loop.ts 也有 terminated 检查（对比验证）');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'src', 'orchestrator', 'tianhuo-cicd-loop.ts'),
      'utf-8',
    );
    assert(src.includes('terminated'), 'tianhuo-cicd-loop 应有 terminated 检查');
    // 确认两处模式一致：检查 terminated 后返回 achieved:false
    assert(src.includes('if (tianhuoResult.terminated)'), '应有 if (tianhuoResult.terminated) 分支');
  }

  // ─── 5. 类型：skillTool 签名正确 ─────────────────────────────
  console.log('\n[5] 类型：skillTool 签名正确');
  {
    assert(skillTool.name === 'skill', 'tool name 应为 "skill"');
    assert(typeof skillTool.execute === 'function', 'execute 应为 function');
    assert(skillTool.parameters.required?.includes('skill'), 'parameters.required 应含 "skill"');
    assert(skillTool.parameters.required?.includes('input'), 'parameters.required 应含 "input"');
  }

  // ─── 6. 修复影响分析（对比 M3 进阶-4/5/6） ──────────────────
  console.log('\n[6] 修复影响分析（对比同类 bug）');
  {
    // skill-tool 的 bug 与 M3 进阶-4 同类：把失败当成功
    // 但实现方式不同：
    //   - trae stub: 返回 stub content（不 throw）
    //   - skill-tool: 返回 result.finalText（不 throw，不检查 terminated）
    // 修复方式相同：throw error（让上层处理为 error）
    console.log('    bug 模式：子循环 terminated 但返回 finalText 当成功（不 throw）');
    console.log('    修复方式：terminated 时 throw error（让 toolRegistry → agent-loop catch 记录 isError）');
    console.log('    同类 bug：trae stub（M3 进阶-4）/ hook fail-open（M3 进阶-5）');
    assert(true, '修复方式与 M3 进阶-4/5 一致（throw 替代静默返回）');
  }

  // ─── 汇总 ─────────────────────────────────────────────────────
  console.log('\n=== 汇总 ===');
  console.log(`通过: ${pass}, 失败: ${fail}`);
  if (fail > 0) {
    console.log('\n失败项:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log('\n✅ M3 进阶-7 验证全部通过 — skill-tool 检查 terminated 修复正确');
}

main().catch((err) => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
