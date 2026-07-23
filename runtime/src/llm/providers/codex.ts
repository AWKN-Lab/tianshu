/**
 * CODEX LLM provider（OpenAI 兼容协议）
 *
 * CODEX 一般是 OpenAI 兼容 API，通过环境变量配置：
 * - AWKN_CODEX_API_KEY: API key
 * - AWKN_CODEX_BASE_URL: base URL（默认 https://api.openai.com/v1）
 * - AWKN_CODEX_MODEL: 默认模型
 */

import { createLogger } from '../../core/logger.js';
import type { ChatRequest, ChatResponse, LlmProviderInterface } from '../types.js';

const logger = createLogger('CodexProvider');
void logger;

const CODEX_DEFAULT_MODEL = process.env.AWKN_CODEX_MODEL ?? 'gpt-4o';
const CODEX_BASE_URL = process.env.AWKN_CODEX_BASE_URL ?? 'https://api.openai.com/v1';
// M3 进阶-13（2026-07-23）：LLM 网络调用超时，防止挂起致循环无法终止
// 原版：fetch 无 timeout，API 挂起 → 循环永久阻塞 → budgetGate/terminated 都无法触发（token 未计数）
// 注意：call-time 读取（非 module-level），允许运行时覆盖（测试 + 热配置）
function getLlmTimeoutMs(): number {
  return Number(process.env.AWKN_LLM_TIMEOUT_MS) || 120000;
}

export class CodexProvider implements LlmProviderInterface {
  name = 'codex' as const;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = process.env.AWKN_CODEX_API_KEY;
    if (!apiKey) {
      throw new Error('AWKN_CODEX_API_KEY is not set');
    }

    const body: Record<string, unknown> = {
      model: req.model ?? CODEX_DEFAULT_MODEL,
      messages: req.messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? 0.7,
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }

    // M3 进阶-13：AbortController 超时，防止网络挂起
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), getLlmTimeoutMs());
    let resp: Response;
    try {
      resp = await fetch(`${CODEX_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Codex API timeout after ${getLlmTimeoutMs()}ms`);
      }
      throw new Error(`Codex API fetch failed: ${String(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Codex API ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    // M3 进阶-13：防御性检查 — 空 choices / 缺 usage 应 throw（而非 TypeError 崩溃）
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`Codex API returned no choices (finish_reason may be content_filter)`);
    }
    if (!data.usage) {
      throw new Error(`Codex API returned no usage field`);
    }
    // M3 进阶-30（2026-07-23）：E96 变体 — 空 content + 无 tool_calls 时 fail-closed
    //   与 M3 进阶-19（trae.ts hook 路径空 content）同类，但不同代码路径（直接 API 调用）
    //   场景：content_filter 返回 null content / API 限流 200 空体 / API bug
    //   原版：content: choice.message.content ?? '' → 空字符串 → agent-loop break → 假成功
    //   修复：无 content 且无 tool_calls → throw（fail-closed），让 fallback 链或 3-strike 处理
    if (!choice.message.content && !choice.message.tool_calls?.length) {
      throw new Error(
        `Codex API returned empty content with no tool_calls (finish_reason: ${choice.finish_reason})`,
      );
    }
    return {
      content: choice.message.content ?? '',
      toolCalls: choice.message.tool_calls,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      provider: 'codex',
      model: req.model ?? CODEX_DEFAULT_MODEL,
      finishReason: (choice.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice.finish_reason === 'length'
          ? 'length'
          : choice.finish_reason === 'content_filter'
            ? 'content_filter'
            : 'stop') as ChatResponse['finishReason'],
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env.AWKN_CODEX_API_KEY;
  }
}
