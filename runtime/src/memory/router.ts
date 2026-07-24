import type {
  CompiledMemoryContext,
  CompileMemoryContextInput,
  ConsumeMemoryContextInput,
  MemoryBackendMode,
  ObserveMemoryUsageInput,
  RememberInteractionInput,
} from './backend.js';
import { AwknMemoryOsBackend } from './awkn-memory-os-backend.js';
import {
  AwknMemoryAuthorityClient,
  type GovernCandidateInput,
  type GovernCandidateResult,
} from './authority.js';
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
  private readonly authority: AwknMemoryAuthorityClient;
  private readonly mode: MemoryBackendMode;

  constructor(input: {
    mode?: MemoryBackendMode;
    local?: LocalMemoryBackend;
    remote?: AwknMemoryOsBackend;
    authority?: AwknMemoryAuthorityClient;
  } = {}) {
    this.mode = input.mode ?? configuredMode();
    this.local = input.local ?? new LocalMemoryBackend();
    this.remote = input.remote ?? new AwknMemoryOsBackend();
    this.authority = input.authority ?? new AwknMemoryAuthorityClient();
  }

  isRemoteAuthorityEnabled(): boolean {
    return this.mode !== 'local' && remoteConfigured(this.mode);
  }

  async compileAndRender(input: CompileMemoryContextInput): Promise<CompiledMemoryContext> {
    if (this.isRemoteAuthorityEnabled()) {
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
    if (!this.isRemoteAuthorityEnabled()) return;
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

  async recordRunOutcome(input: {
    projectId: string;
    sessionId: string;
    runId: string;
    traceId: string;
    workflowName: string;
    goalId?: string;
    status: string;
    output?: Record<string, unknown>;
    steps: Array<{ key: string; type: string; status: string; attempt: number; error?: string }>;
  }): Promise<Record<string, unknown>> {
    if (!this.isRemoteAuthorityEnabled()) return { backend: 'local', status: 'SKIPPED' };
    return this.remote.capture({
      projectId: input.projectId,
      sessionId: input.sessionId,
      traceId: input.traceId,
      idempotencyKey: `run:${input.runId}:terminal:${input.status}`,
      eventType: 'run.terminal',
      payload: {
        runId: input.runId,
        workflowName: input.workflowName,
        goalId: input.goalId ?? null,
        status: input.status,
        output: input.output ?? {},
        steps: input.steps,
      },
    });
  }

  async governCandidate(input: GovernCandidateInput): Promise<GovernCandidateResult | null> {
    if (!this.isRemoteAuthorityEnabled()) return null;
    return this.authority.governCandidate(input);
  }

  async pauseAuthorityRule(ruleId: string, reason: string): Promise<Record<string, unknown>> {
    if (!this.isRemoteAuthorityEnabled()) return { backend: 'local', status: 'SKIPPED' };
    return this.authority.pauseRule(ruleId, reason);
  }

  async revokeAuthorityRule(ruleId: string, reason: string): Promise<Record<string, unknown>> {
    if (!this.isRemoteAuthorityEnabled()) return { backend: 'local', status: 'SKIPPED' };
    return this.authority.revokeRule(ruleId, reason);
  }

  async observe(input: ObserveMemoryUsageInput): Promise<Record<string, unknown>> {
    if (!this.isRemoteAuthorityEnabled()) return this.local.observe(input);
    return this.remote.observe(input);
  }

  async consume(input: ConsumeMemoryContextInput): Promise<Record<string, unknown>> {
    if (!this.isRemoteAuthorityEnabled()) return this.local.consume(input);
    return this.remote.consume(input);
  }

  async flushRemoteOutbox(): Promise<{ flushed: number; remaining: number }> {
    if (!this.isRemoteAuthorityEnabled()) return { flushed: 0, remaining: 0 };
    return this.remote.flushOutbox();
  }
}

let instance: MemoryBackendRouter | null = null;
export function getMemoryBackendRouter(): MemoryBackendRouter {
  if (!instance) instance = new MemoryBackendRouter();
  return instance;
}
