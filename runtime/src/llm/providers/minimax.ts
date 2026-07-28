import type { ChatRequest, ChatResponse, LlmProviderInterface } from '../types.js';
import { encodeOpenAiMessages } from '../protocol.js';

function getLlmTimeoutMs(): number {
  return Number(process.env.AWKN_LLM_TIMEOUT_MS) || 120000;
}

export class MiniMaxProvider implements LlmProviderInterface {
  name = 'minimax' as const;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = process.env.AWKN_MINIMAX_API_KEY;
    if (!apiKey) throw new Error('AWKN_MINIMAX_API_KEY is not set');
    const model = req.model ?? process.env.AWKN_MINIMAX_MODEL ?? 'MiniMax-M2.5';
    const baseUrl = process.env.AWKN_MINIMAX_BASE_URL ?? 'https://api.minimaxi.chat/v1';

    const body: Record<string, unknown> = {
      model,
      messages: encodeOpenAiMessages(req.messages),
      temperature: req.temperature ?? 0.7,
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.tools && req.tools.length > 0) {
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
      if (controller.signal.aborted) throw new Error(`MiniMax API timeout after ${getLlmTimeoutMs()}ms`);
      throw new Error(`MiniMax API fetch failed: ${String(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) throw new Error(`MiniMax API ${resp.status}: ${await resp.text()}`);

    const data = (await resp.json()) as {
      choices?: Array<{
        message: { content: string | null; tool_calls?: ChatResponse['toolCalls'] };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error('MiniMax API returned no choices');
    if (!data.usage) throw new Error('MiniMax API returned no usage field');
    if (!choice.message.content && !choice.message.tool_calls?.length) {
      throw new Error(`MiniMax API returned empty content with no tool_calls (finish_reason: ${choice.finish_reason})`);
    }

    return {
      content: choice.message.content ?? '',
      toolCalls: choice.message.tool_calls,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      provider: 'minimax',
      model,
      finishReason: choice.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice.finish_reason === 'length'
          ? 'length'
          : choice.finish_reason === 'content_filter'
            ? 'content_filter'
            : 'stop',
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env.AWKN_MINIMAX_API_KEY;
  }
}
