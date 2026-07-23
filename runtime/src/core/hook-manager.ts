/**
 * Hook 生命周期管理器 — 从 awkn-agent 抽取
 *
 * 来源：awkn-agent/src/core/hook-manager.ts
 * 改动：logger 从 awkn-agent 的 observability/logger 换成本地 logger
 *
 * 特性：
 * - 串行执行注册的钩子
 * - 支持 command（外部脚本）和 function（内部函数）两种类型
 * - 钩子失败不阻断主流程，超时自动跳过
 * - pre_tool_use 钩子可通过 block=true 阻止工具执行
 */

import { execFile } from 'node:child_process';
import { createLogger } from './logger.js';
import type {
  Hook,
  HookPayload,
  HookPoint,
  HookResult,
  HooksConfig,
} from './hook-types.js';

const logger = createLogger('HookManager');

/** Codex hooks.json 事件名 → 内部 HookPoint 映射 */
const CODEX_POINT_MAP: Record<string, HookPoint> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  Stop: 'session_stop',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchesTool(hook: Hook, toolName: string | undefined): boolean {
  if (!hook.matcher) return true;
  if (!toolName) return false;
  try {
    const pattern = hook.matcher.replace(/\*/g, '.*').replace(/\?/g, '.');
    const re = new RegExp(`^${pattern}$`);
    return re.test(toolName);
  } catch {
    return false;
  }
}

export class HookManager {
  private hooks: Map<string, Hook> = new Map();

  /** 注册钩子 */
  register(hook: Hook): void {
    this.hooks.set(hook.id, hook);
  }

  /** 卸载钩子 */
  unload(id: string): void {
    this.hooks.delete(id);
  }

  /** 获取已注册钩子（可按 point 过滤） */
  getHooks(point?: HookPoint): Hook[] {
    const all = [...this.hooks.values()];
    if (!point) return all;
    return all.filter((h) => h.point === point);
  }

  /** 从 hooks.json 格式加载（Codex 兼容） */
  loadFromConfig(config: HooksConfig): void {
    if (!config.hooks) return;
    for (const [eventKey, hookList] of Object.entries(config.hooks)) {
      const point = CODEX_POINT_MAP[eventKey];
      if (!point) continue;
      for (const entry of hookList) {
        for (const hookDef of entry.hooks) {
          const id = `codex_${point}_${hookDef.command}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          this.register({
            id,
            point,
            type: 'command',
            command: hookDef.command,
            matcher: entry.matcher,
            timeout: 5000,
          });
        }
      }
    }
  }

  /** 触发钩子（串行执行） */
  async trigger(point: HookPoint, payload: HookPayload): Promise<HookResult[]> {
    const matched = [...this.hooks.values()].filter(
      (h) => h.point === point && matchesTool(h, payload.toolName),
    );

    const results: HookResult[] = [];

    for (const hook of matched) {
      try {
        const result = await this.executeWithTimeout(hook, payload);
        results.push(result);

        // pre_tool_use 钩子 block=true → 停止后续钩子执行
        if (point === 'pre_tool_use' && result.block) {
          break;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`Hook "${hook.id}" failed: ${errMsg}`);
        results.push({ success: false, error: errMsg });
        // 钩子失败不阻断主流程，继续执行下一个
      }
    }

    return results;
  }

  private async executeWithTimeout(
    hook: Hook,
    payload: HookPayload,
  ): Promise<HookResult> {
    const timeout = hook.timeout ?? 5000;

    if (hook.type === 'function') {
      return this.executeFunctionHook(hook, payload, timeout);
    }

    return this.executeCommandHook(hook, payload, timeout);
  }

  private async executeFunctionHook(
    hook: Hook,
    payload: HookPayload,
    timeout: number,
  ): Promise<HookResult> {
    if (!hook.fn) {
      return { success: false, error: `Hook "${hook.id}" has no fn` };
    }

    const result = await Promise.race([
      hook.fn(payload),
      sleep(timeout).then(
        () =>
          ({
            success: false,
            error: `Hook "${hook.id}" timed out after ${timeout}ms`,
          }) as HookResult,
      ),
    ]);

    return result;
  }

  private async executeCommandHook(
    hook: Hook,
    payload: HookPayload,
    timeout: number,
  ): Promise<HookResult> {
    if (!hook.command) {
      return { success: false, error: `Hook "${hook.id}" has no command` };
    }

    const result = await Promise.race([
      new Promise<HookResult>((resolve) => {
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          AWKN_HOOK_POINT: hook.point,
          AWKN_TOOL_NAME: payload.toolName ?? '',
          AWKN_SESSION_ID: payload.sessionId ?? '',
        };

        const proc = execFile(
          hook.command!,
          [],
          {
            env,
            timeout,
            maxBuffer: 1024 * 1024,
            shell: true,
          },
          (error: Error | null, stdout: string, _stderr: string) => {
            if (error) {
              const errAny = error as Error & { signal?: string; killed?: boolean };
              const isTimeout =
                errAny.signal === 'SIGTERM' || errAny.killed === true;
              resolve({
                success: false,
                error: isTimeout
                  ? `Hook "${hook.id}" timed out after ${timeout}ms`
                  : error.message,
                output: stdout?.slice(0, 1000),
              });
              return;
            }

            // 尝试解析 stdout 为 HookResult
            // M3 进阶-5（2026-07-23）：failClosed 钩子 fail-closed 语义
            //   - hook.failClosed=true 且 stdout 非 JSON → success:false + block:true（pre_tool_use）
            //   - hook.failClosed=true 且 stdout 是 JSON 但缺 success 字段 → 同上
            //   - 默认（failClosed=false/undefined）：保持原 fail-open 行为（向后兼容）
            //   设计原因：与 M3 进阶-4 trae stub 同类 — "无信号"不能当"成功"
            try {
              const parsed = JSON.parse(stdout) as Partial<HookResult>;
              const hasSuccessField = parsed.success !== undefined;

              // failClosed 模式：缺 success 字段 → fail-closed
              if (hook.failClosed === true && !hasSuccessField) {
                logger.warn(
                  `Hook "${hook.id}" (failClosed) missing "success" field in JSON output — failing closed`,
                );
                resolve({
                  success: false,
                  block: hook.point === 'pre_tool_use' ? true : undefined,
                  blockReason: `failClosed hook missing "success" field (raw: ${stdout.slice(0, 200)})`,
                  error: 'failClosed hook missing "success" field',
                  output: stdout,
                });
                return;
              }

              resolve({
                success: parsed.success ?? true,
                output: parsed.output ?? stdout,
                error: parsed.error,
                block: parsed.block,
                blockReason: parsed.blockReason,
                modifiedPayload: parsed.modifiedPayload,
                llmResponse: parsed.llmResponse,
              });
            } catch {
              // JSON.parse 失败
              // failClosed 模式：broken output → fail-closed（pre_tool_use 阻断）
              if (hook.failClosed === true) {
                logger.warn(
                  `Hook "${hook.id}" (failClosed) produced non-JSON output — failing closed (stdout: ${stdout.slice(0, 200)})`,
                );
                resolve({
                  success: false,
                  block: hook.point === 'pre_tool_use' ? true : undefined,
                  blockReason: `failClosed hook output is not valid JSON (raw: ${stdout.slice(0, 200)})`,
                  error: 'failClosed hook output is not valid JSON',
                  output: stdout,
                });
                return;
              }

              // 默认 fail-open（向后兼容 informational hooks）
              resolve({
                success: true,
                output: stdout,
              });
            }
          },
        );

        // 通过 stdin 传递 payload
        if (proc.stdin) {
          proc.stdin.write(JSON.stringify(payload));
          proc.stdin.end();
        }
      }),
      sleep(timeout).then(
        () =>
          ({
            success: false,
            error: `Hook "${hook.id}" timed out after ${timeout}ms`,
          }) as HookResult,
      ),
    ]);

    return result;
  }
}

/** 单例 */
export const hookManager = new HookManager();
