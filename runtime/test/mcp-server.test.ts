/**
 * MCP server 冒烟测试：spawn server → initialize → tools/list → tools/call
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = resolve(__dirname, '..', 'src', 'mcp', 'server.ts');

// packages/awkn-engine-mcp 为独立 Git 历史包（不入仓库）：本机检出时走完整工作流断言，
// CI 无包时验证工具按设计返回明确降级错误（server.ts getTianhuoRouter 预检）。
const packageRouterEntry = resolve(
  __dirname, '..', '..',
  'packages', 'awkn-engine-mcp', 'runtime', 'src', 'capabilities', 'router.ts',
);
const hasTianhuoPackage = existsSync(packageRouterEntry);
console.log(`[mcp-server.test] packages/awkn-engine-mcp present: ${hasTianhuoPackage}`);

let msgId = 0;
function makeRequest(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: ++msgId, method, params: params ?? {} });
}

function makeNotification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} });
}

async function main(): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', serverSource], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      AWKN_DISABLE_EVOLVE: '1', // 测试时关闭 evolve hook
      AWKN_DB_PATH: ':memory:', // 隔离正式运行库，避免 MCP 进程间锁竞争
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
      }, 120000);
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

    // 5. 天火工作流：start → advance × 2 → completed（转发 package TianhuoRouter）
    //    包缺失环境（CI）验证降级错误；包存在环境（本机）验证完整工作流。
    console.log('\n--- calling awkn_tianhuo_start ---');
    const startResp = await sendAndWait('tools/call', {
      name: 'awkn_tianhuo_start',
      arguments: {
        task: '小改：修正 README 排版',
        projectPath: resolve(__dirname, '..', '..'),
      },
    });
    const startText = (startResp as { result?: { content?: { text: string }[] } })
      .result?.content?.[0]?.text ?? '';

    if (!hasTianhuoPackage) {
      if (!(startResp as { result?: { isError?: boolean } }).result?.isError) {
        throw new Error(`expected isError when TianhuoRouter package missing, got ${startText}`);
      }
      if (!startText.includes('awkn-mcp-admin-server')) {
        throw new Error(`expected awkn-mcp-admin-server hint in degraded error, got ${startText}`);
      }
      console.log(`✅ PASS: TianhuoRouter package missing → degraded error: ${startText.slice(0, 120)}`);
    } else {
    const startResult = JSON.parse(startText) as {
      workflowId?: string;
      capabilityId?: string;
      route?: string;
    };
    if (!startResult.workflowId || startResult.capabilityId !== 'execution-check') {
      throw new Error(`expected execution-check workflow, got ${startText}`);
    }

    console.log('\n--- calling awkn_tianhuo_advance: execution-check → engineer ---');
    const advance1Resp = await sendAndWait('tools/call', {
      name: 'awkn_tianhuo_advance',
      arguments: {
        workflowId: startResult.workflowId,
        status: 'pass',
        evidence: ['npm run typecheck: 0 errors'],
      },
    });
    const advance1Text = (advance1Resp as { result?: { content?: { text: string }[] } })
      .result?.content?.[0]?.text ?? '';
    const advance1Result = JSON.parse(advance1Text) as { capabilityId?: string };
    if (advance1Result.capabilityId !== 'engineer') {
      throw new Error(`expected engineer after first advance, got ${advance1Text}`);
    }

    console.log('\n--- calling awkn_tianhuo_advance: engineer → completed ---');
    const advance2Resp = await sendAndWait('tools/call', {
      name: 'awkn_tianhuo_advance',
      arguments: {
        workflowId: startResult.workflowId,
        status: 'pass',
        evidence: ['tests 120/120 pass'],
      },
    });
    const advance2Text = (advance2Resp as { result?: { content?: { text: string }[] } })
      .result?.content?.[0]?.text ?? '';
    const advance2Result = JSON.parse(advance2Text) as { status?: string };
    if (advance2Result.status !== 'completed') {
      throw new Error(`expected completed after second advance, got ${advance2Text}`);
    }
    }

    // 验证
    const expectedToolCount = 34;
    if (tools.length < expectedToolCount) {
      throw new Error(`expected >= ${expectedToolCount} tools, got ${tools.length}`);
    }
    // 验证天火三件套已注册
    const toolNames = tools.map((t) => t.name);
    for (const required of ['awkn_tianhuo_start', 'awkn_tianhuo_advance', 'awkn_tianhuo_status']) {
      if (!toolNames.includes(required)) {
        throw new Error(`missing required tianhuo tool: ${required}`);
      }
    }
    console.log(`\n✅ PASS: ${tools.length} tools registered, tianhuo trio present, ${hasTianhuoPackage ? 'workflow completes via package TianhuoRouter' : 'degraded error verified (package missing)'}`);
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500);
  }
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
