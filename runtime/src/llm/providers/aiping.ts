import type { ChatRequest, ChatResponse, LlmProviderInterface } from '../types.js';
import { encodeOpenAiMessages } from '../protocol.js';

function getLlmTimeoutMs(): number {
  return Number(process.env.AWKN_LLM_TIMEOUT_MS) || 120000;
}

export class AipingProvider implements LlmProviderInterface {
  name = 'aiping' as const;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = process.env.AWKN_AIPING_API_KEY;
    if (!apiKey) throw new Error('AWKN_AIPING_API_KEY is not set');
    const model = req.model ?? process.env.AWKN_AIPING_MODEL ?? 'Kimi-K3';
    const baseUrl = process.env.AWKN_AIPING_BASE_URL ?? 'https://aiping.cn/api/v1';
    const body: Record<string, unknown> = {
      model,
      messages: encodeOpenAiMessages(req.messages),
      temperature: req.temperature ?? 0.7,
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), getLlmTimeoutMs());
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`aiping API timeout after ${getLlmTimeoutMs()}ms`);
      throw new Error(`aiping API fetch failed: ${String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) throw new Error(`aiping API ${resp.status}: ${await resp.text()}`);

    const data = (await resp.json()) as {
      choices?: Array<{ message: { content: string | null; tool_calls?: ChatResponse['toolCalls'] }; finish_reason: string }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error('aiping API returned no choices');
    if (!choice.message.content && !choice.message.tool_calls?.length) {
      throw new Error(`aiping API returned empty content with no tool_calls (finish_reason: ${choice.finish_reason})`);
    }
    const usage = data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return {
      content: choice.message.content ?? '',
      toolCalls: choice.message.tool_calls,
      usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
      provider: 'aiping',
      model,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls'
        : choice.finish_reason === 'length' ? 'length'
          : choice.finish_reason === 'content_filter' ? 'content_filter' : 'stop',
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env.AWKN_AIPING_API_KEY;
  }
}
