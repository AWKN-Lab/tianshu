import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type {
  CaptureMemoryEventInput,
  CompileMemoryContextInput,
  CompiledMemoryContext,
  ConsumeMemoryContextInput,
  MemoryBackend,
  MemoryBackendCapabilities,
  MemoryProtocol,
  ObserveMemoryUsageInput,
  RememberInteractionInput,
} from './backend.js';
import { guardMemoryPayload } from './dlp.js';
import { MemoryOutbox, type MemoryOutboxRecord } from './outbox.js';

const REQUIRED_FEATURES = new Set(['context-ledger-v1', 'observed-usage-v1']);

function readToken(): string | undefined {
  const direct = process.env.AWKN_MEMORY_OS_TOKEN ?? process.env.AWKN_SESSION_TOKEN;
  if (direct?.trim()) return direct.trim();
  const tokenPath = process.env.AWKN_MEMORY_OS_TOKEN_PATH;
  if (tokenPath && existsSync(tokenPath)) {
    const value = readFileSync(tokenPath, 'utf-8').trim();
    if (value) return value;
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class MemoryProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryProtocolError';
  }
}

export class AwknMemoryOsBackend implements MemoryBackend {
  readonly kind = 'awkn-memory-os' as const;
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly outbox: MemoryOutbox;
  private protocol?: MemoryProtocol;
  private readonly startedSessions = new Set<string>();

  constructor(input: {
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    outbox?: MemoryOutbox;
  } = {}) {
    this.baseUrl = (input.baseUrl ?? process.env.AWKN_MEMORY_OS_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
    this.token = input.token ?? readToken();
    this.timeoutMs = input.timeoutMs ?? Number(process.env.AWKN_MEMORY_OS_TIMEOUT_MS ?? 2500);
    this.outbox = input.outbox ?? new MemoryOutbox();
  }

  async connect(): Promise<MemoryBackendCapabilities> {
    const raw = await this.request('GET', '/api/v1/protocol');
    const protocol = raw as unknown as MemoryProtocol;
    if (protocol.major !== 1) throw new MemoryProtocolError(`unsupported AWKN Memory OS protocol major: ${protocol.major}`);
    const features = new Set(protocol.features ?? []);
    const missing = [...REQUIRED_FEATURES].filter((feature) => !features.has(feature));
    if (missing.length > 0) throw new MemoryProtocolError(`AWKN Memory OS missing features: ${missing.join(', ')}`);
    await this.request('GET', '/api/v1/projects');
    this.protocol = protocol;
    return { backend: this.kind, online: true, protocol, features: [...features] };
  }

  async compileContext(input: CompileMemoryContextInput): Promise<CompiledMemoryContext> {
    const capabilities = this.protocol
      ? { protocol: this.protocol }
      : await this.connect();
    const receipt = await this.request('POST', '/api/v1/context/assemble', {
      project_id: input.projectId,
      task_id: input.taskId ?? null,
      session_id: input.sessionId ?? null,
      query: input.query,
      token_budget: input.tokenBudget ?? 4000,
      requested_scopes: input.requestedScopes ?? null,
      max_items: input.maxItems ?? 100,
      include_evidence: true,
      include_tasks: true,
      include_feedback: false,
    });
    const receiptId = String(receipt.receipt_id ?? asObject(receipt.receipt).receipt_id ?? '');
    if (!receiptId) throw new Error('AWKN Memory OS context response has no receipt_id');
    const render = await this.request('POST', `/api/v1/context/receipts/${encodeURIComponent(receiptId)}/render`, {
      idempotency_key: randomUUID(),
      items: null,
    });
    const rawItems = Array.isArray(render.items) ? render.items : [];
    return {
      backend: this.kind,
      prompt: String(render.prompt ?? ''),
      stale: false,
      receiptId,
      renderId: String(render.render_id ?? ''),
      promptHash: typeof render.prompt_hash === 'string' ? render.prompt_hash : undefined,
      protocol: capabilities.protocol,
      items: rawItems.map((item) => {
        const row = asObject(item);
        return {
          type: String(row.type ?? ''),
          id: String(row.id ?? ''),
          citationKey: typeof row.citation_key === 'string' ? row.citation_key : undefined,
          contentHash: typeof row.content_hash === 'string' ? row.content_hash : undefined,
        };
      }).filter((item) => item.type && item.id),
    };
  }

  async capture(input: CaptureMemoryEventInput): Promise<Record<string, unknown>> {
    await this.ensureSession(input.projectId, input.sessionId);
    return this.request('POST', '/api/v1/capture/events', {
      project_id: input.projectId,
      agent_type: 'CODE',
      session_id: input.sessionId,
      event_type: input.eventType,
      idempotency_key: input.idempotencyKey ?? randomUUID(),
      occurred_at: new Date().toISOString(),
      payload: input.payload,
      trace: {
        trace_id: input.traceId ?? randomUUID().replaceAll('-', ''),
        span_id: randomUUID().replaceAll('-', '').slice(0, 16),
        ...(input.parentSpanId ? { parent_span_id: input.parentSpanId } : {}),
      },
      runtime: {
        agent_id: process.env.AWKN_MEMORY_OS_AGENT_ID ?? 'tianshu',
        agent_instance_id: process.env.AWKN_MEMORY_OS_AGENT_INSTANCE_ID ?? `tianshu-${process.pid}`,
        runtime_run_id: input.traceId ?? randomUUID(),
        connector_type: 'tianshu-typescript',
        connector_version: '0.1.0',
      },
    }, true);
  }

  async observe(input: ObserveMemoryUsageInput): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/v1/context/renders/${encodeURIComponent(input.renderId)}/observe`, {
      item_type: input.itemType,
      item_id: input.itemId,
      evidence_level: input.evidenceLevel,
      idempotency_key: input.idempotencyKey ?? randomUUID(),
      citation_refs: input.citationRefs ?? [],
      decision_refs: input.decisionRefs ?? [],
      outcome: input.outcome ?? null,
    }, true);
  }

  async consume(input: ConsumeMemoryContextInput): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/v1/context/receipts/${encodeURIComponent(input.receiptId)}/consume`, {
      used_items: input.usedItems,
      outcome: input.outcome,
      idempotency_key: input.idempotencyKey ?? randomUUID(),
      task_id: input.taskId ?? null,
      session_id: input.sessionId ?? null,
      notes: input.notes ?? '',
      render_id: input.renderId ?? null,
    }, true);
  }

  async rememberInteraction(input: RememberInteractionInput): Promise<void> {
    await this.capture({
      projectId: input.projectId,
      sessionId: input.sessionId,
      eventType: 'dialogue.interaction',
      traceId: input.traceId,
      payload: { userText: input.userText, assistantText: input.assistantText },
    });
  }

  async flushOutbox(): Promise<{ flushed: number; remaining: number }> {
    const records = this.outbox.readValid();
    const remaining: MemoryOutboxRecord[] = [];
    let flushed = 0;
    for (const record of records) {
      try {
        await this.request(record.method, record.path, record.payload ?? undefined, false, record.idempotencyKey);
        flushed++;
      } catch {
        remaining.push(record);
      }
    }
    this.outbox.replace(remaining);
    return { flushed, remaining: remaining.length };
  }

  private async ensureSession(projectId: string, sessionId: string): Promise<void> {
    const key = `${projectId}:${sessionId}`;
    if (this.startedSessions.has(key)) return;
    await this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/start`, {
      agent_type: 'CODE',
    }, true);
    this.startedSessions.add(key);
  }

  private async request(
    method: string,
    path: string,
    payload?: Record<string, unknown>,
    queueOnFailure = false,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const decision = payload === undefined ? undefined : guardMemoryPayload(payload);
    const cleanPayload = decision?.value;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(cleanPayload ? { 'content-type': 'application/json' } : {}),
          ...(this.token ? { 'x-awkn-session-token': this.token } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: cleanPayload ? JSON.stringify(cleanPayload) : undefined,
      });
      const text = await response.text();
      const body = text ? asObject(JSON.parse(text)) : {};
      if (response.status >= 500 && queueOnFailure) {
        return this.queued(method, path, cleanPayload, idempotencyKey, `core-${response.status}`);
      }
      if (!response.ok) throw new Error(`AWKN Memory OS ${method} ${path} failed: ${response.status} ${text.slice(0, 500)}`);
      return body;
    } catch (error) {
      if (queueOnFailure && (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError'))) {
        return this.queued(method, path, cleanPayload, idempotencyKey, error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private queued(
    method: string,
    path: string,
    payload: Record<string, unknown> | undefined,
    idempotencyKey: string | undefined,
    reason: string,
  ): Record<string, unknown> {
    const record = this.outbox.enqueue({ method, path, payload, idempotencyKey });
    return { queued: true, status: 'PENDING', outboxRecordId: record.id, reason };
  }
}
