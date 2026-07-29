import { createLogger } from '../core/logger.js';
import type { CompiledMemoryContext } from '../memory/backend.js';
import { getMemoryBackendRouter } from '../memory/router.js';
import { startSpan } from '../observability/trace.js';
import { queryRun } from '../store/db.js';
import type { ChatMessage, ChatRequest, ChatResponse, LlmProvider, LlmProviderInterface } from './types.js';
import { TraeProvider } from './providers/trae.js';
import { CodexProvider } from './providers/codex.js';
import { MiniMaxProvider } from './providers/minimax.js';

const logger = createLogger('LlmRouter');

interface MemoryEnrichment {
  request: ChatRequest;
  userText: string;
  projectId: string;
  sessionId: string;
  context?: CompiledMemoryContext;
}

export class LlmRouter {
  private providers: Map<LlmProvider, LlmProviderInterface> = new Map();

  constructor() {
    this.providers.set('trae', new TraeProvider());
    this.providers.set('codex', new CodexProvider());
    this.providers.set('minimax', new MiniMaxProvider());
  }

  private selectProvider(req: ChatRequest): LlmProviderInterface {
    const explicit = req.provider ?? process.env.AWKN_LLM_PROVIDER as LlmProvider | undefined;
    if (explicit) {
      const selected = this.providers.get(explicit);
      if (selected) return selected;
    }
    const source = req.callSource ?? '';
    if (source === 'compression' || source === 'classifier') return this.providers.get('minimax')!;
    if (source === 'sub_agent' || source === 'background_task') return this.providers.get('codex')!;
    return this.providers.get('trae')!;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const provider = this.selectProvider(req);
    const enriched = await this.enrichWithMemory(req);
    const startedAt = Date.now();
    const span = startSpan({
      traceId: req.traceId,
      name: 'gen_ai.chat',
      kind: 'client',
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': req.model ?? '',
        'gen_ai.provider.requested': provider.name,
        'awkn.call_source': req.callSource ?? 'unknown',
        'awkn.fallback_policy': req.fallbackPolicy ?? 'allow',
        'awkn.memory.injected': enriched.request.messages.length > req.messages.length,
        'awkn.memory.backend': enriched.context?.backend ?? 'none',
        'awkn.memory.stale': enriched.context?.stale ?? false,
        'awkn.memory.receipt_id': enriched.context?.receiptId ?? '',
        'awkn.memory.render_id': enriched.context?.renderId ?? '',
      },
    });

    try {
      const response = await provider.chat(enriched.request);
      const durationMs = Date.now() - startedAt;
      this.recordUsage(response, req.callSource, durationMs);
      await this.rememberResponse(enriched, response, req.traceId);
      span.end('ok', this.responseAttributes(response, durationMs, false));
      return response;
    } catch (err) {
      logger.error(`Provider ${provider.name} failed: ${String(err)}`);
      if (req.fallbackPolicy === 'none') {
        span.end('error', { 'gen_ai.provider.name': provider.name, 'awkn.fallback.used': false }, err);
        throw err;
      }

      const fallbackChain: LlmProvider[] = provider.name === 'trae'
        ? ['codex', 'minimax']
        : provider.name === 'codex'
          ? ['minimax', 'trae']
          : ['trae', 'codex'];

      for (const name of fallbackChain) {
        const fallback = this.providers.get(name);
        if (!fallback) continue;
        try {
          const response = await fallback.chat(enriched.request);
          const durationMs = Date.now() - startedAt;
          this.recordUsage(response, req.callSource, durationMs);
          await this.rememberResponse(enriched, response, req.traceId);
          logger.info(`Fallback to ${name} succeeded`);
          span.end('ok', this.responseAttributes(response, durationMs, true));
          return response;
        } catch (fallbackError) {
          logger.warn(`Fallback ${name} also failed: ${String(fallbackError)}`);
        }
      }

      span.end('error', {
        'gen_ai.provider.name': provider.name,
        'awkn.fallback.used': true,
        'awkn.fallback.exhausted': true,
        'awkn.duration_ms': Date.now() - startedAt,
      }, err);
      throw err;
    }
  }

  private async enrichWithMemory(req: ChatRequest): Promise<MemoryEnrichment> {
    const userText = [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const projectId = process.env.AWKN_PROJECT_ID ?? process.env.npm_package_name ?? 'default-project';
    const sessionId = process.env.AWKN_MEMORY_SESSION_ID ?? projectId;
    if (process.env.AWKN_DISABLE_MEMORY === '1' || req.callSource !== 'main_dialogue' || !userText.trim()) {
      return { request: req, userText, projectId, sessionId };
    }

    try {
      const context = await getMemoryBackendRouter().compileAndRender({
        query: userText,
        projectId,
        sessionId,
        tokenBudget: Number(process.env.AWKN_MEMORY_TOKEN_BUDGET ?? 4000),
        maxItems: Number(process.env.AWKN_MEMORY_MAX_ITEMS ?? 100),
      });
      if (!context.prompt) return { request: req, userText, projectId, sessionId, context };
      const messages: ChatMessage[] = [...req.messages];
      let insertAt = 0;
      while (insertAt < messages.length && messages[insertAt]?.role === 'system') insertAt++;
      messages.splice(insertAt, 0, { role: 'system', content: context.prompt });
      return { request: { ...req, messages }, userText, projectId, sessionId, context };
    } catch (err) {
      logger.warn(`Failed to build memory context: ${String(err)}`);
      return { request: req, userText, projectId, sessionId };
    }
  }

  private async rememberResponse(enrichment: MemoryEnrichment, response: ChatResponse, traceId?: string): Promise<void> {
    if (process.env.AWKN_DISABLE_MEMORY === '1') return;
    if (enrichment.request.callSource !== 'main_dialogue') return;
    if (response.finishReason !== 'stop' || !response.content.trim()) return;
    try {
      const memory = getMemoryBackendRouter();
      await memory.rememberInteraction({
        userText: enrichment.userText,
        assistantText: response.content,
        projectId: enrichment.projectId,
        sessionId: enrichment.sessionId,
        traceId,
      });
      await memory.finalizeContext({
        context: enrichment.context,
        projectId: enrichment.projectId,
        sessionId: enrichment.sessionId,
        responseText: response.content,
        outcome: 'SUCCESS',
      });
    } catch (err) {
      logger.warn(`Failed to persist or finalize memory: ${String(err)}`);
    }
  }

  private responseAttributes(response: ChatResponse, durationMs: number, fallbackUsed: boolean): Record<string, unknown> {
    return {
      'gen_ai.provider.name': response.provider,
      'gen_ai.response.model': response.model,
      'gen_ai.usage.input_tokens': response.usage.promptTokens,
      'gen_ai.usage.output_tokens': response.usage.completionTokens,
      'gen_ai.usage.total_tokens': response.usage.totalTokens,
      'gen_ai.response.finish_reasons': response.finishReason,
      'awkn.fallback.used': fallbackUsed,
      'awkn.duration_ms': durationMs,
    };
  }

  private recordUsage(response: ChatResponse, callSource: string | undefined, durationMs: number): void {
    try {
      queryRun(
        `INSERT INTO usage
         (provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, call_source, ts)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [response.provider, response.model, response.usage.promptTokens, response.usage.completionTokens, response.usage.totalTokens, callSource ?? null, new Date().toISOString()],
      );
      void durationMs;
    } catch (err) {
      logger.warn(`Failed to record usage: ${String(err)}`);
    }
  }

  async isAvailable(provider: LlmProvider): Promise<boolean> {
    return this.providers.get(provider)?.isAvailable() ?? false;
  }
}

let instance: LlmRouter | null = null;
export function getLlmRouter(): LlmRouter {
  if (!instance) instance = new LlmRouter();
  return instance;
}
