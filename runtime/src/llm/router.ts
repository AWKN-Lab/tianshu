/**
 * LLM provider 路由
 *
 * 路由顺序：
 * 1. 显式指定（req.provider 或 AWKN_LLM_PROVIDER 环境变量）
 * 2. 按任务类型路由（code → TRAE/CODEX；text/speech/video/music → MiniMax）
 * 3. 默认 TRAE 自带
 *
 * 跨模型 review 场景：调用方在 req.provider 显式指定不同 provider
 * （避免同模型互认同，例如天火用 trae，cicd-tester 用 codex/minimax）
 */

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

  /** 选择 provider */
  private selectProvider(req: ChatRequest): LlmProviderInterface {
    // 1. 显式指定
    const explicit = req.provider ?? ENV_PROVIDER;
    if (explicit) {
      const p = this.providers.get(explicit);
      if (p) return p;
    }

    // 2. 按任务类型路由（callSource 启发式）
    const cs = req.callSource ?? '';
    if (cs === 'compression' || cs === 'classifier') {
      // 压缩/分类用 MiniMax highspeed
      const p = this.providers.get('minimax');
      if (p) return p;
    }
    if (cs === 'sub_agent' || cs === 'background_task') {
      // 子 agent / 后台任务用 CODEX（跨模型避免互认同）
      const p = this.providers.get('codex');
      if (p) return p;
    }

    // 3. 默认 TRAE
    return this.providers.get('trae')!;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const provider = this.selectProvider(req);
    const startedAt = Date.now();

    try {
      const resp = await provider.chat(req);

      // 记录用量到 SQLite
      this.recordUsage({
        provider: resp.provider,
        model: resp.model,
        promptTokens: resp.usage.promptTokens,
        completionTokens: resp.usage.completionTokens,
        totalTokens: resp.usage.totalTokens,
        callSource: req.callSource,
        durationMs: Date.now() - startedAt,
      });

      return resp;
    } catch (err) {
      logger.error(`Provider ${provider.name} failed: ${String(err)}`);

      // Fallback 链：trae → codex → minimax
      const fallbackChain: LlmProvider[] =
        provider.name === 'trae'
          ? ['codex', 'minimax']
          : provider.name === 'codex'
            ? ['minimax', 'trae']
            : ['trae', 'codex'];

      for (const fb of fallbackChain) {
        const fbProvider = this.providers.get(fb);
        if (!fbProvider) continue;
        try {
          const fbResp = await fbProvider.chat(req);
          this.recordUsage({
            provider: fbResp.provider,
            model: fbResp.model,
            promptTokens: fbResp.usage.promptTokens,
            completionTokens: fbResp.usage.completionTokens,
            totalTokens: fbResp.usage.totalTokens,
            callSource: req.callSource,
            durationMs: Date.now() - startedAt,
          });
          logger.info(`Fallback to ${fb} succeeded`);
          return fbResp;
        } catch (fbErr) {
          logger.warn(`Fallback ${fb} also failed: ${String(fbErr)}`);
        }
      }

      throw err;
    }
  }

  private recordUsage(args: {
    provider: LlmProvider;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    callSource?: string;
    durationMs: number;
  }): void {
    try {
      queryRun(
        `INSERT INTO usage (provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, call_source, ts)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          args.provider,
          args.model,
          args.promptTokens,
          args.completionTokens,
          args.totalTokens,
          args.callSource ?? null,
          new Date().toISOString(),
        ],
      );
    } catch (err) {
      logger.warn(`Failed to record usage: ${String(err)}`);
    }
  }

  /** 检查某 provider 是否可用 */
  async isAvailable(provider: LlmProvider): Promise<boolean> {
    const p = this.providers.get(provider);
    if (!p) return false;
    return p.isAvailable();
  }
}

let instance: LlmRouter | null = null;

export function getLlmRouter(): LlmRouter {
  if (!instance) instance = new LlmRouter();
  return instance;
}
