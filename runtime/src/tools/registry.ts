import { createLogger } from '../core/logger.js';
import { startSpan } from '../observability/trace.js';
import { getSandboxExecutor } from '../sandbox/index.js';
import { recordSandboxExecution } from '../sandbox/audit-store.js';
import { getApprovalStore } from '../workflow/approval-store.js';
import { ToolPolicyError, toolPolicy } from './policy.js';
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

  toFunctionDefinitions(excludedNames: Iterable<string> = []): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    const excluded = new Set(excludedNames);
    return this.list().filter((tool) => !excluded.has(tool.name)).map((tool) => {
      const resolved = resolveToolDefaults(tool);
      return { name: resolved.name, description: resolved.description, parameters: resolved.parameters };
    });
  }

  async execute(name: string, args: Record<string, unknown>, ctx?: ExecutionContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool "${name}" not found`);
    if (tool.disabled) throw new Error(`Tool "${name}" is disabled`);

    const resolved = resolveToolDefaults(tool);
    const span = startSpan({
      traceId: ctx?.traceId,
      name: 'tool.execute',
      kind: 'client',
      attributes: {
        'tool.name': name,
        'tool.source': tool.source,
        'tool.permission_level': resolved.permissionLevel,
        'awkn.call_source': ctx?.callSource ?? 'unknown',
        'run.id': ctx?.runId ?? '',
        'step.id': ctx?.stepId ?? '',
      },
    });

    try {
      // Keep the registry pre-check aligned with ToolPolicy. Previously the
      // environment allow-list passed policy.ts but was rejected here first.
      const envApprovedNames = (process.env.AWKN_APPROVED_TOOLS ?? '')
        .split(',')
        .map((toolName) => toolName.trim())
        .filter(Boolean);
      const approvedNames = new Set([...(ctx?.approvedToolNames ?? []), ...envApprovedNames]);
      if (resolved.permissionLevel === 'confirm' && ctx?.runId && !approvedNames.has(name) && !approvedNames.has('*')) {
        const approvalStore = getApprovalStore();
        const approved = ctx.approvalId
          ? approvalStore.isApproved(ctx.approvalId, ctx.runId, name)
          : approvalStore.findApproved(ctx.runId, name) !== null;
        if (!approved) {
          const approval = approvalStore.request({
            runId: ctx.runId,
            stepId: ctx.stepId,
            toolName: name,
            args,
          });
          const decision = toolPolicy.evaluate(tool, args, ctx);
          throw new ToolPolicyError(`approval required: ${approval.id}`, {
            ...decision,
            allowed: false,
            approvalRequired: true,
            reason: `approval required: ${approval.id}`,
          });
        }
        approvedNames.add(name);
      }

      const effectiveContext = ctx ? { ...ctx, approvedToolNames: [...approvedNames] } : ctx;
      toolPolicy.assertAllowed(tool, args, effectiveContext);
      const text = name === 'exec' || name === 'write'
        ? await this.executeSandboxed(name, args, effectiveContext)
        : await this.executeHandler(tool, args, effectiveContext);

      span.end('ok', {
        'tool.result.size': text.length,
        'tool.sandboxed': name === 'exec' || name === 'write',
        'tool.approval.present': resolved.permissionLevel !== 'confirm' || approvedNames.has(name) || approvedNames.has('*'),
      });
      return text;
    } catch (err) {
      span.end('error', {
        'tool.sandboxed': name === 'exec' || name === 'write',
        'tool.policy_blocked': err instanceof ToolPolicyError,
      }, err);
      throw err;
    }
  }

  private async executeHandler(tool: ToolHandler, args: Record<string, unknown>, ctx?: ExecutionContext): Promise<string> {
    const result = await tool.execute(args, ctx);
    const text = typeof result === 'string' ? result : result.content;
    const maxSize = tool.maxResultSize ?? TOOL_DEFAULTS.maxResultSize;
    return text.length > maxSize ? `${text.slice(0, maxSize)}\n... [truncated]` : text;
  }

  private async executeSandboxed(name: 'exec' | 'write', args: Record<string, unknown>, ctx?: ExecutionContext): Promise<string> {
    const executor = getSandboxExecutor();
    const workspaceRoot = ctx?.workspaceRoot ?? process.cwd();
    const sessionId = ctx?.sessionId ?? 'runtime';
    const result = name === 'exec'
      ? await executor.executeCommand({
          command: String(args.command ?? ''),
          cwd: String(args.cwd ?? workspaceRoot),
          workspaceRoot,
          timeoutMs: Number(args.timeoutMs ?? 60_000),
          sessionId,
          runId: ctx?.runId,
          stepId: ctx?.stepId,
        })
      : await executor.writeFile({
          path: String(args.path ?? ''),
          content: String(args.content ?? ''),
          workspaceRoot,
          sessionId,
          runId: ctx?.runId,
          stepId: ctx?.stepId,
        });

    recordSandboxExecution({
      runId: ctx?.runId,
      stepId: ctx?.stepId,
      sessionId,
      toolName: name,
      command: name === 'exec' ? String(args.command ?? '') : undefined,
      cwd: name === 'exec' ? String(args.cwd ?? workspaceRoot) : workspaceRoot,
      result,
    });

    if (result.status === 'error' || result.exitCode !== 0) {
      throw new Error(`Sandbox ${result.backend} failed with exit ${result.exitCode}\n${result.stderr || result.stdout}`);
    }
    const text = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
    return text || `${name} completed in sandbox ${result.backend}`;
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
