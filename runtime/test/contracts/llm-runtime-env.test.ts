import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LlmRouter } from '../../src/llm/router.js';
import { CodexProvider } from '../../src/llm/providers/codex.js';
import { MiniMaxProvider } from '../../src/llm/providers/minimax.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AWKN_LLM_PROVIDER;
  delete process.env.AWKN_CODEX_API_KEY;
  delete process.env.AWKN_CODEX_BASE_URL;
  delete process.env.AWKN_CODEX_MODEL;
  delete process.env.AWKN_MINIMAX_API_KEY;
  delete process.env.AWKN_MINIMAX_BASE_URL;
  delete process.env.AWKN_MINIMAX_MODEL;
});

describe('LLM runtime environment', () => {
  it('selects a provider configured after module evaluation', () => {
    const router = new LlmRouter();
    process.env.AWKN_LLM_PROVIDER = 'codex';
    const selected = (router as unknown as {
      selectProvider(request: { messages: [] }): { name: string };
    }).selectProvider({ messages: [] });
    assert.equal(selected.name, 'codex');
  });

  it('uses provider base URLs and models configured after module evaluation', async () => {
    const calls: Array<{ url: string; model: string }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), model: JSON.parse(String(init?.body)).model as string });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    process.env.AWKN_CODEX_API_KEY = 'test-key';
    process.env.AWKN_CODEX_BASE_URL = 'https://deepseek.example/v1';
    process.env.AWKN_CODEX_MODEL = 'deepseek-test';
    const codex = await new CodexProvider().chat({ messages: [] });

    process.env.AWKN_MINIMAX_API_KEY = 'test-key';
    process.env.AWKN_MINIMAX_BASE_URL = 'https://minimax.example/v1';
    process.env.AWKN_MINIMAX_MODEL = 'minimax-test';
    const minimax = await new MiniMaxProvider().chat({ messages: [] });

    assert.deepEqual(calls, [
      { url: 'https://deepseek.example/v1/chat/completions', model: 'deepseek-test' },
      { url: 'https://minimax.example/v1/chat/completions', model: 'minimax-test' },
    ]);
    assert.equal(codex.model, 'deepseek-test');
    assert.equal(minimax.model, 'minimax-test');
  });
});
