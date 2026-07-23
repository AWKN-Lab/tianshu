/**
 * M3 进阶-13 端到端验证：LLM provider 网络超时 + 防御性检查
 *
 * 验证点：
 * 1. 静态：codex.ts/minimax.ts 含 AbortController + signal + clearTimeout
 * 2. 静态：两个 provider 含 choices[0] 空检查 + usage 缺失检查
 * 3. 静态：LLM_TIMEOUT_MS 默认 120000，可被 AWKN_LLM_TIMEOUT_MS 覆盖
 * 4. 行为：超时实际触发（用本地 hung server + 短超时）
 * 5. 行为：超时抛出含 "timeout" 的错误（让 router 触发 fallback）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSrc(name: string): string {
  return readFileSync(resolve(__dirname, '..', 'src', 'llm', 'providers', name), 'utf-8');
}

const CODEX_SRC = readSrc('codex.ts');
const MINIMAX_SRC = readSrc('minimax.ts');

describe('M3 进阶-13: LLM provider 网络超时 + 防御性检查', () => {
  it('静态：codex.ts 含 AbortController + signal + clearTimeout', () => {
    assert.ok(CODEX_SRC.includes('new AbortController()'), 'codex 应含 new AbortController()');
    assert.ok(CODEX_SRC.includes('signal: controller.signal'), 'codex 应含 signal: controller.signal');
    assert.ok(CODEX_SRC.includes('clearTimeout(timeout)'), 'codex 应含 clearTimeout');
  });

  it('静态：minimax.ts 含 AbortController + signal + clearTimeout', () => {
    assert.ok(MINIMAX_SRC.includes('new AbortController()'), 'minimax 应含 new AbortController()');
    assert.ok(MINIMAX_SRC.includes('signal: controller.signal'), 'minimax 应含 signal: controller.signal');
    assert.ok(MINIMAX_SRC.includes('clearTimeout(timeout)'), 'minimax 应含 clearTimeout');
  });

  it('静态：两个 provider 含 choices 空检查', () => {
    assert.ok(CODEX_SRC.includes('data.choices?.[0]'), 'codex 应含 data.choices?.[0]');
    assert.ok(CODEX_SRC.includes('no choices'), 'codex 应含 no choices 错误');
    assert.ok(MINIMAX_SRC.includes('data.choices?.[0]'), 'minimax 应含 data.choices?.[0]');
    assert.ok(MINIMAX_SRC.includes('no choices'), 'minimax 应含 no choices 错误');
  });

  it('静态：两个 provider 含 usage 缺失检查', () => {
    assert.ok(CODEX_SRC.includes('!data.usage'), 'codex 应含 !data.usage 检查');
    assert.ok(MINIMAX_SRC.includes('!data.usage'), 'minimax 应含 !data.usage 检查');
  });

  it('静态：LLM_TIMEOUT_MS 默认 120000 + 环境变量覆盖', () => {
    assert.ok(CODEX_SRC.includes('AWKN_LLM_TIMEOUT_MS') && CODEX_SRC.includes('120000'),
      'codex 应含 AWKN_LLM_TIMEOUT_MS 和 120000 默认值');
    assert.ok(MINIMAX_SRC.includes('AWKN_LLM_TIMEOUT_MS') && MINIMAX_SRC.includes('120000'),
      'minimax 应含 AWKN_LLM_TIMEOUT_MS 和 120000 默认值');
  });

  it('行为：超时实际触发（hung server + 200ms 超时）', async () => {
    // 起一个接受连接但永不响应的 server
    const server: Server = createServer((_req, _res) => {
      // 永不调 res.end()，模拟 hung API
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const port = addr.port;

    // 设短超时（call-time 读取，M3 进阶-13 重构后支持运行时覆盖）
    process.env.AWKN_LLM_TIMEOUT_MS = '200';
    process.env.AWKN_CODEX_API_KEY = 'test-key';
    process.env.AWKN_CODEX_BASE_URL = `http://127.0.0.1:${port}`;

    const { CodexProvider } = await import('../src/llm/providers/codex.ts');
    const provider = new CodexProvider();

    const start = Date.now();
    let threwTimeout = false;
    try {
      await provider.chat({
        messages: [{ role: 'user', content: 'test' }],
      });
    } catch (e) {
      const msg = String((e as Error).message);
      // 应该是 timeout 错误（含 "timeout"），且耗时约 200ms（不是 120s）
      if (msg.includes('timeout') || msg.includes('abort')) {
        threwTimeout = true;
      }
    }
    const elapsed = Date.now() - start;

    server.close();
    delete process.env.AWKN_LLM_TIMEOUT_MS;
    delete process.env.AWKN_CODEX_API_KEY;
    delete process.env.AWKN_CODEX_BASE_URL;

    assert.ok(threwTimeout, `应抛 timeout 错误（实际消息可能含 timeout/abort）`);
    assert.ok(elapsed < 5000, `超时应快速触发（<5s，实际 ${elapsed}ms），不应等 120s`);
  });
});
