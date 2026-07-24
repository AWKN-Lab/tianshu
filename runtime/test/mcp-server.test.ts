/**
 * MCP server 冒烟测试：spawn server → initialize → tools/list → tools/call(awkn_skill_list)
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverBin = resolve(__dirname, '..', 'bin', 'awkn-mcp-server.js');

let msgId = 0;
function makeRequest(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: ++msgId, method, params: params ?? {} });
}

function makeNotification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} });
}

async function main(): Promise<void> {
  const child = spawn('node', [serverBin], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      AWKN_DISABLE_EVOLVE: '1', // 测试时关闭 evolve hook
    },
  });

  const stdout = child.stdout;
  if (!stdout) throw new Error('no stdout');

  let buffer = '';
  const pendingResolvers: Map<number, (data: unknown) => void> = new Map();

  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    // MCP messages are newline-delimited JSON-RPC
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pendingResolvers.has(msg.id)) {
          pendingResolvers.get(msg.id)!(msg);
          pendingResolvers.delete(msg.id);
        }
      } catch {
        // 非 JSON 行（debug 日志），忽略
      }
    }
  });

  function sendAndWait(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = msgId + 1;
      pendingResolvers.set(id, resolve);
      child.stdin?.write(makeRequest(method, params) + '\n');
      setTimeout(() => {
        if (pendingResolvers.has(id)) {
          pendingResolvers.delete(id);
          reject(new Error(`timeout waiting for ${method} (id=${id})`));
        }
      }, 10000);
    });
  }

  function sendNotification(method: string, params?: unknown): void {
    child.stdin?.write(makeNotification(method, params) + '\n');
  }

  try {
    // 1. initialize
    console.log('--- sending initialize ---');
    const initResp = await sendAndWait('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-smoke-test', version: '0.1.0' },
    });
    console.log('initialize response:', JSON.stringify(initResp, null, 2).slice(0, 300));

    // 2. initialized notification
    sendNotification('notifications/initialized');

    // 3. tools/list
    console.log('\n--- sending tools/list ---');
    const listResp = await sendAndWait('tools/list', {});
    const tools = (listResp as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    console.log(`tools/list: ${tools.length} tools`);
    for (const t of tools) {
      console.log(`  - ${t.name}`);
    }

    // 4. tools/call: awkn_skill_list (simple, no LLM)
    console.log('\n--- calling awkn_skill_list ---');
    const callResp = await sendAndWait('tools/call', {
      name: 'awkn_skill_list',
      arguments: {},
    });
    const callResult = (callResp as { result?: { content?: { text: string }[] } }).result;
    const text = callResult?.content?.[0]?.text ?? '';
    console.log(`awkn_skill_list result: ${text.slice(0, 200)}`);

    // 验证
    const expectedToolCount = 31;
    if (tools.length < expectedToolCount) {
      throw new Error(`expected >= ${expectedToolCount} tools, got ${tools.length}`);
    }
    console.log(`\n✅ PASS: ${tools.length} tools registered, awkn_skill_list responded`);
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500);
  }
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
