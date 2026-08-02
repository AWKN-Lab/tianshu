/**
 * queue-worker 高压压力测试（P95 遗留项 Phase C）
 *
 * 场景：8 个并行 worker（不同 owner，模拟多进程/多实例）共享同一 queue，
 * 每个 worker 入队 10 个必败项 → 80 项；handler 每次都失败（nack → retry）。
 * 断言：
 *  - 全部 80 项最终 done（不丢失、不卡死）
 *  - 每项耗尽 maxAttempts（默认 3 次尝试）→ handler 调用总数 = 80 × 3 = 240
 *  - inProgress 归零
 * 运行 3 轮。隔离 temp db，不碰正式数据。
 *
 * 用法: node --import tsx scripts/stress-queue-worker.ts
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/store/db.js';
import { enqueue, queueStats } from '../src/store/queue.js';
import { startAsyncWorker } from '../src/memory/async-worker.js';

const ROUNDS = 3;
const WORKERS = 8;
const ITEMS_PER_WORKER = 10;
const MAX_ATTEMPTS = 3;
const POLL_MS = 5;
const RETRY_MS = 1;

async function until(fn: () => boolean, timeoutMs = 20_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error(`timeout waiting for condition (${timeoutMs}ms)`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function runRound(round: number): Promise<void> {
  const dbDir = await mkdtemp(join(tmpdir(), 'queue-stress-'));
  const dbPath = join(dbDir, 'stress.db');
  process.env.AWKN_DB_PATH = dbPath;
  closeDb();
  getDb();

  const queueName = `stress-q-${round}`;
  const workerHandles: ReturnType<typeof startAsyncWorker>[] = [];
  const handlerCalls = { count: 0 };

  for (let w = 0; w < WORKERS; w++) {
    workerHandles.push(
      startAsyncWorker({
        queueName,
        owner: `stress-worker-${w}`,
        handler: async () => {
          handlerCalls.count++;
          await new Promise((resolve) => setTimeout(resolve, 1 + Math.random() * 4));
          throw new Error(`transient stress failure (round ${round}, worker ${w})`);
        },
        pollIntervalMs: POLL_MS,
        leaseMs: 30_000,
        batch: 4,
        retryDelayMs: RETRY_MS,
      }),
    );
  }

  for (let w = 0; w < WORKERS; w++) {
    for (let i = 0; i < ITEMS_PER_WORKER; i++) {
      enqueue(queueName, { round, worker: w, index: i }, { maxAttempts: MAX_ATTEMPTS });
    }
  }

  const started = Date.now();
  await until(() => queueStats(queueName).done === WORKERS * ITEMS_PER_WORKER);
  const elapsed = Date.now() - started;

  const stats = queueStats(queueName);
  const expectedCalls = WORKERS * ITEMS_PER_WORKER * MAX_ATTEMPTS;
  const ok =
    stats.done === WORKERS * ITEMS_PER_WORKER &&
    stats.pending === 0 &&
    stats.inProgress === 0 &&
    handlerCalls.count === expectedCalls;

  for (const h of workerHandles) h.stop();
  closeDb();

  if (!ok) {
    throw new Error(
      `round ${round}: FAILED done=${stats.done}/${WORKERS * ITEMS_PER_WORKER} pending=${stats.pending} ` +
        `inProgress=${stats.inProgress} handlerCalls=${handlerCalls.count}/${expectedCalls}`,
    );
  }
  console.log(
    `round ${round}: PASS done=${stats.done} attempts=${handlerCalls.count} (${expectedCalls}) ` +
      `inProgress=${stats.inProgress} elapsed=${elapsed}ms`,
  );
}

async function main(): Promise<void> {
  for (let r = 1; r <= ROUNDS; r++) {
    await runRound(r);
  }
  console.log(`stress-queue-worker: ${ROUNDS}/${ROUNDS} rounds passed (8 workers x ${ITEMS_PER_WORKER} failing items each)`);
}

await main();
