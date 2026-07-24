export type HookPoint =
  | 'session_start'
  | 'user_prompt_submit'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'pre_compact'
  | 'session_stop'
  | 'pre_llm_call'
  | 'post_llm_call';

export type HookType = 'command' | 'function';

export interface Hook {
  id: string;
  point: HookPoint;
  type: HookType;
  command?: string;
  fn?: (payload: HookPayload) => Promise<HookResult>;
  matcher?: string;
  statusMessage?: string;
  timeout: number;
  failClosed?: boolean;
}

export interface HookWireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface HookWireMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: HookWireToolCall[];
}

export interface HookPayload {
  point: HookPoint;
  toolName?: string;
  prompt?: string;
  sessionId?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  context?: Record<string, unknown>;
  llmRequest?: {
    id?: string;
    messages: HookWireMessage[];
    model?: string;
    provider?: string;
    tools?: Array<{
      type: 'function';
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }>;
    tool_choice?: 'auto' | 'none';
    temperature?: number;
    max_tokens?: number;
    createdAt?: string;
  };
}

export interface HookResult {
  success: boolean;
  output?: string;
  error?: string;
  modifiedPayload?: HookPayload;
  block?: boolean;
  blockReason?: string;
  llmResponse?: {
    content: string;
    toolCalls?: HookWireToolCall[];
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  };
}

export interface HooksConfig {
  hooks?: Record<string, Array<{
    matcher?: string;
    hooks: Array<{ type: 'command'; command: string }>;
  }>>;
}
