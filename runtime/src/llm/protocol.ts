import type { ChatMessage, ChatRequest } from './types.js';

export interface OpenAiWireMessage {
  role: ChatMessage['role'];
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export function encodeOpenAiMessages(messages: ChatMessage[]): OpenAiWireMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        role: message.role,
        content: message.content || null,
        tool_calls: message.toolCalls,
      };
    }

    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('Tool message is missing toolCallId');
      return {
        role: message.role,
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    }

    return { role: message.role, content: message.content };
  });
}

export interface BridgeRequest {
  id: string;
  model: string;
  messages: OpenAiWireMessage[];
  tools?: ChatRequest['tools'];
  tool_choice?: 'auto';
  temperature?: number;
  max_tokens?: number;
  createdAt: string;
}

export function buildBridgeRequest(id: string, req: ChatRequest, model: string): BridgeRequest {
  return {
    id,
    model,
    messages: encodeOpenAiMessages(req.messages),
    tools: req.tools,
    tool_choice: req.tools && req.tools.length > 0 ? 'auto' : undefined,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    createdAt: new Date().toISOString(),
  };
}
