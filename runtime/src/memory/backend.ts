export type MemoryBackendKind = 'local' | 'awkn-memory-os';
export type MemoryBackendMode = 'local' | 'memory-os' | 'auto';

export interface MemoryProtocol {
  protocol: string;
  major: number;
  minor: number;
  core_version?: string;
  schema_version?: number;
  min_sdk_version?: string;
  features: string[];
}

export interface MemoryBackendCapabilities {
  backend: MemoryBackendKind;
  online: boolean;
  protocol?: MemoryProtocol;
  features: string[];
}

export interface CompileMemoryContextInput {
  projectId: string;
  taskId?: string;
  sessionId?: string;
  query: string;
  tokenBudget?: number;
  requestedScopes?: string[];
  maxItems?: number;
}

export interface MemoryContextItem {
  type: string;
  id: string;
  citationKey?: string;
  contentHash?: string;
}

export interface CompiledMemoryContext {
  backend: MemoryBackendKind;
  prompt: string;
  stale: boolean;
  receiptId?: string;
  renderId?: string;
  promptHash?: string;
  items: MemoryContextItem[];
  protocol?: MemoryProtocol;
}

export interface CaptureMemoryEventInput {
  projectId: string;
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  traceId?: string;
  parentSpanId?: string;
  idempotencyKey?: string;
}

export interface ObserveMemoryUsageInput {
  renderId: string;
  itemType: string;
  itemId: string;
  evidenceLevel: 'CITED' | 'ACTED_ON' | 'OUTCOME_ATTRIBUTED';
  citationRefs?: string[];
  decisionRefs?: string[];
  outcome?: string;
  idempotencyKey?: string;
}

export interface ConsumeMemoryContextInput {
  receiptId: string;
  renderId?: string;
  projectId: string;
  taskId?: string;
  sessionId?: string;
  usedItems: Array<{ type: string; id: string }>;
  outcome: string;
  notes?: string;
  idempotencyKey?: string;
}

export interface RememberInteractionInput {
  userText: string;
  assistantText: string;
  projectId: string;
  sessionId: string;
  traceId?: string;
}

export interface MemoryBackend {
  readonly kind: MemoryBackendKind;
  connect(): Promise<MemoryBackendCapabilities>;
  compileContext(input: CompileMemoryContextInput): Promise<CompiledMemoryContext>;
  capture(input: CaptureMemoryEventInput): Promise<Record<string, unknown>>;
  observe(input: ObserveMemoryUsageInput): Promise<Record<string, unknown>>;
  consume(input: ConsumeMemoryContextInput): Promise<Record<string, unknown>>;
  rememberInteraction(input: RememberInteractionInput): Promise<void>;
}
