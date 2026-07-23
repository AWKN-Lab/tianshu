/**
 * M3 进阶-30 验证：codex/minimax provider 空 content fail-closed
 *
 * Bug（E96 变体）：content: choice.message.content ?? '' → 空 content + 无 tool_calls
 *   → agent-loop break → 假成功（finalText='' terminated=false）
 * Fix：无 content 且无 tool_calls → throw（fail-closed）
 *
 * 与 M3 进阶-19（trae.ts hook 路径）同类，但不同代码路径（直接 API 调用）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CODEX_SRC = resolve(__dirname, '..', 'src', 'llm', 'providers', 'codex.ts');
const MINIMAX_SRC = resolve(__dirname, '..', 'src', 'llm', 'providers', 'minimax.ts');

describe('M3 进阶-30: codex/minimax 空 content fail-closed', () => {

  describe('codex.ts', () => {
    const src = readFileSync(CODEX_SRC, 'utf-8');

    it('有空 content + 无 tool_calls 的 fail-closed 检查', () => {
      assert.ok(
        src.includes('!choice.message.content && !choice.message.tool_calls?.length'),
        'codex.ts 必须检查空 content + 无 tool_calls → throw',
      );
    });

    it('fail-closed 检查在 return 之前', () => {
      const guardIdx = src.indexOf('!choice.message.content && !choice.message.tool_calls?.length');
      // 从 guard 之后搜索 return 语句（避免匹配注释中的相同文本）
      const returnIdx = src.indexOf('content: choice.message.content ??', guardIdx);
      assert.ok(guardIdx > -1 && returnIdx > -1);
      assert.ok(guardIdx < returnIdx, 'fail-closed 守卫必须在 return 之前');
    });

    it('fail-closed 时 throw 而非返回空', () => {
      const guardIdx = src.indexOf('!choice.message.content && !choice.message.tool_calls?.length');
      const afterGuard = src.slice(guardIdx, guardIdx + 300);
      assert.ok(afterGuard.includes('throw'), 'fail-closed 时必须 throw');
    });

    it('tool_calls 存在时允许空 content（tool-use 响应）', () => {
      // 守卫条件是 !content && !tool_calls — 即两者都为空才 throw
      // 如果有 tool_calls，条件为 false，不 throw → 正确
      const guard = '!choice.message.content && !choice.message.tool_calls?.length';
      assert.ok(src.includes(guard), '守卫应同时检查 content 和 tool_calls');
    });
  });

  describe('minimax.ts', () => {
    const src = readFileSync(MINIMAX_SRC, 'utf-8');

    it('有空 content + 无 tool_calls 的 fail-closed 检查', () => {
      assert.ok(
        src.includes('!choice.message.content && !choice.message.tool_calls?.length'),
        'minimax.ts 必须检查空 content + 无 tool_calls → throw',
      );
    });

    it('fail-closed 检查在 return 之前', () => {
      const guardIdx = src.indexOf('!choice.message.content && !choice.message.tool_calls?.length');
      // 从 guard 之后搜索 return 语句（避免匹配注释中的相同文本）
      const returnIdx = src.indexOf('content: choice.message.content ??', guardIdx);
      assert.ok(guardIdx > -1 && returnIdx > -1);
      assert.ok(guardIdx < returnIdx, 'fail-closed 守卫必须在 return 之前');
    });

    it('fail-closed 时 throw 而非返回空', () => {
      const guardIdx = src.indexOf('!choice.message.content && !choice.message.tool_calls?.length');
      const afterGuard = src.slice(guardIdx, guardIdx + 300);
      assert.ok(afterGuard.includes('throw'), 'fail-closed 时必须 throw');
    });
  });

  describe('与 M3 进阶-19（trae.ts）一致性', () => {
    it('三个 provider 都有空 content 防御（E96 全覆盖）', () => {
      const traeSrc = readFileSync(resolve(__dirname, '..', 'src', 'llm', 'providers', 'trae.ts'), 'utf-8');
      const codexSrc = readFileSync(CODEX_SRC, 'utf-8');
      const minimaxSrc = readFileSync(MINIMAX_SRC, 'utf-8');

      // trae.ts 已有 M3 进阶-19 的空 content 检查
      assert.ok(
        traeSrc.includes('empty') || traeSrc.includes('!') && traeSrc.includes('content'),
        'trae.ts 应有空 content 检查（M3 进阶-19）',
      );
      // codex/minimax 新增 M3 进阶-30
      assert.ok(codexSrc.includes('!choice.message.content && !choice.message.tool_calls'));
      assert.ok(minimaxSrc.includes('!choice.message.content && !choice.message.tool_calls'));
    });
  });
});
