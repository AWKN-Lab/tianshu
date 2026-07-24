import { createHash, randomUUID } from 'node:crypto';
import type {
  CaptureMemoryEventInput,
  CompileMemoryContextInput,
  CompiledMemoryContext,
  ConsumeMemoryContextInput,
  MemoryBackend,
  MemoryBackendCapabilities,
  ObserveMemoryUsageInput,
  RememberInteractionInput,
} from './backend.js';
import { guardMemoryPayload } from './dlp.js';
import { getMemoryService } from './service.js';

export class LocalMemoryBackend implements MemoryBackend {
  readonly kind = 'local' as const;

  async connect(): Promise<MemoryBackendCapabilities> {
    return {
      backend: this.kind,
      online: true,
      features: ['working-memory-v1', 'local-retrieval-v1', 'versioning-v1'],
    };
  }

  async compileContext(input: CompileMemoryContextInput): Promise<CompiledMemoryContext> {
    const prompt = getMemoryService().buildContext({
      query: input.query,
      projectId: input.projectId,
      sessionId: input.sessionId ?? input.projectId,
      limit: Math.min(input.maxItems ?? 8, 32),
      maxChars: Math.max(512, Math.min((input.tokenBudget ?? 1500) * 4, 12000)),
    });
    return {
      backend: this.kind,
      prompt,
      stale: false,
      receiptId: `local:${createHash('sha256').update(`${input.projectId}\n${input.query}\n${prompt}`).digest('hex')}`,
      items: [],
    };
  }

  async capture(input: CaptureMemoryEventInput): Promise<Record<string, unknown>> {
    const decision = guardMemoryPayload(input.payload);
    return {
      backend: this.kind,
      status: decision.status,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    };
  }

  async observe(input: ObserveMemoryUsageInput): Promise<Record<string, unknown>> {
    return { backend: this.kind, status: 'UNSUPPORTED', evidenceLevel: input.evidenceLevel };
  }

  async consume(input: ConsumeMemoryContextInput): Promise<Record<string, unknown>> {
    return { backend: this.kind, status: 'RECORDED_LOCALLY', outcome: input.outcome };
  }

  async rememberInteraction(input: RememberInteractionInput): Promise<void> {
    const decision = guardMemoryPayload(input);
    getMemoryService().recordInteraction(decision.value);
  }
}
