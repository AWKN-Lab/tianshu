/**
 * AgentTeams — 默认 Worker 执行器（AgentLoop 实现）
 *
 * 影响层级 [M]：复用 `action/steps/agent-step.ts` 同款 AgentLoop.runL1() 路径，
 * 叠加人格注入（M3.2）+ 工件落盘（M4.1）+ 心跳（M5.2）+ VERDICT（M3.3）。
 * 降 token：上游工件只给路径清单 + 首个工件截断预览，不内联全量上下文。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentLoop } from '../../core/agent-loop.js';
import { createLogger } from '../../core/logger.js';
import type { LlmProvider } from '../../llm/types.js';
import { buildWorkerSystemPrompt } from './persona-injector.js';
import { writeVerdict } from './verdict-writer.js';
import { getPersonaRegistry } from '../persona/registry.js';
import type { WorkerExecutor, WorkerTaskInput, WorkerTaskOutput } from '../team/types.js';
import type { HeartbeatMonitor } from '../gates/heartbeat.js';

const logger = createLogger('TeamWorker');

/** 上游工件预览上限（字符），其余以路径引用 */
const UPSTREAM_PREVIEW_CHARS = 2000;

/**
 * Worker 默认 LLM provider 解析：
 * 显式注入 > env AWKN_TEAM_LLM_PROVIDER > 默认 opencode。
 * 不走 trae 桥接（trae 依赖宿主 IDE hook，团队 Worker 属后台编排）。
 * 缺省 opencode（OpenCode zen 云 API 直连），失败时经 LlmRouter fallback 链
 * 自动降级到 minimax → codex。
 */
const KNOWN_PROVIDERS: readonly LlmProvider[] = ['opencode', 'aiping', 'openrouter', 'minimax', 'codex', 'trae'];

export function resolveWorkerProvider(explicit?: LlmProvider): LlmProvider {
  if (explicit) return explicit;
  const envProvider = process.env.AWKN_TEAM_LLM_PROVIDER as LlmProvider | undefined;
  if (envProvider && (KNOWN_PROVIDERS as readonly string[]).includes(envProvider)) return envProvider;
  return 'opencode';
}

export interface DefaultExecutorOptions {
  cwd: string;
  maxTurns?: number;
  heartbeat?: HeartbeatMonitor;
  capabilitiesRoot?: string;
  /** Worker LLM provider；缺省 opencode（不走 trae 桥接），可用 AWKN_TEAM_LLM_PROVIDER 覆盖 */
  provider?: LlmProvider;
}

/** 构建 Worker 用户任务 prompt（任务 + 上游工件引用） */
export function buildWorkerUserPrompt(input: WorkerTaskInput): string {
  const lines: string[] = [];
  lines.push(`# 团队使命`);
  lines.push(input.mission);
  lines.push('');
  lines.push(`# 你的任务（Worker: ${input.workerId}）`);
  lines.push(input.task);
  if (input.upstreamArtifacts.length > 0) {
    lines.push('');
    lines.push('# 上游工件（文件引用，按需读取，不必全部展开）');
    for (const path of input.upstreamArtifacts) {
      lines.push(`- ${path}`);
    }
    const first = input.upstreamArtifacts[0];
    if (first && existsSync(first)) {
      const preview = readFileSync(first, 'utf-8').slice(0, UPSTREAM_PREVIEW_CHARS);
      lines.push('');
      lines.push(`## 首个上游工件预览（截断）`);
      lines.push('```');
      lines.push(preview);
      lines.push('```');
    }
  }
  if (input.isReviewer) {
    lines.push('');
    lines.push('完成审查后，最后一行必须输出唯一裁决行：VERDICT: PASS 或 VERDICT: FAIL。');
  }
  lines.push('');
  lines.push(`请将最终产出写入工件目录：${input.artifactDir}/output.md`);
  return lines.join('\n');
}

/** 创建默认执行器 */
export function createDefaultExecutor(opts: DefaultExecutorOptions): WorkerExecutor {
  return async (input: WorkerTaskInput): Promise<WorkerTaskOutput> => {
    const heartbeatKey = input.workerId;
    opts.heartbeat?.start(heartbeatKey);
    try {
      const persona = getPersonaRegistry().get(input.personaId);
      const systemPrompt = buildWorkerSystemPrompt({
        persona,
        capability: input.capability,
        isReviewer: input.isReviewer,
        capabilitiesRoot: opts.capabilitiesRoot,
      });

      const loop = new AgentLoop({
        cwd: opts.cwd,
        enableL2: false,
        callSource: 'agent_teams',
        provider: resolveWorkerProvider(opts.provider),
        systemPrompt: systemPrompt ?? undefined,
        maxTurns: opts.maxTurns ?? 30,
      });

      opts.heartbeat?.touch(heartbeatKey);
      const result = await loop.runL1(buildWorkerUserPrompt(input));
      opts.heartbeat?.touch(heartbeatKey);

      const text = result.finalText ?? '';
      // 工件落盘：output.md（若 Worker 未自行写入）
      const outputPath = join(input.artifactDir, 'output.md');
      if (!existsSync(outputPath) && text.length > 0) {
        mkdirSync(input.artifactDir, { recursive: true });
        writeFileSync(outputPath, text, 'utf-8');
      }
      if (input.isReviewer) {
        writeVerdict(input.artifactDir, { workerId: input.workerId, personaId: input.personaId, text });
      }
      return { text, artifacts: ['output.md', ...(input.isReviewer ? ['verdict.json'] : [])] };
    } catch (err) {
      logger.error(`Worker ${input.workerId} 执行失败：${String(err)}`);
      throw err;
    } finally {
      opts.heartbeat?.stop(heartbeatKey);
    }
  };
}
