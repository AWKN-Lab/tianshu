/**
 * M3 进阶-11 端到端验证：cron job 重复触发防护（重构为 WorkStore 幂等模式）
 *
 * 原始验证点：CronEngine.inFlight Set<string> 防止 checkAll 重复触发同一 job
 * 重构后：CronWorkStore 通过 INSERT OR IGNORE + idempotency_key UNIQUE 约束
 *        + 原子 lease 事务（claimNext 内 DB transaction）提供更强的跨进程幂等保证
 *
 * 验证点（适配 WorkStore 模式）：
 * 1. 静态：CronWorkStore 含 idempotency_key 字段
 * 2. 静态：enqueue 使用 INSERT OR IGNORE（幂等写入）
 * 3. 静态：claimNext 使用 DB transaction + WHERE status IN ('queued', 'retry') 原子租约
 * 4. 静态：recoverExpired 处理过期租约（替代 inFlight.delete 的 finally 语义）
 * 5. 静态：CronEngine.checkAll 通过 enqueueJob → workStore.enqueue 走幂等路径
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const workStoreSrc = readFileSync(
  resolve(__dirname, '..', 'src', 'cron', 'work-store.ts'),
  'utf-8',
);

const engineSrc = readFileSync(
  resolve(__dirname, '..', 'src', 'cron', 'engine.ts'),
  'utf-8',
);

describe('M3 进阶-11: cron job 重复触发防护（WorkStore 幂等模式）', () => {
  it('静态：CronWorkStore 含 idempotency_key 字段', () => {
    assert.ok(workStoreSrc.includes('idempotency_key'),
      'CronWorkStore 应含 idempotency_key 字段');
  });

  it('静态：enqueue 使用 INSERT OR IGNORE（幂等写入）', () => {
    assert.ok(workStoreSrc.includes('INSERT OR IGNORE'),
      'enqueue 应使用 INSERT OR IGNORE 防止重复入队');
  });

  it('静态：claimNext 使用 DB transaction 原子租约', () => {
    assert.ok(workStoreSrc.includes('this.db.transaction'),
      'claimNext 应使用 DB transaction 保证原子租约');
    assert.ok(workStoreSrc.includes("status = 'leased'"),
      'claimNext 应将状态设为 leased');
    assert.ok(workStoreSrc.includes("status IN ('queued', 'retry')"),
      'claimNext 只租约 queued/retry 状态的工作项');
  });

  it('静态：recoverExpired 处理过期租约（替代 inFlight.delete 的 finally 语义）', () => {
    assert.ok(workStoreSrc.includes('recoverExpired'),
      'CronWorkStore 应含 recoverExpired 方法');
    assert.ok(workStoreSrc.includes("lease_expires_at <= ?"),
      'recoverExpired 应检查 lease_expires_at');
    assert.ok(workStoreSrc.includes("status = 'retry'"),
      'recoverExpired 应将过期租约设为 retry');
  });

  it('静态：CronEngine.checkAll 通过 enqueueJob → workStore.enqueue 走幂等路径', () => {
    assert.ok(engineSrc.includes('enqueueJob'),
      'CronEngine 应含 enqueueJob 方法');
    assert.ok(engineSrc.includes('this.workStore.enqueue'),
      'enqueueJob 应调用 workStore.enqueue');
  });

  it('静态：CronEngine.start 调用 workStore.recoverExpired 恢复中断工作', () => {
    assert.ok(engineSrc.includes('this.workStore.recoverExpired()'),
      'start 应调用 workStore.recoverExpired() 恢复中断工作');
  });
});
