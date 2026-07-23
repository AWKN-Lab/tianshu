/**
 * Cron Jobs Manager 测试 — 验证 CRUD + cron 表达式校验
 *
 * 用 node:test，独立 SQLite 文件避免污染默认 db
 * 运行：node --import tsx --test test/cron-jobs-manager.test.ts
 *
 * 覆盖：
 * 1. validateCronExpr / computeNextRun 纯函数
 * 2. add 合法任务 + 字段完整性
 * 3. add 非法 cron 表达式抛错
 * 4. add 缺参抛错
 * 5. list 排序 + enabledOnly 过滤
 * 6. setEnabled enable/disable 切换
 * 7. remove 任务 + 日志清理
 * 8. actionPayload JSON 序列化往返
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import {
  CronJobsManager,
  validateCronExpr,
  computeNextRun,
} from '../src/cron/jobs-manager.js';
import { getDb, closeDb, queryRun } from '../src/store/db.js';

// 用临时 db 文件，避免污染 runtime/data/awkn-engine.db
// 每个测试套件用独立路径，beforeEach 清空表保证 it 之间隔离
const TEST_DB_PATH = resolve(
  process.cwd(),
  'data',
  `test-cron-${process.pid}.db`,
);

beforeEach(() => {
  // 重置 db 单例 + 用临时路径初始化新 db（schema 自动建表）
  closeDb();
  if (existsSync(TEST_DB_PATH)) {
    // 已有 db 文件，删了重建确保 it 之间隔离
    rmSync(TEST_DB_PATH);
    // WAL 模式会产生 -wal 和 -shm 文件，一起删
    try { rmSync(`${TEST_DB_PATH}-wal`); } catch { /* ignore */ }
    try { rmSync(`${TEST_DB_PATH}-shm`); } catch { /* ignore */ }
  }
  getDb(TEST_DB_PATH);
});

afterEach(() => {
  // 清空表数据（防止 it 间污染；保留 schema）
  try {
    queryRun('DELETE FROM cron_run_log');
    queryRun('DELETE FROM cron_jobs');
  } catch {
    // 忽略（可能 db 已关）
  }
  closeDb();
});

describe('validateCronExpr — 纯函数', () => {
  it('合法 5 段 cron → null', () => {
    assert.equal(validateCronExpr('0 * * * *'), null);
    assert.equal(validateCronExpr('*/5 * * * *'), null);
    assert.equal(validateCronExpr('0 0 1 * *'), null);
    assert.equal(validateCronExpr('0 0 * * 0'), null);
  });

  it('非法 cron → 错误信息', () => {
    assert.ok(validateCronExpr('invalid'));
    assert.ok(validateCronExpr('99 * * * *')); // 分钟段越界
    assert.ok(validateCronExpr('')); // 空字符串（业务禁止）
    // 注：cron-parser 对 4 段 '*' 表达式表现宽容（按 5 段补默认），不在断言范围
  });
});

describe('computeNextRun — 纯函数', () => {
  it('合法 cron → ISO 字符串', () => {
    const next = computeNextRun('0 * * * *');
    assert.ok(next !== null);
    // 必须是合法 ISO
    assert.ok(!Number.isNaN(Date.parse(next)));
  });

  it('非法 cron → null', () => {
    assert.equal(computeNextRun('invalid'), null);
  });
});

describe('CronJobsManager.add', () => {
  it('合法任务 → 写入成功 + 字段完整', () => {
    const m = new CronJobsManager();
    const job = m.add({
      name: '每小时健康检查',
      cronExpr: '0 * * * *',
      actionType: 'http',
      actionPayload: { url: 'http://localhost:9000/health', method: 'GET' },
    });

    assert.ok(job.id);
    assert.equal(job.name, '每小时健康检查');
    assert.equal(job.cron_expr, '0 * * * *');
    assert.equal(job.action_type, 'http');
    assert.equal(job.enabled, 1);
    assert.equal(job.run_count, 0);
    assert.ok(job.next_run_at);
    assert.ok(job.created_at);
    assert.equal(job.updated_at, job.created_at);
    assert.deepEqual(job.parsedPayload, { url: 'http://localhost:9000/health', method: 'GET' });
  });

  it('payload 字符串 → 自动解析', () => {
    const m = new CronJobsManager();
    const job = m.add({
      name: 'tool 任务',
      cronExpr: '*/10 * * * *',
      actionType: 'tool',
      actionPayload: '{"toolName":"awkn-审核","input":"scan"}',
    });
    assert.deepEqual(job.parsedPayload, { toolName: 'awkn-审核', input: 'scan' });
  });

  it('显式 id → 用传入 id', () => {
    const m = new CronJobsManager();
    const job = m.add({
      id: 'job-fixed-001',
      name: 'test',
      cronExpr: '0 0 * * *',
      actionType: 'script',
      actionPayload: { command: 'echo hi' },
    });
    assert.equal(job.id, 'job-fixed-001');
  });

  it('非法 cron → 抛错', () => {
    const m = new CronJobsManager();
    assert.throws(
      () => m.add({ name: 'x', cronExpr: 'invalid', actionType: 'http' }),
      /无效 cron 表达式/,
    );
  });

  it('缺 name → 抛错', () => {
    const m = new CronJobsManager();
    assert.throws(
      () => m.add({ name: '', cronExpr: '0 * * * *', actionType: 'http' }),
      /name 不能为空/,
    );
  });

  it('enabled=false → 写入 enabled=0 且 next_run_at=null', () => {
    const m = new CronJobsManager();
    const job = m.add({
      name: '禁用任务',
      cronExpr: '0 * * * *',
      actionType: 'http',
      actionPayload: {},
      enabled: false,
    });
    assert.equal(job.enabled, 0);
    assert.equal(job.next_run_at, null);
  });
});

describe('CronJobsManager.list', () => {
  it('多任务按 created_at 倒序', () => {
    const m = new CronJobsManager();
    m.add({ name: 'first', cronExpr: '0 * * * *', actionType: 'http' });
    m.add({ name: 'second', cronExpr: '0 * * * *', actionType: 'http' });
    m.add({ name: 'third', cronExpr: '0 * * * *', actionType: 'http' });
    const all = m.list();
    assert.equal(all.length, 3);
    // 倒序：third 应该在 first 之前
    assert.equal(all[0].name, 'third');
    assert.equal(all[2].name, 'first');
  });

  it('enabledOnly 过滤', () => {
    const m = new CronJobsManager();
    m.add({ name: 'enabled', cronExpr: '0 * * * *', actionType: 'http' });
    m.add({ name: 'disabled', cronExpr: '0 * * * *', actionType: 'http', enabled: false });
    const enabledOnly = m.list({ enabledOnly: true });
    assert.equal(enabledOnly.length, 1);
    assert.equal(enabledOnly[0].name, 'enabled');
  });

  it('空表 → 返回空数组', () => {
    const m = new CronJobsManager();
    assert.deepEqual(m.list(), []);
  });
});

describe('CronJobsManager.setEnabled', () => {
  it('disable → enabled=0', () => {
    const m = new CronJobsManager();
    const job = m.add({ name: 'x', cronExpr: '0 * * * *', actionType: 'http' });
    assert.equal(job.enabled, 1);
    const updated = m.setEnabled(job.id, false);
    assert.equal(updated?.enabled, 0);
    assert.equal(updated?.next_run_at, null);
  });

  it('enable → enabled=1 且 next_run_at 重新计算', () => {
    const m = new CronJobsManager();
    const job = m.add({ name: 'x', cronExpr: '0 * * * *', actionType: 'http', enabled: false });
    const updated = m.setEnabled(job.id, true);
    assert.equal(updated?.enabled, 1);
    assert.ok(updated?.next_run_at);
  });

  it('不存在的 id → 返回 null', () => {
    const m = new CronJobsManager();
    assert.equal(m.setEnabled('not-exist', true), null);
  });
});

describe('CronJobsManager.remove', () => {
  it('存在任务 → 删除并清理日志', () => {
    const m = new CronJobsManager();
    const job = m.add({ name: 'x', cronExpr: '0 * * * *', actionType: 'http' });
    const result = m.remove(job.id);
    assert.equal(result.deleted, true);
    // 再次读应为 null
    assert.equal(m.read(job.id), null);
  });

  it('不存在任务 → deleted=false', () => {
    const m = new CronJobsManager();
    const result = m.remove('not-exist');
    assert.equal(result.deleted, false);
    assert.equal(result.logsRemoved, 0);
  });
});
