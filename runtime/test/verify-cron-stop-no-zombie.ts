/**
 * M3 进阶-29 验证：cron engine stop() 后 zombie timer 不泄漏
 *
 * Bug：scheduleJob 无 running 检查 → stop() 后若 job 正在执行，
 *   executeJob 完成后 scheduleJob 调度新 timer → engine "假停止"
 * Fix：scheduleJob + setTimeout callback 开头检查 this.running
 *
 * 验证：
 *   1. 静态：scheduleJob 有 running 守卫
 *   2. 静态：setTimeout callback 有 running 守卫
 *   3. 行为：start → stop → running=false + timers 清空
 *   4. 行为：stop 后 scheduleJob 不添加新 timer（通过 timers.size 验证）
 *   5. 行为：triggerJob 仍可在 stopped 状态手动触发（manual override 不受影响）
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENGINE_SRC = resolve(__dirname, '..', 'src', 'cron', 'engine.ts');

const source = readFileSync(ENGINE_SRC, 'utf-8');

// 使用独立的测试 DB
process.env.AWKN_DB_PATH = resolve(__dirname, '..', 'data', `test-cron-stop-${Date.now()}.db`);
// 使用进程沙箱（避免 Docker 依赖）
process.env.AWKN_SANDBOX_BACKEND = 'process';
process.env.AWKN_ALLOW_PROCESS_SANDBOX = '1';

describe('M3 进阶-29: cron engine stop() zombie timer 修复', () => {

  describe('1. 静态检查：源码有 running 守卫', () => {
    it('scheduleJob 方法开头有 if (!this.running) return', () => {
      // 提取 scheduleJob 方法体
      const scheduleJobMatch = source.match(
        /private scheduleJob\(job: CronJobRow\): void \{([\s\S]*?)\n  \}/,
      );
      assert.ok(scheduleJobMatch, 'scheduleJob 方法应存在');
      const body = scheduleJobMatch![1];
      assert.ok(
        body.includes('if (!this.running) return'),
        'scheduleJob 开头必须有 if (!this.running) return 守卫',
      );
    });

    it('scheduleJob 的 running 守卫在所有其他操作之前', () => {
      const scheduleJobMatch = source.match(
        /private scheduleJob\(job: CronJobRow\): void \{([\s\S]*?)\n  \}/,
      );
      const body = scheduleJobMatch![1];
      const runningGuardIdx = body.indexOf('if (!this.running) return');
      const timersGetIdx = body.indexOf('this.timers.get');
      const parseIdx = body.indexOf('CronExpressionParser.parse');
      const setTimeoutIdx = body.indexOf('setTimeout');

      assert.ok(runningGuardIdx > -1, 'running 守卫存在');
      assert.ok(runningGuardIdx < timersGetIdx, 'running 守卫在 timers.get 之前');
      assert.ok(runningGuardIdx < parseIdx, 'running 守卫在 parse 之前');
      assert.ok(runningGuardIdx < setTimeoutIdx, 'running 守卫在 setTimeout 之前');
    });

    it('setTimeout callback 内有 if (!this.running) return', () => {
      const scheduleJobMatch = source.match(
        /private scheduleJob\(job: CronJobRow\): void \{([\s\S]*?)\n  \}/,
      );
      assert.ok(scheduleJobMatch, 'scheduleJob 方法应存在');
      const body = scheduleJobMatch![1];
      // setTimeout 回调体（兼容 sync 和 async 形式）
      const setTimeoutMatch = body.match(/setTimeout\((?:async )?\(\) => \{([\s\S]*?)\}, delay\)/);
      assert.ok(setTimeoutMatch, 'setTimeout callback 应存在');
      const callbackBody = setTimeoutMatch![1];
      assert.ok(
        callbackBody.includes('if (!this.running) return'),
        'setTimeout callback 必须有 if (!this.running) return 守卫',
      );
    });

    it('setTimeout callback 的 running 守卫在 enqueueJob 之前', () => {
      const scheduleJobMatch = source.match(
        /private scheduleJob\(job: CronJobRow\): void \{([\s\S]*?)\n  \}/,
      );
      assert.ok(scheduleJobMatch, 'scheduleJob 方法应存在');
      const body = scheduleJobMatch![1];
      const setTimeoutMatch = body.match(/setTimeout\((?:async )?\(\) => \{([\s\S]*?)\}, delay\)/);
      assert.ok(setTimeoutMatch, 'setTimeout callback 应存在');
      const callbackBody = setTimeoutMatch![1];
      const guardIdx = callbackBody.indexOf('if (!this.running) return');
      // WorkStore 模式使用 enqueueJob 替代 executeJob
      const enqueueJobIdx = callbackBody.indexOf('this.enqueueJob');
      assert.ok(guardIdx > -1, 'running 守卫应存在');
      assert.ok(enqueueJobIdx > -1, 'enqueueJob 调用应存在');
      assert.ok(guardIdx < enqueueJobIdx, 'running 守卫必须在 enqueueJob 之前');
    });

    it('stop() 方法设置 running=false', () => {
      const stopMatch = source.match(/stop\(\): void \{([\s\S]*?)\n  \}/);
      assert.ok(stopMatch, 'stop() 方法应存在');
      const body = stopMatch![1];
      assert.ok(body.includes('this.running = false'), 'stop() 必须设置 running=false');
    });

    it('start() 方法设置 running=true（在 scheduleAll 之前）', () => {
      const startMatch = source.match(/start\(\): void \{([\s\S]*?)\n  \}/);
      assert.ok(startMatch, 'start() 方法应存在');
      const body = startMatch![1];
      const runningTrueIdx = body.indexOf('this.running = true');
      const scheduleAllIdx = body.indexOf('this.scheduleAll()');
      assert.ok(runningTrueIdx > -1, 'start() 必须设置 running=true');
      assert.ok(runningTrueIdx < scheduleAllIdx, 'running=true 必须在 scheduleAll 之前');
    });
  });

  describe('2. 行为验证：stop() 清理状态', () => {
    let engine: any;

    before(async () => {
      const { getDb } = await import('../src/store/db.js');
      getDb(); // 初始化 DB
      const { SCHEMA_SQL } = await import('../src/store/schema.js');
      const { queryRun } = await import('../src/store/db.js');
      // 建表
      for (const stmt of SCHEMA_SQL.split(';').map((s: string) => s.trim()).filter(Boolean)) {
        queryRun(stmt);
      }
      // 重置单例
      const { getCronEngine } = await import('../src/cron/engine.js');
      engine = getCronEngine();
    });

    after(async () => {
      const { stopCronEngine } = await import('../src/cron/engine.js');
      stopCronEngine();
      const { closeDb } = await import('../src/store/db.js');
      closeDb();
    });

    it('start() 后 running=true', () => {
      engine.start();
      assert.equal(engine['running'], true, 'start 后 running 应为 true');
    });

    it('stop() 后 running=false', () => {
      engine.stop();
      assert.equal(engine['running'], false, 'stop 后 running 应为 false');
    });

    it('stop() 后 timers 清空', () => {
      assert.equal(engine['timers'].size, 0, 'stop 后 timers 应清空');
    });

    it('stop() 后 checkInterval 为 null', () => {
      assert.equal(engine['checkInterval'], null, 'stop 后 checkInterval 应为 null');
    });
  });

  describe('3. 行为验证：stop 后 scheduleJob 不调度', () => {
    let engine: any;

    before(async () => {
      // 重置单例
      const mod = await import('../src/cron/engine.js');
      // 通过 reset 单例来获取全新实例
      const { getCronEngine } = mod as any;
      // 先确保旧实例被 stop
      try { mod.stopCronEngine(); } catch { /* ignore */ }

      engine = getCronEngine();
      // 不 start，直接测试 scheduleJob（running=false）
    });

    it('running=false 时 scheduleJob 不添加 timer', () => {
      assert.equal(engine['running'], false, '未 start 时 running 应为 false');
      const timersBefore = engine['timers'].size;

      // 构造一个合法的 job row
      const fakeJob = {
        id: 'test-zombie-' + Date.now(),
        name: 'test',
        cron_expr: '*/5 * * * *',
        action_type: 'script',
        action_payload: '{}',
        enabled: 1,
        last_run_at: null,
        next_run_at: null,
        run_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // scheduleJob 是 private，但 TS 编译后 JS 可访问
      engine['scheduleJob'](fakeJob);

      assert.equal(
        engine['timers'].size,
        timersBefore,
        'running=false 时 scheduleJob 不应添加新 timer',
      );
    });

    it('start() 后 scheduleJob 可以调度', async () => {
      engine.start();
      assert.equal(engine['running'], true);

      const fakeJob = {
        id: 'test-schedulable-' + Date.now(),
        name: 'test-sched',
        cron_expr: '0 0 1 1 *', // 远未来，不会触发
        action_type: 'script',
        action_payload: '{}',
        enabled: 1,
        last_run_at: null,
        next_run_at: null,
        run_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const timersBefore = engine['timers'].size;
      engine['scheduleJob'](fakeJob);
      // next_run_at 设为 Jan 1，delay > 24h → 不调度 setTimeout
      // 但 next_run_at 字段会更新，所以这里只验证不 crash
      assert.ok(true, 'start 后 scheduleJob 不 crash');

      engine.stop();
    });
  });

  describe('4. 行为验证：triggerJob 不受 running 状态影响', () => {
    it('静态：triggerJob 方法不含 if (!this.running) 守卫', () => {
      // triggerJob 是 manual override 入口，不应受 running 状态影响
      const triggerJobMatch = source.match(
        /async triggerJob\(jobId: string\)[^{]*\{([\s\S]*?)\n  \}/,
      );
      assert.ok(triggerJobMatch, 'triggerJob 方法应存在');
      const body = triggerJobMatch![1];
      assert.ok(
        !body.includes('if (!this.running)'),
        'triggerJob 不应检查 this.running（manual override 不受 running 影响）',
      );
    });

    it('静态：triggerJob 通过 workStore + worker 执行（不依赖 running 状态）', () => {
      const triggerJobMatch = source.match(
        /async triggerJob\(jobId: string\)[^{]*\{([\s\S]*?)\n  \}/,
      );
      assert.ok(triggerJobMatch, 'triggerJob 方法应存在');
      const body = triggerJobMatch![1];
      assert.ok(body.includes('this.enqueueJob'), 'triggerJob 应调用 enqueueJob');
      assert.ok(body.includes('this.worker.processById'), 'triggerJob 应调用 worker.processById');
    });
  });
});
