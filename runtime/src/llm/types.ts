export type LlmProvider = 'trae' | 'codex' | 'minimax' | 'opencode';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  provider?: LlmProvider;
  callSource?: string;
  /** Independent review may disable fallback to avoid same-model self-approval. */
  fallbackPolicy?: 'allow' | 'none';
  /** W3C-compatible trace ID shared by Run, LLM, Tool and Gate spans. */
  traceId?: string;
}

export interface ChatResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider: LlmProvider;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}

export interface LlmProviderInterface {
  name: LlmProvider;
  chat(req: ChatRequest): Promise<ChatResponse>;
  isAvailable(): Promise<boolean>;
}
