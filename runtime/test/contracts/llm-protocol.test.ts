import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBridgeRequest, encodeOpenAiMessages } from '../../src/llm/protocol.js';

const toolCall = {
  id: 'call_1',
  type: 'function' as const,
  function: { name: 'read', arguments: '{"path":"a.txt"}' },
};

describe('canonical LLM protocol', () => {
  it('preserves assistant tool_calls and tool tool_call_id', () => {
    const encoded = encodeOpenAiMessages([
      { role: 'user', content: 'read a file' },
      { role: 'assistant', content: '', toolCalls: [toolCall] },
      { role: 'tool', content: 'hello', toolCallId: 'call_1' },
    ]);
    assert.deepEqual(encoded[1].tool_calls, [toolCall]);
    assert.equal(encoded[1].content, null);
    assert.equal(encoded[2].tool_call_id, 'call_1');
  });

  it('rejects orphan tool messages', () => {
    assert.throws(() => encodeOpenAiMessages([{ role: 'tool', content: 'orphan' }]), /missing toolCallId/);
  });

  it('includes tools in the TRAE bridge contract', () => {
    const request = buildBridgeRequest('req-1', {
      messages: [{ role: 'user', content: 'run' }],
      tools: [{
        type: 'function',
        function: { name: 'read', description: 'read file', parameters: { type: 'object' } },
      }],
    }, 'model');
    assert.equal(request.tool_choice, 'auto');
    assert.ok(Array.isArray(request.tools));
  });
});
