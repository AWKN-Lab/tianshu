import { createLogger } from '../core/logger.js';
import { toolPolicy } from './policy.js';
import { TOOL_DEFAULTS, resolveToolDefaults, type ExecutionContext, type ToolHandler } from './types.js';

const logger = createLogger('ToolRegistry');
const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, normal: 3, low: 4 };

export class ToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();

  register(tool: ToolHandler): void {
    if (this.tools.has(tool.name)) logger.warn(`Tool "${tool.name}" is already registered. Overwriting.`);
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean { return this.tools.delete(name); }
  get(name: string): ToolHandler | undefined { return this.tools.get(name); }

  list(): ToolHandler[] {
    return Array.from(this.tools.values())
      .filter((tool) => !(tool.disabled ?? TOOL_DEFAULTS.disabled))
      .sort((a, b) => (PRIORITY_ORDER[a.priority ?? 'normal'] ?? 3) - (PRIORITY_ORDER[b.priority ?? 'normal'] ?? 3));
  }

  toFunctionDefinitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return this.list().map((tool) => {
      const resolved = resolveToolDefaults(tool);
      return { name: resolved.name, description: resolved.description, parameters: resolved.parameters };
    });
  }

  async execute(name: string, args: Record<string, unknown>, ctx?: ExecutionContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool "${name}" not found`);
    if (tool.disabled) throw new Error(`Tool "${name}" is disabled`);
    toolPolicy.assertAllowed(tool, args, ctx);
    const result = await tool.execute(args, ctx);
    const text = typeof result === 'string' ? result : result.content;
    const maxSize = tool.maxResultSize ?? TOOL_DEFAULTS.maxResultSize;
    return text.length > maxSize ? `${text.slice(0, maxSize)}\n... [truncated]` : text;
  }

  async executeConcurrent(calls: Array<{ name: string; args: Record<string, unknown> }>, ctx?: ExecutionContext): Promise<Array<{ name: string; result: string; error?: string }>> {
    return Promise.all(calls.map(async (call) => {
      try {
        return { name: call.name, result: await this.execute(call.name, call.args, ctx) };
      } catch (err) {
        return { name: call.name, result: '', error: err instanceof Error ? err.message : String(err) };
      }
    }));
  }
}

export const toolRegistry = new ToolRegistry();
