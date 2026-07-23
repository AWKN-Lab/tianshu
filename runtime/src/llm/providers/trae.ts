/**
 * TRAE 自带 LLM provider — 通过 hooks 桥接 + 文件协议调用 TRAE 宿主 LLM
 *
 * 实现策略（按优先级）：
 * 1. 触发 pre_llm_call hook → 如果 hook 回填 llmResponse，直接返回
 * 2. fallback 文件协议桥接：写 req-{id}.json → 轮询 resp-{id}.json（120s timeout）
 * 3. 仍失败 → throw error（让 router 触发 fallback 链 trae→codex→minimax）
 *
 * 文件协议桥接目录：AWKN_LLM_BRIDGE_DIR 环境变量，默认 <cwd>/runtime/data/llm-bridge
 * TRAE 宿主端通过 awkn-llm-bridge skill 处理 req 文件，写回 resp 文件
 */

import { createLogger } from '../../core/logger.js';
import { hookManager } from '../../core/hook-manager.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatRequest, ChatResponse, LlmProviderInterface } from '../types.js';

const logger = createLogger('TraeProvider');

const TRAE_DEFAULT_MODEL = process.env.AWKN_TRAE_MODEL ?? 'trae-default';
const BRIDGE_DIR = process.env.AWKN_LLM_BRIDGE_DIR
  ?? resolve(process.cwd(), 'runtime', 'data', 'llm-bridge');
const BRIDGE_POLL_INTERVAL_MS = 2000;
const BRIDGE_TIMEOUT_MS = 120000;

export class TraeProvider implements LlmProviderInterface {
  name = 'trae' as const;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // 1. 触发 pre_llm_call hook（如果注册了桥接 hook，直接返回 llmResponse）
    try {
      const results = await hookManager.trigger('pre_llm_call', {
        point: 'pre_llm_call',
        llmRequest: {
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          model: req.model ?? TRAE_DEFAULT_MODEL,
          provider: 'trae',
        },
      });

      for (const r of results) {
        if (r.success && r.llmResponse) {
          // M3 进阶-19（2026-07-23）：fail-closed 校验 — hook 返回空 content 不能当成功
          //   原版：只要 r.success && r.llmResponse 就返回，不检查 content 是否为空
          //   问题：hook 实现有 bug 返回 { success: true, llmResponse: { content: '' } } 时
          //         → trae 不 throw → router 不 fallback → agent-loop 收到空 content
          //         → 3-strike 不触发（没抛错）→ 循环空转 → budgetGate 不触发（token=0）
          //         → 与历史 trae.ts stub bug 同类："无信号被当作成功"
          //         → 违反 E94 候选铁律"安全接口 fail-closed 原则"
          //   修复：content 为空/纯空白时跳过该 hook，继续走文件桥接 + fallback 链
          const content = r.llmResponse.content ?? '';
          if (content.trim() === '') {
            logger.warn('pre_llm_call hook returned empty llmResponse.content — skipping (fail-closed)');
            continue;
          }
          logger.debug('pre_llm_call hook returned llmResponse');
          return {
            content,
            usage: r.llmResponse.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            provider: 'trae',
            model: req.model ?? TRAE_DEFAULT_MODEL,
            finishReason: 'stop',
          };
        }
      }
    } catch (err) {
      logger.warn(`pre_llm_call hook failed: ${String(err)}`);
    }

    // 2. fallback 文件协议桥接
    const bridgeResult = await this.fileBridge(req);
    if (bridgeResult) return bridgeResult;

    // 3. 仍失败 → throw error（让 router 触发 fallback 链 trae→codex→minimax）
    // 修复（2026-07-23）：原版返回 stub 兜底（finishReason='stop'），导致：
    //   - router 以为 trae 成功，不 fallback 到 codex/minimax
    //   - 调用方收到 stub content，以为 LLM 真响应
    //   - 停止条件评估器被误导（verificationGate 把 stub 当 fresh evidence）
    //   违反"循环里必须有说不的"铁律
    logger.warn('All bridge methods failed, throwing error for fallback chain');
    throw new Error('trae provider: bridge unavailable — no hook response and file bridge timeout');
  }

  /**
   * 文件协议桥接：写 req-{id}.json → 轮询 resp-{id}.json
   * TRAE 宿主端的 awkn-llm-bridge skill 读取 req 文件，处理，写回 resp 文件
   *
   * M3 进阶-20（2026-07-23）：修复资源泄漏
   *   原版：JSON.parse 失败时只删 respPath（reqPath 残留）；timeout 时只删 reqPath
   *         （若 resp 在 timeout 瞬间被写入会泄漏）
   *   修复：引入 cleanupBridge() 统一清理 req+resp，所有出口都调用
   */
  private async fileBridge(req: ChatRequest): Promise<ChatResponse | null> {
    const id = randomUUID();
    try {
      mkdirSync(BRIDGE_DIR, { recursive: true });
    } catch {
      // 目录已存在或创建失败，忽略
    }

    const reqPath = resolve(BRIDGE_DIR, `req-${id}.json`);
    const respPath = resolve(BRIDGE_DIR, `resp-${id}.json`);

    /** 统一清理 req + resp 文件（幂等，不存在不报错） */
    const cleanupBridge = (): void => {
      try { unlinkSync(reqPath); } catch { /* ignore */ }
      try { unlinkSync(respPath); } catch { /* ignore */ }
    };

    // 写请求文件
    try {
      writeFileSync(
        reqPath,
        JSON.stringify({
          id,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          model: req.model ?? TRAE_DEFAULT_MODEL,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      logger.error(`Failed to write bridge request: ${String(err)}`);
      cleanupBridge();
      return null;
    }

    logger.info(`Bridge request written: ${reqPath}, waiting for response (timeout ${BRIDGE_TIMEOUT_MS}ms)`);

    // 轮询等响应
    const maxPolls = BRIDGE_TIMEOUT_MS / BRIDGE_POLL_INTERVAL_MS;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, BRIDGE_POLL_INTERVAL_MS));
      if (existsSync(respPath)) {
        try {
          const resp = JSON.parse(readFileSync(respPath, 'utf-8')) as {
            content: string;
            usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
          };
          cleanupBridge();
          logger.info(`Bridge response received for ${id}`);
          return {
            content: resp.content,
            usage: resp.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            provider: 'trae',
            model: req.model ?? TRAE_DEFAULT_MODEL,
            finishReason: 'stop',
          };
        } catch (err) {
          // 防御性修复：尝试修复常见的换行符问题（content 含字面换行导致 JSON.parse 失败）
          try {
            const raw = readFileSync(respPath, 'utf-8');
            const fixed = raw.replace(/"content"\s*:\s*"([\s\S]*?)"/g, (_match, content) => {
              const escaped = content.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
              return `"content":"${escaped}"`;
            });
            const resp = JSON.parse(fixed) as {
              content: string;
              usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
            };
            cleanupBridge();
            logger.info(`Bridge response received for ${id} (after newline fix)`);
            return {
              content: resp.content,
              usage: resp.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              provider: 'trae',
              model: req.model ?? TRAE_DEFAULT_MODEL,
              finishReason: 'stop',
            };
          } catch {
            logger.error(`Failed to parse bridge response (even after fix): ${String(err)}`);
            cleanupBridge();
            return null;
          }
        }
      }
    }

    // timeout
    logger.warn(`Bridge timeout for ${id} after ${BRIDGE_TIMEOUT_MS}ms`);
    cleanupBridge();
    return null;
  }

  async isAvailable(): Promise<boolean> {
    // TRAE 宿主总是可用（runtime 设计为在 TRAE 内运行）
    return true;
  }
}
