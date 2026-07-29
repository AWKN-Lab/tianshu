#!/usr/bin/env tsx
/**
 * M1 验证 — bridge-daemon.ts 端到端（mock 模式）
 *
 * PR1 P2-2 重写：
 * - 使用 process.execPath --import tsx 启动（shell:false），替代 spawn('npx', ['tsx', ...], { shell: true })
 * - daemon 输出确定性 ready 标记（BRIDGE_DAEMON_READY），测试使用 waitForReady 等待 marker，不固定 sleep
 * - 每个场景独立进程；关闭时发送 SIGINT，等待 exit 事件（带 timeout），finally 清理临时目录
 * - 场景内断言失败时打印捕获的 stdout/stderr 以便排查
 *
 * 验证 bridge-daemon 能：
 * 1. 轮询 BRIDGE_DIR 监听 req-*.json
 * 2. 读取请求
 * 3. 调用 LLM（mock 模式返回 canned content）
 * 4. 写回 resp-*.json
 * 5. 错误请求写 error resp（不等 trae 120s timeout）
 * 6. 优雅关闭（SIGINT）
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
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

/** 等待子进程 exit（带 timeout，超时 SIGKILL） */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }
      resolve();
    }, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * 等待 stdout 流上出现包含 marker 的行。
 * 当某一行包含 marker 时 resolve；若超时或流提前结束则 reject。
 */
function waitForReady(stdoutStream: Readable, marker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: stdoutStream });
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rl.close();
        reject(new Error(`Timeout waiting for ready marker: ${marker}`));
      }
    }, timeoutMs);

    rl.on('line', (line) => {
      if (!settled && line.includes(marker)) {
        settled = true;
        clearTimeout(timer);
        rl.close();
        resolve();
      }
    });

    rl.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Stdout closed before ready marker: ${marker}`));
      }
    });

    rl.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

interface DaemonHandle {
  process: ChildProcess;
  bridgeDir: string;
  marker: string;
  getStdout: () => string;
  getStderr: () => string;
  shutdown: () => Promise<void>;
}

/**
 * 启动 daemon 并等待 ready 标记。
 * 使用 process.execPath --import tsx + shell:false。
 */
async function startDaemon(
  bridgeDir: string,
  envOverrides: Record<string, string> = {},
): Promise<DaemonHandle> {
  const daemon = spawn(
    process.execPath,
    ['--import', 'tsx', resolve(process.cwd(), 'scripts', 'bridge-daemon.ts')],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AWKN_BRIDGE_MOCK: '1',
        AWKN_LLM_BRIDGE_DIR: bridgeDir,
        AWKN_BRIDGE_POLL_MS: '200',
        AWKN_BRIDGE_MOCK_CONTENT: 'test-mock-content-12345',
        ...envOverrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    },
  );

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  daemon.stdout.on('data', (d: Buffer) => { stdoutChunks.push(d.toString()); });
  daemon.stderr.on('data', (d: Buffer) => { stderrChunks.push(d.toString()); });

  const marker = envOverrides.AWKN_BRIDGE_READY_MARKER ?? 'BRIDGE_DAEMON_READY';

  try {
    await waitForReady(daemon.stdout, marker, 10_000);
  } catch (err) {
    if (!daemon.killed) {
      try { daemon.kill('SIGKILL'); } catch { /* already exited */ }
    }
    throw new Error(
      `daemon not ready within 10s\n--- stdout ---\n${stdoutChunks.join('')}\n--- stderr ---\n${stderrChunks.join('')}\n--- cause ---\n${String(err)}`,
    );
  }

  return {
    process: daemon,
    bridgeDir,
    marker,
    getStdout: () => stdoutChunks.join(''),
    getStderr: () => stderrChunks.join(''),
    shutdown: async (): Promise<void> => {
      if (!daemon.killed && daemon.exitCode === null) {
        try { daemon.kill('SIGINT'); } catch { /* already exited */ }
        await waitForExit(daemon, 5_000);
      }
    },
  };
}

/** 打印 daemon 输出，用于调试失败的场景 */
function printDaemonLogs(handle: DaemonHandle): void {
  console.error('  --- daemon stdout ---');
  console.error(handle.getStdout());
  console.error('  --- daemon stderr ---');
  console.error(handle.getStderr());
}

async function main(): Promise<void> {
  console.log('=== M1 验证：bridge-daemon.ts 端到端（mock 模式，PR1 P2-2 重写）===\n');

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
    // PR1 P2-2: 验证 ready 标记输出
    assert(src.includes('BRIDGE_DAEMON_READY'), '应输出 BRIDGE_DAEMON_READY ready 标记');
  }

  // ─── 2. 端到端：mock 模式正常请求 ────────────────────────────
  console.log('\n[2] 端到端：mock 模式正常请求（写 req → daemon 处理 → 读 resp）');
  {
    const bridgeDir = resolve(process.cwd(), 'data', `test-bridge-daemon-${Date.now()}`);
    mkdirSync(bridgeDir, { recursive: true });

    const handle = await startDaemon(bridgeDir);
    try {
      // 验证 daemon 确实输出了 ready 标记
      assert(handle.getStdout().includes(handle.marker), `daemon stdout 应包含 ready marker "${handle.marker}"`);

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
      const found = await waitForFile(respPath, 5_000);
      assert(found, 'resp 文件应在 5s 内出现');

      if (found) {
        const resp = JSON.parse(readFileSync(respPath, 'utf-8'));
        assert(typeof resp.content === 'string', 'resp 应含 content 字段（string）');
        assert(resp.content === 'test-mock-content-12345', `resp content 应为 mock 内容，实际: ${resp.content}`);
        assert(resp.usage !== undefined, 'resp 应含 usage 字段');
      }
    } catch (err) {
      printDaemonLogs(handle);
      throw err;
    } finally {
      await handle.shutdown();
      rmSync(bridgeDir, { recursive: true, force: true });
    }
  }

  // ─── 3. 端到端：错误请求写 error resp ────────────────────────
  console.log('\n[3] 端到端：错误 JSON 请求写 error resp（不等 trae 120s timeout）');
  {
    const bridgeDir = resolve(process.cwd(), 'data', `test-bridge-err-${Date.now()}`);
    mkdirSync(bridgeDir, { recursive: true });

    const handle = await startDaemon(bridgeDir);
    try {
      // 写无效 JSON 的 req 文件
      const reqId = randomUUID();
      const reqPath = resolve(bridgeDir, `req-${reqId}.json`);
      const respPath = resolve(bridgeDir, `resp-${reqId}.json`);
      writeFileSync(reqPath, 'this is not valid json {{{{');

      const found = await waitForFile(respPath, 5_000);
      assert(found, '错误请求也应在 5s 内写 resp（不等 timeout）');

      if (found) {
        const resp = JSON.parse(readFileSync(respPath, 'utf-8'));
        assert(resp.error !== undefined, 'error resp 应含 error 字段');
        assert(resp.error.includes('parse error') || resp.error.includes('JSON'), 'error message 应含 parse error 信息');
      }
    } catch (err) {
      printDaemonLogs(handle);
      throw err;
    } finally {
      await handle.shutdown();
      rmSync(bridgeDir, { recursive: true, force: true });
    }
  }

  // ─── 4. 端到端：多请求顺序处理 ────────────────────────────────
  console.log('\n[4] 端到端：多请求顺序处理（3 个 req → 3 个 resp）');
  {
    const bridgeDir = resolve(process.cwd(), 'data', `test-bridge-multi-${Date.now()}`);
    mkdirSync(bridgeDir, { recursive: true });

    const handle = await startDaemon(bridgeDir);
    try {
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
      while (Date.now() - start < 10_000) {
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
    } catch (err) {
      printDaemonLogs(handle);
      throw err;
    } finally {
      await handle.shutdown();
      rmSync(bridgeDir, { recursive: true, force: true });
    }
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
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
