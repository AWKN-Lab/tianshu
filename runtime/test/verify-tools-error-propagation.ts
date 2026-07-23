#!/usr/bin/env tsx
/**
 * M3 进阶-24/25/26 端到端验证：内置工具错误传播（throw 而非返回 [error] 字符串）
 *
 * 核心问题：execTool/readTool/skillTool 捕获错误后返回字符串，绕过 agent-loop 的
 *   isError/consecutiveErrors/recordLoopFailure 机制 → 自进化闭环对工具错误盲区。
 *
 * 修复：所有错误路径必须 throw，让 agent-loop catch 记录 isError + recordLoopFailure。
 *   LLM 仍能看到错误内容（agent-loop line 310 格式化为 `[error] ${errorMessage}`）。
 *
 * 验证点：
 *   1. 静态：readTool 含 throw new Error（File not found）
 *   2. 静态：execTool catch 块含 throw new Error（不再 return `[error]`）
 *   3. 静态：skillTool 含 throw new Error（参数缺失 + skill not found）
 *   4. 静态：agent-loop.ts 的 catch 块含 recordLoopFailure（错误传播链完整）
 *   5. 行为：readTool 对不存在的文件 throw
 *   6. 行为：execTool 对不存在的命令 throw（ENOENT）
 *   7. 行为：execTool throw 的 error message 含 stdout/stderr（enriched）
 *   8. 行为：skillTool 参数缺失 throw
 *   9. 行为：skillTool skill 不存在 throw
 *  10. 一致性：writeTool 不 catch（writeFileSync 自然 throw）— 正例对照
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readTool, execTool } from '../src/tools/builtin/index.js';
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

/** 断言 async fn throw 且 message 匹配 */
async function assertThrows(
  fn: () => Promise<unknown>,
  msgMatch: string | RegExp,
  label: string,
): Promise<void> {
  let threw = false;
  let errMsg = '';
  try {
    await fn();
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, `${label} 应 throw`);
  const match = typeof msgMatch === 'string'
    ? errMsg.includes(msgMatch)
    : msgMatch.test(errMsg);
  assert(match, `${label} throw 的 message 应匹配 /${msgMatch}/，实际: ${errMsg.slice(0, 100)}`);
}

async function main(): Promise<void> {
  console.log('=== M3 进阶-24/25/26 验证：内置工具错误传播（throw 而非返回字符串）===\n');

  // ─── 1. 静态：readTool 含 throw new Error ─────────────────────
  console.log('[1] 静态：readTool 含 throw new Error（File not found）');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'src', 'tools', 'builtin', 'index.ts'),
      'utf-8',
    );
    const readToolSection = src.slice(src.indexOf('readTool'), src.indexOf('writeTool'));
    assert(readToolSection.includes('throw new Error'), 'readTool 应含 throw new Error');
    assert(readToolSection.includes('File not found'), 'throw message 应含 "File not found"');
    assert(readToolSection.includes('M3 进阶-25'), '应含 M3 进阶-25 修复注释');
    // 确认代码行不再有 return `File not found`（注释行排除）
    const codeLines1 = readToolSection.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const codeText1 = codeLines1.join('\n');
    assert(!codeText1.includes('return `File not found'), '代码行不应再 return `File not found`');
  }

  // ─── 2. 静态：execTool catch 块含 throw new Error ─────────────
  console.log('\n[2] 静态：execTool catch 块含 throw new Error（不再 return `[error]`）');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'src', 'tools', 'builtin', 'index.ts'),
      'utf-8',
    );
    const execToolSection = src.slice(src.indexOf('execTool'), src.indexOf('grepTool'));
    assert(execToolSection.includes('throw new Error'), 'execTool catch 应含 throw new Error');
    assert(execToolSection.includes('M3 进阶-24'), '应含 M3 进阶-24 修复注释');
    assert(execToolSection.includes('enriched'), '应含 enriched error 构造');
    // 确认不再有 return `[error]`
    const codeLines = execToolSection.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const codeText = codeLines.join('\n');
    assert(!codeText.includes('return `[error]'), '不应再 return `[error]` 字符串');
  }

  // ─── 3. 静态：skillTool 含 throw new Error ────────────────────
  console.log('\n[3] 静态：skillTool 含 throw new Error（参数缺失 + skill not found）');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'src', 'tools', 'builtin', 'skill-tool.ts'),
      'utf-8',
    );
    // 参数缺失 throw
    assert(src.includes("throw new Error('参数缺失"), '应含参数缺失 throw');
    // skill not found throw
    assert(src.includes('throw new Error(`Skill'), '应含 skill not found throw');
    assert(src.includes('M3 进阶-26'), '应含 M3 进阶-26 修复注释');
    // 确认代码行不再有 return '[error]（注释行排除）
    const codeLines3 = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const codeText3 = codeLines3.join('\n');
    assert(!codeText3.includes("return '[error]"), "代码行不应再 return '[error]'");
    assert(!codeText3.includes('return `[error]'), '代码行不应再 return `[error]`');
  }

  // ─── 4. 静态：agent-loop catch 块含 recordLoopFailure ─────────
  console.log('\n[4] 静态：agent-loop.ts 工具 catch 含 recordLoopFailure（错误传播链完整）');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'src', 'core', 'agent-loop.ts'),
      'utf-8',
    );
    // 工具执行 catch 块
    const toolCatchIdx = src.indexOf('toolRegistry.execute');
    assert(toolCatchIdx > -1, '应含 toolRegistry.execute 调用');
    const afterCall = src.slice(toolCatchIdx);
    const catchIdx = afterCall.indexOf('catch (err)');
    assert(catchIdx > -1, '工具执行后应有 catch');
    const catchBlock = afterCall.slice(catchIdx, catchIdx + 500);
    assert(catchBlock.includes('isError = true'), 'catch 块应设 isError = true');
    assert(catchBlock.includes('recordLoopFailure'), 'catch 块应调 recordLoopFailure');
    // LLM 仍能看到错误（line 310: content: isError ? `[error] ${errorMessage}` : toolResult）
    assert(src.includes("isError ? `[error] ${errorMessage}`"), 'LLM 应仍能看到 [error] 前缀的错误消息');
  }

  // ─── 5. 行为：readTool 对不存在的文件 throw ───────────────────
  console.log('\n[5] 行为：readTool 对不存在的文件 throw');
  {
    await assertThrows(
      () => readTool.execute({ path: '/nonexistent/path/xyz/abc.txt' }),
      'File not found',
      'readTool 不存在的文件',
    );
  }

  // ─── 6. 行为：execTool 对不存在的命令 throw ───────────────────
  console.log('\n[6] 行为：execTool 对不存在的命令 throw（ENOENT / 中文 Windows 报错）');
  {
    // Windows 中文系统报 "不是内部或外部命令"，英文报 "not found"/"not recognized"
    // 只验证 throw 发生（不匹配特定 message，跨平台兼容）
    let threw = false;
    try {
      await execTool.execute({ command: 'this-command-does-not-exist-xyz123' });
    } catch {
      threw = true;
    }
    assert(threw, 'execTool 不存在的命令应 throw（不返回 [error] 字符串）');
  }

  // ─── 7. 行为：execTool throw 的 error message 含 stdout/stderr ─
  console.log('\n[7] 行为：execTool 失败命令的 error message 含输出（enriched）');
  {
    // 用一个会失败的命令（非零退出码），验证 stderr 出现在 throw 的 message 中
    let errMsg = '';
    try {
      // node -e "process.exit(1)" 退出码 1，无 stdout/stderr
      // 改用 node -e "console.error('test-stderr-output'); process.exit(1)"
      await execTool.execute({
        command: 'node -e "console.error(\'test-stderr-output\'); process.exit(1)"',
      });
    } catch (e) {
      errMsg = (e as Error).message;
    }
    assert(errMsg.length > 0, 'execTool 失败应 throw 非空 error message');
    assert(
      errMsg.includes('test-stderr-output'),
      `throw 的 message 应含 stderr 输出 "test-stderr-output"，实际: ${errMsg.slice(0, 200)}`,
    );
  }

  // ─── 8. 行为：skillTool 参数缺失 throw ─────────────────────────
  console.log('\n[8] 行为：skillTool 参数缺失 throw');
  {
    await assertThrows(
      () => skillTool.execute({ skill: '', input: 'test' } as Record<string, unknown>),
      '参数缺失',
      'skillTool 缺 skill',
    );
    await assertThrows(
      () => skillTool.execute({ skill: 'test', input: '' } as Record<string, unknown>),
      '参数缺失',
      'skillTool 缺 input',
    );
  }

  // ─── 9. 行为：skillTool skill 不存在 throw ─────────────────────
  console.log('\n[9] 行为：skillTool skill 不存在 throw');
  {
    await assertThrows(
      () => skillTool.execute({ skill: 'nonexistent-skill-xyz', input: 'test' }),
      'not found',
      'skillTool 不存在的 skill',
    );
  }

  // ─── 10. 一致性：writeTool 不 catch（自然 throw）─ 正例对照 ────
  console.log('\n[10] 一致性：writeTool 不 catch（writeFileSync 自然 throw）— 正例对照');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'src', 'tools', 'builtin', 'index.ts'),
      'utf-8',
    );
    const writeToolSection = src.slice(src.indexOf('writeTool'), src.indexOf('execTool'));
    // writeTool 的 execute 不含 try/catch（writeFileSync 自然 throw）
    assert(!writeToolSection.includes('catch'), 'writeTool 不应有 catch（writeFileSync 自然 throw）');
    assert(writeToolSection.includes('writeFileSync'), 'writeTool 应含 writeFileSync');
  }

  // ─── 汇总 ─────────────────────────────────────────────────────
  console.log('\n=== 汇总 ===');
  console.log(`通过: ${pass}, 失败: ${fail}`);
  if (fail > 0) {
    console.log('\n失败项:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log('\n✅ M3 进阶-24/25/26 验证全部通过 — 内置工具错误传播修复正确');
}

main().catch((err) => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
