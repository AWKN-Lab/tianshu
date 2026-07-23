/**
 * 工具注册表 — 简化版（从 awkn-agent 抽取核心）
 *
 * 来源：awkn-agent/src/tools/registry.ts（精简）
 * 改动：移除 featureFlags / principles / core/types 依赖
 *
 * 职责：
 * - 注册/注销工具
 * - 按名称获取工具
 * - 列出所有工具定义（供 LLM function calling 用）
 * - 并发执行只读工具
 */

import { createLogger } from '../core/logger.js';
import { TOOL_DEFAULTS, resolveToolDefaults, type ToolHandler } from './types.js';

const logger = createLogger('ToolRegistry');

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  normal: 3,
  low: 4,
};

export class ToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();

  register(tool: ToolHandler): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`Tool "${tool.name}" is already registered. Overwriting.`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  list(): ToolHandler[] {
    return Array.from(this.tools.values())
      .filter((t) => !(t.disabled ?? TOOL_DEFAULTS.disabled))
      .sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority ?? 'normal'] ?? 3;
        const pb = PRIORITY_ORDER[b.priority ?? 'normal'] ?? 3;
        return pa - pb;
      });
  }

  /** 转成 LLM function calling 格式 */
  toFunctionDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return this.list().map((tool) => {
      const resolved = resolveToolDefaults(tool);
      return {
        name: resolved.name,
        description: resolved.description,
        parameters: resolved.parameters,
      };
    });
  }

  /** 执行工具（带结果大小截断） */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx?: import('./types.js').ExecutionContext,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }
    if (tool.disabled) {
      throw new Error(`Tool "${name}" is disabled`);
    }

    const result = await tool.execute(args, ctx);
    const text = typeof result === 'string' ? result : result.content;
    const maxSize = tool.maxResultSize ?? TOOL_DEFAULTS.maxResultSize;

    if (text.length > maxSize) {
      return text.slice(0, maxSize) + '\n... [truncated]';
    }
    return text;
  }

  /** 并发执行多个只读工具 */
  async executeConcurrent(
    calls: Array<{ name: string; args: Record<string, unknown> }>,
    ctx?: import('./types.js').ExecutionContext,
  ): Promise<Array<{ name: string; result: string; error?: string }>> {
    const results = await Promise.all(
      calls.map(async (call) => {
        try {
          const result = await this.execute(call.name, call.args, ctx);
          return { name: call.name, result };
        } catch (err) {
          return {
            name: call.name,
            result: '',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return results;
  }
}

/** 单例 */
export const toolRegistry = new ToolRegistry();
