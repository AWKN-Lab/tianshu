#!/usr/bin/env tsx
/**
 * M1 验证 — bridge-daemon.ts 端到端（mock 模式）
 *
 * 验证 bridge-daemon 能：
 * 1. 轮询 BRIDGE_DIR 监听 req-*.json
 * 2. 读取请求
 * 3. 调用 LLM（mock 模式返回 canned content）
 * 4. 写回 resp-*.json
 * 5. 错误请求写 error resp（不等 trae 120s timeout）
 * 6. 优雅关闭（SIGINT）
 *
 * 策略：用子进程启动 daemon（mock 模式），写 req 文件，轮询 resp 文件
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

/** 等待文件出现（轮询） */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * 等待 daemon 启动就绪（监听 stdout 出现 "Press Ctrl+C to stop"）
 *
 * npx tsx 启动需要 1-3 秒（TS 编译 + 模块加载），单纯 sleep 1s 不可靠。
 * 通过监听 daemon 的 stdout 输出 "Press Ctrl+C to stop" 判断已进入主循环。
 */
async function waitForDaemonReady(
  daemon: { stdout: NodeJS.EventEmitter; stderr: NodeJS.EventEmitter },
  timeoutMs = 10000,
): Promise<boolean> {
  let output = '';
  const collect = (d: Buffer | string): void => {
    output += d.toString();
  };
  daemon.stdout.on('data', collect);
  daemon.stderr.on('data', collect);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (output.includes('Press Ctrl+C to stop')) {
      // 移除监听器避免内存泄漏
      daemon.stdout.removeListener('data', collect);
      daemon.stderr.removeListener('data', collect);
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  daemon.stdout.removeListener('data', collect);
  daemon.stderr.removeListener('data', collect);
  return false;
}

async function main(): Promise<void> {
  console.log('=== M1 验证：bridge-daemon.ts 端到端（mock 模式）===\n');

  // ─── 1. 静态：源码结构检查 ───────────────────────────────────
  console.log('[1] 静态：bridge-daemon.ts 源码结构');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'scripts', 'bridge-daemon.ts'),
      'utf-8',
    );
    assert(src.includes('AWKN_BRIDGE_MOCK'), '应支持 AWKN_BRIDGE_MOCK mock 模式');
    assert(src.includes('AWKN_BRIDGE_PROVIDER'), '应支持 AWKN_BRIDGE_PROVIDER 选择');
    assert(src.includes('CodexProvider'), '应导入 CodexProvider');
    assert(src.includes('MiniMaxProvider'), '应导入 MiniMaxProvider');
    // 不应用 trae（循环依赖）
    assert(!src.includes('TraeProvider'), '不应导入 TraeProvider（循环依赖：trae→fileBridge→req→daemon）');
    assert(src.includes('SIGINT'), '应处理 SIGINT 优雅关闭');
    assert(src.includes('SIGTERM'), '应处理 SIGTERM 优雅关闭');
    assert(src.includes('error'), '失败时应写 error resp');
    assert(src.includes('processReqFile'), '应有 processReqFile 函数');
    assert(src.includes('running'), '应有 running 标志控制轮询循环');
  }

  // ─── 2. 端到端：mock 模式正常请求 ────────────────────────────
  console.log('\n[2] 端到端：mock 模式正常请求（写 req → daemon 处理 → 读 resp）');
  {
    const bridgeDir = resolve(process.cwd(), 'data', `test-bridge-daemon-${Date.now()}`);
    mkdirSync(bridgeDir, { recursive: true });

    // 启动 daemon（mock 模式）
    const daemon = spawn('npx', ['tsx', 'scripts/bridge-daemon.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AWKN_BRIDGE_MOCK: '1',
        AWKN_LLM_BRIDGE_DIR: bridgeDir,
        AWKN_BRIDGE_POLL_MS: '200',
        AWKN_BRIDGE_MOCK_CONTENT: 'test-mock-content-12345',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let daemonOutput = '';
    daemon.stdout.on('data', (d) => { daemonOutput += d.toString(); });
    daemon.stderr.on('data', (d) => { daemonOutput += d.toString(); });

    // 等 daemon 启动就绪（监听 "Press Ctrl+C to stop"）
    const ready = await waitForDaemonReady(daemon, 10000);
    assert(ready, 'daemon 应在 10s 内启动就绪');

    // 写 req 文件
    const reqId = randomUUID();
    const reqPath = resolve(bridgeDir, `req-${reqId}.json`);
    const respPath = resolve(bridgeDir, `resp-${reqId}.json`);
    writeFileSync(reqPath, JSON.stringify({
      id: reqId,
      messages: [{ role: 'user', content: 'hello from test' }],
      model: 'test-model',
      createdAt: new Date().toISOString(),
    }));

    // 等 resp 文件出现（5s timeout）
    const found = await waitForFile(respPath, 5000);

    assert(found, 'resp 文件应在 5s 内出现');

    if (found) {
      const resp = JSON.parse(readFileSync(respPath, 'utf-8'));
      assert(typeof resp.content === 'string', 'resp 应含 content 字段（string）');
      assert(resp.content === 'test-mock-content-12345', `resp content 应为 mock 内容，实际: ${resp.content}`);
      assert(resp.usage !== undefined, 'resp 应含 usage 字段');
    }

    // 关闭 daemon
    daemon.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 500));

    // 清理
    rmSync(bridgeDir, { recursive: true, force: true });
  }

  // ─── 3. 端到端：错误请求写 error resp ────────────────────────
  console.log('\n[3] 端到端：错误 JSON 请求写 error resp（不等 trae 120s timeout）');
  {
    const bridgeDir = resolve(process.cwd(), 'data', `test-bridge-err-${Date.now()}`);
    mkdirSync(bridgeDir, { recursive: true });

    const daemon = spawn('npx', ['tsx', 'scripts/bridge-daemon.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AWKN_BRIDGE_MOCK: '1',
        AWKN_LLM_BRIDGE_DIR: bridgeDir,
        AWKN_BRIDGE_POLL_MS: '200',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    await waitForDaemonReady(daemon, 10000);

    // 写无效 JSON 的 req 文件
    const reqId = randomUUID();
    const reqPath = resolve(bridgeDir, `req-${reqId}.json`);
    const respPath = resolve(bridgeDir, `resp-${reqId}.json`);
    writeFileSync(reqPath, 'this is not valid json {{{{');

    const found = await waitForFile(respPath, 5000);
    assert(found, '错误请求也应在 5s 内写 resp（不等 timeout）');

    if (found) {
      const resp = JSON.parse(readFileSync(respPath, 'utf-8'));
      assert(resp.error !== undefined, 'error resp 应含 error 字段');
      assert(resp.error.includes('parse error') || resp.error.includes('JSON'), 'error message 应含 parse error 信息');
    }

    daemon.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 500));
    rmSync(bridgeDir, { recursive: true, force: true });
  }

  // ─── 4. 端到端：多请求顺序处理 ────────────────────────────────
  console.log('\n[4] 端到端：多请求顺序处理（3 个 req → 3 个 resp）');
  {
    const bridgeDir = resolve(process.cwd(), 'data', `test-bridge-multi-${Date.now()}`);
    mkdirSync(bridgeDir, { recursive: true });

    const daemon = spawn('npx', ['tsx', 'scripts/bridge-daemon.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AWKN_BRIDGE_MOCK: '1',
        AWKN_LLM_BRIDGE_DIR: bridgeDir,
        AWKN_BRIDGE_POLL_MS: '200',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    await waitForDaemonReady(daemon, 10000);

    // 写 3 个 req 文件
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      writeFileSync(resolve(bridgeDir, `req-${id}.json`), JSON.stringify({
        id,
        messages: [{ role: 'user', content: `request-${id}` }],
        model: 'test',
        createdAt: new Date().toISOString(),
      }));
    }

    // 等 3 个 resp 都出现
    let allFound = false;
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const allExist = ids.every((id) => existsSync(resolve(bridgeDir, `resp-${id}.json`)));
      if (allExist) { allFound = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }

    assert(allFound, '3 个 req 都应在 10s 内得到 resp');

    if (allFound) {
      for (const id of ids) {
        const resp = JSON.parse(readFileSync(resolve(bridgeDir, `resp-${id}.json`), 'utf-8'));
        assert(typeof resp.content === 'string', `resp-${id} 应含 content`);
      }
    }

    daemon.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 500));
    rmSync(bridgeDir, { recursive: true, force: true });
  }

  // ─── 5. 端到端：daemon 不导入 trae（防循环依赖）──────────────
  console.log('\n[5] 端到端：daemon 不导入 TraeProvider（防循环依赖）');
  {
    const src = readFileSync(
      resolve(process.cwd(), 'scripts', 'bridge-daemon.ts'),
      'utf-8',
    );
    // 检查 import 语句不含 TraeProvider
    const importLines = src.split('\n').filter((l) => l.startsWith('import'));
    const hasTraeImport = importLines.some((l) => l.includes('TraeProvider'));
    assert(!hasTraeImport, 'import 语句不应含 TraeProvider');
    // 检查注释说明循环依赖
    assert(src.includes('循环依赖'), '应有注释说明不用 trae 的原因（循环依赖）');
  }

  // ─── 汇总 ─────────────────────────────────────────────────────
  console.log('\n=== 汇总 ===');
  console.log(`通过: ${pass}, 失败: ${fail}`);
  if (fail > 0) {
    console.log('\n失败项:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log('\n✅ M1 验证全部通过 — bridge-daemon mock 模式端到端验证正确');
  // 强制退出：daemon 子进程可能仍在事件循环中（spawn 子进程未完全退出）
  process.exit(0);
}

main().catch((err) => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
