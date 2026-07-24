import { createLogger } from '../core/logger.js';
import { queryRun } from '../store/db.js';
import type { ChatRequest, ChatResponse, LlmProvider, LlmProviderInterface } from './types.js';
import { TraeProvider } from './providers/trae.js';
import { CodexProvider } from './providers/codex.js';
import { MiniMaxProvider } from './providers/minimax.js';

const logger = createLogger('LlmRouter');
const ENV_PROVIDER = process.env.AWKN_LLM_PROVIDER as LlmProvider | undefined;

export class LlmRouter {
  private providers: Map<LlmProvider, LlmProviderInterface> = new Map();

  constructor() {
    this.providers.set('trae', new TraeProvider());
    this.providers.set('codex', new CodexProvider());
    this.providers.set('minimax', new MiniMaxProvider());
  }

  private selectProvider(req: ChatRequest): LlmProviderInterface {
    const explicit = req.provider ?? ENV_PROVIDER;
    if (explicit) {
      const selected = this.providers.get(explicit);
      if (selected) return selected;
    }

    const source = req.callSource ?? '';
    if (source === 'compression' || source === 'classifier') {
      return this.providers.get('minimax')!;
    }
    if (source === 'sub_agent' || source === 'background_task') {
      return this.providers.get('codex')!;
    }
    return this.providers.get('trae')!;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const provider = this.selectProvider(req);
    const startedAt = Date.now();

    try {
      const response = await provider.chat(req);
      this.recordUsage(response, req.callSource, Date.now() - startedAt);
      return response;
    } catch (err) {
      logger.error(`Provider ${provider.name} failed: ${String(err)}`);
      if (req.fallbackPolicy === 'none') throw err;

      const fallbackChain: LlmProvider[] = provider.name === 'trae'
        ? ['codex', 'minimax']
        : provider.name === 'codex'
          ? ['minimax', 'trae']
          : ['trae', 'codex'];

      for (const name of fallbackChain) {
        const fallback = this.providers.get(name);
        if (!fallback) continue;
        try {
          const response = await fallback.chat(req);
          this.recordUsage(response, req.callSource, Date.now() - startedAt);
          logger.info(`Fallback to ${name} succeeded`);
          return response;
        } catch (fallbackError) {
          logger.warn(`Fallback ${name} also failed: ${String(fallbackError)}`);
        }
      }
      throw err;
    }
  }

  private recordUsage(response: ChatResponse, callSource: string | undefined, durationMs: number): void {
    try {
      queryRun(
        `INSERT INTO usage
         (provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, call_source, ts)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          response.provider,
          response.model,
          response.usage.promptTokens,
          response.usage.completionTokens,
          response.usage.totalTokens,
          callSource ?? null,
          new Date().toISOString(),
        ],
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
