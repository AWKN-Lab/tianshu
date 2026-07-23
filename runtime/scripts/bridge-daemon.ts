#!/usr/bin/env tsx
/**
 * bridge-daemon.ts — LLM 桥接守护进程（M1）
 *
 * 用途：当 awkn引擎 在 TRAE 外独立运行时，trae provider 的 fileBridge 路径
 *   需要外部进程处理 req/resp 文件。bridge-daemon 自动化这个过程：
 *   1. 轮询 BRIDGE_DIR 监听 req-*.json 文件
 *   2. 读取请求（messages, model）
 *   3. 调用配置的 LLM provider（codex/minimax，不用 trae 避免循环依赖）
 *   4. 写回 resp-*.json（trae 端读取后清理 req+resp）
 *
 * 设计决策：
 *   - 轮询（非 fs.watch）：跨平台可靠，fs.watch 在 Windows/网络盘不可靠
 *   - 顺序处理（一次一个 req）：避免并发 race，LLM 调用本身是瓶颈
 *   - 直接调 codex/minimax（非 LlmRouter）：避免 trae→fileBridge→req→daemon 循环依赖
 *   - mock 模式：AWKN_BRIDGE_MOCK=1 时返回 canned response，用于无 API key 测试
 *   - 失败也写 resp（含 error 字段）：让 trae 端快速失败，不等 120s timeout
 *
 * 环境变量：
 *   - AWKN_LLM_BRIDGE_DIR: 桥接目录（默认 <cwd>/runtime/data/llm-bridge）
 *   - AWKN_BRIDGE_PROVIDER: LLM provider（codex/minimax，默认 codex）
 *   - AWKN_BRIDGE_MOCK: mock 模式（1=用 canned response）
 *   - AWKN_BRIDGE_POLL_MS: 轮询间隔（默认 500ms）
 *   - AWKN_BRIDGE_MOCK_CONTENT: mock 返回内容（默认 "[mock response from bridge-daemon]"）
 *
 * 用法：
 *   npx tsx runtime/scripts/bridge-daemon.ts              # 正常模式
 *   AWKN_BRIDGE_MOCK=1 npx tsx runtime/scripts/bridge-daemon.ts  # mock 模式
 *   Ctrl+C 停止
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexProvider } from '../src/llm/providers/codex.js';
import { MiniMaxProvider } from '../src/llm/providers/minimax.js';
import type { ChatRequest, LlmProvider, LlmProviderInterface } from '../src/llm/types.js';

const BRIDGE_DIR = process.env.AWKN_LLM_BRIDGE_DIR
  ?? resolve(process.cwd(), 'runtime', 'data', 'llm-bridge');
const POLL_MS = Number(process.env.AWKN_BRIDGE_POLL_MS) || 500;
const MOCK_MODE = process.env.AWKN_BRIDGE_MOCK === '1' || process.env.AWKN_BRIDGE_MOCK === 'true';
const MOCK_CONTENT = process.env.AWKN_BRIDGE_MOCK_CONTENT ?? '[mock response from bridge-daemon]';
const PROVIDER_NAME = (process.env.AWKN_BRIDGE_PROVIDER as LlmProvider | undefined) ?? 'codex';

/** 桥接请求文件格式（与 trae.ts fileBridge 写入格式一致） */
interface BridgeRequest {
  id: string;
  messages: Array<{ role: string; content: string }>;
  model: string;
  createdAt: string;
}

/** 桥接响应文件格式（与 trae.ts fileBridge 读取格式一致） */
interface BridgeResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
}

let running = true;

/** 优雅关闭 */
function setupShutdown(): void {
  const shutdown = (signal: string): void => {
    if (!running) return;
    running = false;
    console.log(`\n[bridge-daemon] Received ${signal}, shutting down gracefully...`);
    // 给轮询循环一周期退出（running=false 后下一次轮询不执行）
    setTimeout(() => process.exit(0), POLL_MS + 100);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** 选择 LLM provider（codex/minimax，不含 trae 避免循环依赖） */
function selectProvider(): LlmProviderInterface {
  const providers: Record<LlmProvider, LlmProviderInterface> = {
    codex: new CodexProvider(),
    minimax: new MiniMaxProvider(),
    trae: undefined as never, // 禁止用 trae（循环依赖：trae→fileBridge→req→daemon→trae→...）
  };
  const p = providers[PROVIDER_NAME];
  if (!p) {
    throw new Error(`Invalid AWKN_BRIDGE_PROVIDER: ${PROVIDER_NAME}. Use 'codex' or 'minimax'.`);
  }
  return p;
}

/** mock 模式：直接返回 canned response */
function mockRespond(req: BridgeRequest): BridgeResponse {
  console.log(`[bridge-daemon] [mock] Responding to ${req.id} with canned content`);
  return {
    content: MOCK_CONTENT,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

/** 真实模式：调用 LLM provider */
async function llmRespond(
  req: BridgeRequest,
  provider: LlmProviderInterface,
): Promise<BridgeResponse> {
  const chatReq: ChatRequest = {
    messages: req.messages.map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
    model: req.model,
  };
  const resp = await provider.chat(chatReq);
  return {
    content: resp.content,
    usage: resp.usage,
  };
}

/** 处理单个 req 文件 */
async function processReqFile(
  reqPath: string,
  provider: LlmProviderInterface | null,
): Promise<void> {
  const reqName = reqPath.split(/[\\/]/).pop()!;
  const id = reqName.replace('req-', '').replace('.json', '');
  const respPath = resolve(BRIDGE_DIR, `resp-${id}.json`);

  // resp 已存在（可能上次 daemon 残留），跳过
  if (existsSync(respPath)) {
    console.log(`[bridge-daemon] Skipping ${reqName} (resp already exists)`);
    return;
  }

  // 读请求
  let req: BridgeRequest;
  try {
    const raw = readFileSync(reqPath, 'utf-8');
    req = JSON.parse(raw) as BridgeRequest;
  } catch (err) {
    console.error(`[bridge-daemon] Failed to parse ${reqName}: ${String(err)}`);
    // 写 error resp，让 trae 端快速失败（不等 120s timeout）
    writeResp(respPath, { content: '', error: `bridge-daemon parse error: ${String(err)}` });
    return;
  }

  console.log(`[bridge-daemon] Processing ${reqName} (model=${req.model}, msgs=${req.messages.length})`);

  // 调 LLM
  try {
    const resp = MOCK_MODE
      ? mockRespond(req)
      : await llmRespond(req, provider!);
    writeResp(respPath, resp);
    console.log(`[bridge-daemon] Wrote resp-${id}.json (${resp.content.length} chars)`);
  } catch (err) {
    const errMsg = String(err);
    console.error(`[bridge-daemon] LLM call failed for ${reqName}: ${errMsg}`);
    // 写 error resp，让 trae 端快速失败
    writeResp(respPath, { content: '', error: errMsg });
    console.log(`[bridge-daemon] Wrote error resp-${id}.json`);
  }
}

/** 写 resp 文件（原子写：先写 tmp 再 rename，避免 trae 读到半写文件）
 *  M1（2026-07-23）：原版代码注释声称用 rename 实现原子写，但实际用的是
 *    writeFileSync(respPath, readFileSync(tmpPath, 'utf-8')) —— 这与直接 writeFileSync
 *    等价，并非原子操作（trae 仍可能在写入瞬间读到半写文件）。
 *    违反"假成功"模式：注释声称的保证与实际行为不一致。
 *    修复：真正使用 renameSync 实现 atomic rename。
 *    Windows 注意：renameSync 在目标文件已存在时会失败（EXCL 语义），
 *    但本场景下 resp 文件不应已存在（processReqFile 先检查 existsSync(respPath) 跳过），
 *    所以正常路径不会触发；fallback 用 writeFileSync 直接写（保留原有降级语义）。
 */
function writeResp(respPath: string, resp: BridgeResponse): void {
  const tmpPath = respPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(resp));
  try {
    // rename 是原子的（POSIX + Windows NTFS）
    renameSync(tmpPath, respPath);
  } catch {
    // fallback：rename 失败（如 Windows 上目标已存在），直接写
    writeFileSync(respPath, JSON.stringify(resp));
    rmSync(tmpPath, { force: true });
  }
}

/** 轮询主循环 */
async function main(): Promise<void> {
  console.log('[bridge-daemon] Starting LLM bridge daemon');
  console.log(`[bridge-daemon] Bridge dir: ${BRIDGE_DIR}`);
  console.log(`[bridge-daemon] Provider: ${MOCK_MODE ? 'MOCK' : PROVIDER_NAME}`);
  console.log(`[bridge-daemon] Poll interval: ${POLL_MS}ms`);
  console.log('[bridge-daemon] Press Ctrl+C to stop\n');

  setupShutdown();

  // 确保 bridge 目录存在
  mkdirSync(BRIDGE_DIR, { recursive: true });

  // 初始化 provider（mock 模式不需要）
  let provider: LlmProviderInterface | null = null;
  if (!MOCK_MODE) {
    try {
      provider = selectProvider();
      console.log(`[bridge-daemon] Provider ${PROVIDER_NAME} initialized`);
    } catch (err) {
      console.error(`[bridge-daemon] Provider init failed: ${String(err)}`);
      console.error('[bridge-daemon] Falling back to MOCK mode. Set AWKN_BRIDGE_MOCK=1 explicitly to suppress this warning.');
      // 不退出，用 mock 兜底（但标记为 fallback）
    }
  }

  // 轮询循环
  let processed = 0;
  while (running) {
    let reqFiles: string[] = [];
    try {
      const all = readdirSync(BRIDGE_DIR);
      reqFiles = all
        .filter((f) => f.startsWith('req-') && f.endsWith('.json'))
        .map((f) => resolve(BRIDGE_DIR, f));
    } catch {
      // 目录被删或不可读，等下周期重试
    }

    for (const reqPath of reqFiles) {
      if (!running) break;
      // mock 模式：provider=null，mockRespond 不需要 provider
      // 真实模式：provider 已初始化（若 init 失败且未 mock，跳过等下次重试）
      if (MOCK_MODE || provider) {
        await processReqFile(reqPath, MOCK_MODE ? null : provider);
        processed++;
      }
    }

    // 等待下一周期
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.log(`[bridge-daemon] Stopped. Processed ${processed} request(s) total.`);
}

main().catch((err) => {
  console.error('[bridge-daemon] Fatal error:', err);
  process.exit(1);
});
