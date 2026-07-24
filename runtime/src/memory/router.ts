import type {
  CompiledMemoryContext,
  CompileMemoryContextInput,
  ConsumeMemoryContextInput,
  MemoryBackendMode,
  ObserveMemoryUsageInput,
  RememberInteractionInput,
} from './backend.js';
import { AwknMemoryOsBackend, type MemoryOsDiagnostic } from './awkn-memory-os-backend.js';
import { MemoryAuthorityOutboxProcessor } from './authority-outbox.js';
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

export interface MemoryRouterDiagnostic {
  mode: MemoryBackendMode;
  remoteEnabled: boolean;
  local: Awaited<ReturnType<LocalMemoryBackend['connect']>>;
  remote?: MemoryOsDiagnostic;
  error?: string;
}

export class MemoryBackendRouter {
  private readonly local: LocalMemoryBackend;
  private readonly remote: AwknMemoryOsBackend;
  private readonly authority: AwknMemoryAuthorityClient;
  private readonly authorityOutbox: MemoryAuthorityOutboxProcessor;
  private readonly mode: MemoryBackendMode;

  constructor(input: {
    mode?: MemoryBackendMode;
    local?: LocalMemoryBackend;
    remote?: AwknMemoryOsBackend;
    authority?: AwknMemoryAuthorityClient;
    authorityOutbox?: MemoryAuthorityOutboxProcessor;
  } = {}) {
    this.mode = input.mode ?? configuredMode();
    this.local = input.local ?? new LocalMemoryBackend();
    this.remote = input.remote ?? new AwknMemoryOsBackend();
    this.authority = input.authority ?? new AwknMemoryAuthorityClient();
    this.authorityOutbox = input.authorityOutbox ?? new MemoryAuthorityOutboxProcessor(undefined, this.remote);
  }

  isRemoteAuthorityEnabled(): boolean {
    return this.mode !== 'local' && remoteConfigured(this.mode);
  }

  async diagnose(input?: CompileMemoryContextInput): Promise<MemoryRouterDiagnostic> {
    const local = await this.local.connect();
    const remoteEnabled = this.isRemoteAuthorityEnabled();
    if (!remoteEnabled) return { mode: this.mode, remoteEnabled, local };
    try {
      return {
        mode: this.mode,
        remoteEnabled,
        local,
        remote: await this.remote.diagnose(input),
      };
    } catch (error) {
      return {
        mode: this.mode,
        remoteEnabled,
        local,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async compileAndRender(input: CompileMemoryContextInput): Promise<CompiledMemoryContext> {
    if (this.isRemoteAuthorityEnabled()) {
      await this.flushAuthorityOutbox(5).catch(() => ({ delivered: 0, failed: 1, pending: 0 }));
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
    await this.flushAuthorityOutbox(5).catch(() => ({ delivered: 0, failed: 1, pending: 0 }));
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

  async reviewApproveActivateAuthorityRule(ruleId: string): Promise<Record<string, unknown>> {
    if (!this.isRemoteAuthorityEnabled()) return { backend: 'local', status: 'SKIPPED' };
    return this.authority.reviewApproveActivateRule(ruleId);
  }

  async activateAuthorityRule(ruleId: string): Promise<Record<string, unknown>> {
    if (!this.isRemoteAuthorityEnabled()) return { backend: 'local', status: 'SKIPPED' };
    return this.authority.activateRule(ruleId);
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

  async flushAuthorityOutbox(limit = 20): Promise<{ delivered: number; failed: number; pending: number }> {
    if (!this.isRemoteAuthorityEnabled()) return { delivered: 0, failed: 0, pending: 0 };
    return this.authorityOutbox.flush(limit);
  }
}

let instance: MemoryBackendRouter | null = null;
export function getMemoryBackendRouter(): MemoryBackendRouter {
  if (!instance) instance = new MemoryBackendRouter();
  return instance;
}
