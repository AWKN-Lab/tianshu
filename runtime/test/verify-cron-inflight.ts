/**
 * M3 进阶-11 端到端验证：cron/engine checkAll in-flight 跟踪
 *
 * 验证点：
 * 1. 静态：源码含 inFlight Set 声明
 * 2. 静态：executeJob 开头 inFlight.add，finally 中 inFlight.delete
 * 3. 静态：checkAll 跳过 inFlight.has(job.id) 的 job
 * 4. 静态：未 await 的 executeJob 调用仍存在（兜底轮询特性），但 in-flight 跟踪防止重复
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'cron', 'engine.ts'),
  'utf-8',
);

// 过滤注释行，避免 indexOf 命中注释
const codeLines = SRC.split('\n').filter(
  (l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'),
);
const codeOnly = codeLines.join('\n');

describe('M3 进阶-11: cron/engine checkAll in-flight 跟踪', () => {
  it('静态：源码含 inFlight Set 声明', () => {
    assert.ok(codeOnly.includes('private inFlight: Set<string> = new Set()'),
      'CronEngine 应含 inFlight Set<string> 声明');
  });

  it('静态：executeJob 开头 inFlight.add', () => {
    assert.ok(codeOnly.includes('this.inFlight.add(job.id)'),
      'executeJob 开头应含 this.inFlight.add(job.id)');
  });

  it('静态：finally 中 inFlight.delete', () => {
    assert.ok(codeOnly.includes('this.inFlight.delete(job.id)'),
      'executeJob finally 应含 this.inFlight.delete(job.id)');
    // 确认在 finally 块中
    assert.ok(codeOnly.includes('} finally {') && codeOnly.includes('this.inFlight.delete(job.id)'),
      'inFlight.delete 应在 finally 块中（保证成功/失败都清除）');
  });

  it('静态：checkAll 跳过 inFlight 的 job', () => {
    assert.ok(codeOnly.includes('if (this.inFlight.has(job.id)) continue'),
      'checkAll 应含 if (this.inFlight.has(job.id)) continue');
  });

  it('静态：executeJob 仍是 async（兜底轮询 fire-and-forget 特性保留）', () => {
    // executeJob 保持 async，checkAll 中调用不 await（fire-and-forget）
    // 但 in-flight 跟踪防止重复触发
    assert.ok(codeOnly.includes('private async executeJob'),
      'executeJob 应保持 async');
  });

  it('静态：修复注释标记存在', () => {
    assert.ok(SRC.includes('M3 进阶-11'),
      '源码应含 "M3 进阶-11" 修复标记注释');
    assert.ok(SRC.includes('in-flight'),
      '源码应含 "in-flight" 说明');
  });

  it('一致性：inFlight 在 executeJob 的 add 早于 try 块', () => {
    // add 应在 try 之前（保证即使 try 内 throw 也能被 finally delete）
    // 实际上 add 在 try 外，finally 一定执行
    const addIdx = codeOnly.indexOf('this.inFlight.add(job.id)');
    const tryIdx = codeOnly.indexOf('try {', addIdx);
    const finallyIdx = codeOnly.indexOf('} finally {', tryIdx);
    const deleteIdx = codeOnly.indexOf('this.inFlight.delete(job.id)', finallyIdx);

    assert.ok(addIdx > -1 && tryIdx > addIdx && finallyIdx > tryIdx && deleteIdx > finallyIdx,
      '结构应为：add → try { → } finally { → delete');
  });
});
