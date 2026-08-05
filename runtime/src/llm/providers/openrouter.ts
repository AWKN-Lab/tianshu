import type { ChatRequest, ChatResponse, LlmProviderInterface } from '../types.js';
import { encodeOpenAiMessages } from '../protocol.js';

function getLlmTimeoutMs(): number {
  return Number(process.env.AWKN_LLM_TIMEOUT_MS) || 120000;
}

export class OpenRouterProvider implements LlmProviderInterface {
  name = 'openrouter' as const;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = process.env.AWKN_OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('AWKN_OPENROUTER_API_KEY is not set');
    const model = req.model ?? process.env.AWKN_OPENROUTER_MODEL ?? 'openrouter/free';
    const baseUrl = process.env.AWKN_OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.AWKN_OPENROUTER_SITE_URL ?? 'https://awkn.cn',
          'X-Title': process.env.AWKN_OPENROUTER_APP_NAME ?? 'AWKN Engine',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`OpenRouter API timeout after ${getLlmTimeoutMs()}ms`);
      throw new Error(`OpenRouter API fetch failed: ${String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) throw new Error(`OpenRouter API ${resp.status}: ${await resp.text()}`);

    const data = (await resp.json()) as {
      choices?: Array<{ message: { content: string | null; tool_calls?: ChatResponse['toolCalls'] }; finish_reason: string }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error('OpenRouter API returned no choices');
    if (!choice.message.content && !choice.message.tool_calls?.length) {
      throw new Error(`OpenRouter API returned empty content with no tool_calls (finish_reason: ${choice.finish_reason})`);
    }
    const usage = data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return {
      content: choice.message.content ?? '',
      toolCalls: choice.message.tool_calls,
      usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
      provider: 'openrouter',
      model,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls'
        : choice.finish_reason === 'length' ? 'length'
          : choice.finish_reason === 'content_filter' ? 'content_filter' : 'stop',
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env.AWKN_OPENROUTER_API_KEY;
  }
}
