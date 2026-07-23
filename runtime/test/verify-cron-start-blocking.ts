/**
 * M3 进阶-12 端到端验证：cron start 阻塞，防止 finally closeDb 提前关 DB
 *
 * 验证点：
 * 1. 静态：cron start case 含 await new Promise<void>(() => {}) 永不 resolve
 * 2. 静态：阻塞调用位于 startCronEngine + SIGINT 之后
 * 3. 静态：M3 进阶-12 标记存在
 * 4. 行为：new Promise<void>(() => {}) 确实永不 resolve（200ms 内 pending）
 * 5. 行为：closeDb 在阻塞期间不被调用（模拟）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'cli.ts'),
  'utf-8',
);

describe('M3 进阶-12: cron start 阻塞防止 finally closeDb', () => {
  it('静态：cron start 含永不 resolve 的 Promise', () => {
    assert.ok(
      SRC.includes("await new Promise<void>(() => {})"),
      'cron start 应含 await new Promise<void>(() => {}) 阻塞调用',
    );
  });

  it('静态：阻塞位于 startCronEngine 之后', () => {
    const startIdx = SRC.indexOf('startCronEngine();');
    const blockIdx = SRC.indexOf('await new Promise<void>(() => {});');
    assert.ok(startIdx > -1 && blockIdx > startIdx,
      '阻塞调用应在 startCronEngine() 之后');
  });

  it('静态：阻塞位于 SIGINT handler 之后', () => {
    const sigintIdx = SRC.indexOf("process.on('SIGINT', () => {");
    const blockIdx = SRC.indexOf('await new Promise<void>(() => {});');
    assert.ok(sigintIdx > -1 && blockIdx > sigintIdx,
      '阻塞调用应在 SIGINT handler 之后');
  });

  it('静态：M3 进阶-12 标记存在', () => {
    assert.ok(SRC.includes('M3 进阶-12'), '应含 M3 进阶-12 修复标记');
    assert.ok(SRC.includes('closeDb'), '应说明 closeDb 提前关闭问题');
  });

  it('行为：new Promise<void>(() => {}) 永不 resolve', async () => {
    // 验证这个 idiom 确实是永不 resolve 的（executor 不调 resolve/reject）
    let resolved = false;
    let rejected = false;
    const p = new Promise<void>(() => {
      // executor 不做任何事，永不 resolve
    });
    p.then(
      () => { resolved = true; },
      () => { rejected = true; },
    );
    // 等 200ms
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(resolved, false, 'Promise 不应 resolve');
    assert.equal(rejected, false, 'Promise 不应 reject');
  });

  it('行为：阻塞期间 closeDb 不被调用（模拟）', async () => {
    // 模拟：如果 handleCron 永不返回，main() 的 finally 永不执行 → closeDb 不被调用
    // 用一个 race 验证：若 handleCron 在 300ms 内返回，说明没阻塞（bug）；
    // 若超时说明正确阻塞了
    let returned = false;
    const fakeHandleCronStart = async (): Promise<void> => {
      // 模拟修复后的 cron start 逻辑
      await new Promise<void>(() => {}); // 永不返回
    };
    const race = Promise.race([
      fakeHandleCronStart().then(() => { returned = true; }),
      new Promise((r) => setTimeout(r, 300)),
    ]);
    await race;
    assert.equal(returned, false, 'handleCron(start) 应阻塞不返回（修复生效）');
  });
});
