/**
 * LLM 调用统一接口
 *
 * 3 个 provider：
 * - trae: TRAE 自带（默认，通过 IDE/MCP 协议）
 * - codex: CODEX（OpenAI 兼容协议）
 * - minimax: MiniMax（OpenAI 兼容协议，text 用 M2.5/M2.1）
 */

export type LlmProvider = 'trae' | 'codex' | 'minimax';

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
  /** 强制指定 provider，不指定由 router 决定 */
  provider?: LlmProvider;
  /** 调用来源（用于观测） */
  callSource?: string;
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
