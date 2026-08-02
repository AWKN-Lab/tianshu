/**
 * LlmRouter 指标埋点测试：chat 成功/fallback/错误三类路径写入 MetricRegistry。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LlmRouter } from '../src/llm/router.js';
import { getMetricRegistry } from '../src/observability/metrics.js';
import type { ChatRequest, ChatResponse, LlmProvider, LlmProviderInterface } from '../src/llm/types.js';

class FakeProvider implements LlmProviderInterface {
  constructor(
    readonly name: LlmProvider,
    private readonly behavior: 'ok' | 'throw',
    private readonly model = 'fake-model',
  ) {}

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    if (this.behavior === 'throw') throw new Error('fake failure');
    return {
      content: 'fake response',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      provider: this.name,
      model: this.model,
      finishReason: 'stop',
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function baseRequest(): ChatRequest {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    callSource: 'test_metrics',
  };
}

describe('LlmRouter metrics instrumentation', () => {
  beforeEach(() => {
    process.env.AWKN_DISABLE_MEMORY = '1';
  });

  it('records duration and tokens on successful chat', async () => {
    const router = new LlmRouter([['trae', new FakeProvider('trae')]]);
    await router.chat(baseRequest());
    const registry = getMetricRegistry();
    const duration = registry.get('llm.chat.duration_ms', { provider: 'trae', model: 'fake-model', call_source: 'test_metrics', fallback: 'false' });
    assert.ok(duration !== null && duration >= 0, 'duration metric recorded');
    const tokens = registry.get('llm.chat.tokens', { provider: 'trae', model: 'fake-model', call_source: 'test_metrics' });
    assert.equal(tokens, 15);
  });

  it('marks fallback=true when primary fails and fallback succeeds', async () => {
    const router = new LlmRouter([
      ['trae', new FakeProvider('trae', 'throw')],
      ['codex', new FakeProvider('codex')],
    ]);
    const response = await router.chat(baseRequest());
    assert.equal(response.provider, 'codex');
    const registry = getMetricRegistry();
    const duration = registry.get('llm.chat.duration_ms', { provider: 'codex', model: 'fake-model', call_source: 'test_metrics', fallback: 'true' });
    assert.ok(duration !== null && duration >= 0, 'fallback duration metric recorded');
    const error = registry.get('llm.chat.error', { provider: 'trae', call_source: 'test_metrics' });
    assert.equal(error, 1, 'primary failure recorded as error metric');
  });

  it('records error metric for each failed provider in the chain', async () => {
    const router = new LlmRouter([
      ['trae', new FakeProvider('trae', 'throw')],
      ['codex', new FakeProvider('codex', 'throw')],
      ['minimax', new FakeProvider('minimax', 'throw')],
    ]);
    await assert.rejects(() => router.chat({ ...baseRequest(), callSource: 'test_chain' }));
    const registry = getMetricRegistry();
    for (const provider of ['trae', 'codex', 'minimax'] as LlmProvider[]) {
      assert.equal(registry.get('llm.chat.error', { provider, call_source: 'test_chain' }), 1, `${provider} error metric recorded`);
    }
  });

  it('respects fallbackPolicy=none without hitting fallbacks', async () => {
    const router = new LlmRouter([
      ['trae', new FakeProvider('trae', 'throw')],
      ['codex', new FakeProvider('codex')],
    ]);
    await assert.rejects(() => router.chat({ ...baseRequest(), callSource: 'test_policy_none', fallbackPolicy: 'none' }));
    const registry = getMetricRegistry();
    assert.equal(registry.get('llm.chat.error', { provider: 'trae', call_source: 'test_policy_none' }), 1);
    assert.equal(registry.get('llm.chat.error', { provider: 'codex', call_source: 'test_policy_none' }), null, 'fallback untouched');
  });
});
