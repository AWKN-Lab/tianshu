import type {
  CompiledMemoryContext,
  CompileMemoryContextInput,
  ConsumeMemoryContextInput,
  MemoryBackendMode,
  ObserveMemoryUsageInput,
  RememberInteractionInput,
} from './backend.js';
import { AwknMemoryOsBackend } from './awkn-memory-os-backend.js';
import { LocalMemoryBackend } from './local-backend.js';

function configuredMode(): MemoryBackendMode {
  const value = process.env.AWKN_MEMORY_BACKEND?.toLowerCase();
  if (value === 'local' || value === 'memory-os' || value === 'auto') return value;
  return 'auto';
}

function remoteConfigured(mode: MemoryBackendMode): boolean {
  return mode === 'memory-os' || Boolean(process.env.AWKN_MEMORY_OS_URL);
}

export class MemoryBackendRouter {
  private readonly local: LocalMemoryBackend;
  private readonly remote: AwknMemoryOsBackend;
  private readonly mode: MemoryBackendMode;

  constructor(input: {
    mode?: MemoryBackendMode;
    local?: LocalMemoryBackend;
    remote?: AwknMemoryOsBackend;
  } = {}) {
    this.mode = input.mode ?? configuredMode();
    this.local = input.local ?? new LocalMemoryBackend();
    this.remote = input.remote ?? new AwknMemoryOsBackend();
  }

  async compileAndRender(input: CompileMemoryContextInput): Promise<CompiledMemoryContext> {
    if (this.mode !== 'local' && remoteConfigured(this.mode)) {
      try {
        return await this.remote.compileContext(input);
      } catch {
        const fallback = await this.local.compileContext(input);
        return { ...fallback, stale: true };
      }
    }
    return this.local.compileContext(input);
  }

  async rememberInteraction(input: RememberInteractionInput): Promise<void> {
    await this.local.rememberInteraction(input);
    if (this.mode === 'local' || !remoteConfigured(this.mode)) return;
    await this.remote.rememberInteraction(input);
  }

  async finalizeContext(input: {
    context?: CompiledMemoryContext;
    projectId: string;
    taskId?: string;
    sessionId: string;
    responseText: string;
    outcome: string;
  }): Promise<void> {
    const context = input.context;
    if (!context?.receiptId || context.backend !== 'awkn-memory-os') return;
    const used = context.items.filter((item) => item.citationKey && input.responseText.includes(item.citationKey));
    for (const item of used) {
      await this.remote.observe({
        renderId: context.renderId ?? '',
        itemType: item.type,
        itemId: item.id,
        evidenceLevel: 'CITED',
        citationRefs: [item.citationKey!],
      });
    }
    await this.remote.consume({
      receiptId: context.receiptId,
      renderId: context.renderId,
      projectId: input.projectId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      usedItems: used.map((item) => ({ type: item.type, id: item.id })),
      outcome: input.outcome,
      notes: used.length > 0 ? 'citations detected in model response' : 'no explicit memory citation detected',
    });
  }

  async observe(input: ObserveMemoryUsageInput): Promise<Record<string, unknown>> {
    if (this.mode === 'local' || !remoteConfigured(this.mode)) return this.local.observe(input);
    return this.remote.observe(input);
  }

  async consume(input: ConsumeMemoryContextInput): Promise<Record<string, unknown>> {
    if (this.mode === 'local' || !remoteConfigured(this.mode)) return this.local.consume(input);
    return this.remote.consume(input);
  }

  async flushRemoteOutbox(): Promise<{ flushed: number; remaining: number }> {
    if (this.mode === 'local' || !remoteConfigured(this.mode)) return { flushed: 0, remaining: 0 };
    return this.remote.flushOutbox();
  }
}

let instance: MemoryBackendRouter | null = null;
export function getMemoryBackendRouter(): MemoryBackendRouter {
  if (!instance) instance = new MemoryBackendRouter();
  return instance;
}
