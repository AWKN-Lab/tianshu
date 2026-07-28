import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../../core/logger.js';
import { hookManager } from '../../core/hook-manager.js';
import { buildBridgeRequest } from '../protocol.js';
import type { ChatRequest, ChatResponse, LlmProviderInterface } from '../types.js';

const logger = createLogger('TraeProvider');
const TRAE_DEFAULT_MODEL = process.env.AWKN_TRAE_MODEL ?? 'trae-default';
const BRIDGE_DIR = process.env.AWKN_LLM_BRIDGE_DIR ?? resolve(process.cwd(), 'runtime', 'data', 'llm-bridge');
const BRIDGE_POLL_INTERVAL_MS = 2000;
const BRIDGE_TIMEOUT_MS = 120000;

interface BridgeResponse {
  content?: string | null;
  toolCalls?: ChatResponse['toolCalls'];
  tool_calls?: ChatResponse['toolCalls'];
  usage?: ChatResponse['usage'];
  finishReason?: ChatResponse['finishReason'];
  finish_reason?: string;
}

export class TraeProvider implements LlmProviderInterface {
  name = 'trae' as const;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      const results = await hookManager.trigger('pre_llm_call', {
        point: 'pre_llm_call',
        llmRequest: buildBridgeRequest('hook', req, req.model ?? TRAE_DEFAULT_MODEL),
      });
      for (const result of results) {
        if (!result.success || !result.llmResponse) continue;
        const content = result.llmResponse.content ?? '';
        const toolCalls = result.llmResponse.toolCalls;
        // M3 进阶-19: fail-closed — empty llmResponse.content (skip, don't treat as success)
        if (content.trim() === '' && !toolCalls?.length) continue;
        return {
          content,
          toolCalls,
          usage: result.llmResponse.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          provider: 'trae',
          model: req.model ?? TRAE_DEFAULT_MODEL,
          finishReason: result.llmResponse.finishReason ?? (toolCalls?.length ? 'tool_calls' : 'stop'),
        };
      }
    } catch (err) {
      logger.warn(`pre_llm_call hook failed: ${String(err)}`);
    }

    const bridgeResult = await this.fileBridge(req);
    if (bridgeResult) return bridgeResult;
    throw new Error('trae provider: bridge unavailable — no hook response and file bridge timeout');
  }

  private async fileBridge(req: ChatRequest): Promise<ChatResponse | null> {
    const id = randomUUID();
    mkdirSync(BRIDGE_DIR, { recursive: true });
    const reqPath = resolve(BRIDGE_DIR, `req-${id}.json`);
    const respPath = resolve(BRIDGE_DIR, `resp-${id}.json`);
    // M3 进阶-20: cleanupBridge 统一清理 req+resp，所有出口调用
    const cleanupBridge = (): void => {
      try { unlinkSync(reqPath); } catch { /* noop */ }
      try { unlinkSync(respPath); } catch { /* noop */ }
    };

    try {
      try {
        writeFileSync(reqPath, JSON.stringify(buildBridgeRequest(id, req, req.model ?? TRAE_DEFAULT_MODEL)), 'utf-8');
      } catch (err) {
        cleanupBridge();
        logger.error(`Failed to write bridge request: ${String(err)}`);
        return null;
      }

      const maxPolls = BRIDGE_TIMEOUT_MS / BRIDGE_POLL_INTERVAL_MS;
      for (let i = 0; i < maxPolls; i++) {
        await new Promise((resolvePoll) => setTimeout(resolvePoll, BRIDGE_POLL_INTERVAL_MS));
        if (!existsSync(respPath)) continue;
        try {
          const parsed = JSON.parse(readFileSync(respPath, 'utf-8')) as BridgeResponse;
          const toolCalls = parsed.toolCalls ?? parsed.tool_calls;
          const content = parsed.content ?? '';
          if (!content.trim() && !toolCalls?.length) throw new Error('bridge response has empty content and no tool calls');
          cleanupBridge();
          return {
            content,
            toolCalls,
            usage: parsed.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            provider: 'trae',
            model: req.model ?? TRAE_DEFAULT_MODEL,
            finishReason: parsed.finishReason ?? (parsed.finish_reason === 'tool_calls' || toolCalls?.length ? 'tool_calls' : 'stop'),
          };
        } catch (err) {
          logger.error(`Failed to parse bridge response: ${String(err)}`);
          cleanupBridge();
          return null;
        }
      }

      cleanupBridge();
      return null;
    } finally {
      cleanupBridge();
    }
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
