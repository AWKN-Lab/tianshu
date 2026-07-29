/**
 * Corrections Ledger 测试 — M3 自进化机制核心数据层
 *
 * 覆盖：
 * 1. normalizeErrorText 归一化（去 ANSI / 路径 / 时间戳 / UUID / 数字）
 * 2. computeFingerprint 指纹稳定性（同类错误 → 同指纹）
 * 3. record 写入 + 字段完整性 + 自动 fingerprint
 * 4. record 空错误文本抛错
 * 5. read / list 过滤（source / status / fingerprint / sinceHours）
 * 6. resolve 标记 + resolution 字段写入
 * 7. ignore 标记
 * 8. resolveByFingerprint 批量关闭
 * 9. countByFingerprint 聚合
 * 10. statsBySource 分组统计
 *
 * 运行：node --import tsx --test test/corrections-ledger.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import {
  CorrectionsLedger,
  normalizeErrorText,
  computeFingerprint,
} from '../src/evolve/corrections-ledger.js';
import { getDb, closeDb, queryRun } from '../src/store/db.js';

const TEST_DB_PATH = resolve(
  process.cwd(),
  'data',
  `test-corrections-${process.pid}.db`,
);

beforeEach(() => {
  closeDb();
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH);
    try { rmSync(`${TEST_DB_PATH}-wal`); } catch { /* ignore */ }
    try { rmSync(`${TEST_DB_PATH}-shm`); } catch { /* ignore */ }
  }
  getDb(TEST_DB_PATH);
});

afterEach(() => {
  try {
    queryRun('DELETE FROM corrections_ledger');
  } catch { /* ignore */ }
  closeDb();
});

// ─── 纯函数：normalizeErrorText ───────────────────────────────────

describe('normalizeErrorText', () => {
  it('去 ANSI 颜色码', () => {
    const text = '\x1b[31mError\x1b[0m: something failed';
    assert.equal(normalizeErrorText(text), 'error: something failed');
  });

  it('去绝对路径只保留 basename', () => {
    const text = 'File not found: D:\\awkn-lab\\awkn引擎\\runtime\\src\\cli.ts';
    const result = normalizeErrorText(text);
    // basename 保留，路径前缀去掉
    assert.ok(!result.includes('d:\\awkn-lab'));
    assert.ok(result.includes('cli.ts'));
  });

  it('去 ISO 时间戳', () => {
    const text = 'Failed at 2026-07-23T12:34:56.789Z with error';
    const result = normalizeErrorText(text);
    assert.ok(!result.includes('2026-07-23t12:34:56'));
    assert.ok(result.includes('<ts>'));
  });

  it('去 UUID', () => {
    const uuid = '227612b3-b8fa-47f2-b13f-0ad71f1fc299';
    const text = `Job ${uuid} failed`;
    const result = normalizeErrorText(text);
    assert.ok(!result.includes(uuid));
    assert.ok(result.includes('<uuid>'));
  });

  it('折叠空白 + 转小写', () => {
    const text = '  Multiple   Spaces  HERE  ';
    assert.equal(normalizeErrorText(text), 'multiple spaces here');
  });

  it('空字符串返回空', () => {
    assert.equal(normalizeErrorText(''), '');
    assert.equal(normalizeErrorText('   '), '');
  });
});

// ─── 纯函数：computeFingerprint ───────────────────────────────────

describe('computeFingerprint', () => {
  it('同类错误（仅时间戳/路径前缀不同，basename 相同）→ 同指纹', () => {
    // 注意：normalizeErrorText 会把绝对路径替换为 basename
    // 所以两个测试输入必须用相同 basename（a.ts）才能归一化到同指纹
    const fp1 = computeFingerprint('reviewGate', 'Failed at 2026-07-23T10:00:00Z in D:\\proj\\a.ts');
    const fp2 = computeFingerprint('reviewGate', 'Failed at 2026-07-23T11:30:00Z in D:\\other\\a.ts');
    assert.equal(fp1, fp2);
  });

  it('不同 source → 不同指纹', () => {
    const fp1 = computeFingerprint('reviewGate', 'same error');
    const fp2 = computeFingerprint('testGate', 'same error');
    assert.notEqual(fp1, fp2);
  });

  it('根本不同的错误 → 不同指纹', () => {
    const fp1 = computeFingerprint('reviewGate', 'review verdict missing');
    const fp2 = computeFingerprint('reviewGate', 'type check failed with 5 errors');
    assert.notEqual(fp1, fp2);
  });

  it('指纹长度 16（sha256 前 16 位）', () => {
    const fp = computeFingerprint('test', 'whatever');
    assert.equal(fp.length, 16);
  });
});

// ─── Manager: record + read ───────────────────────────────────────

describe('CorrectionsLedger.record', () => {
  it('preserves a validated upstream finding fingerprint', () => {
    const ledger = new CorrectionsLedger();
    const fingerprint = 'a'.repeat(64);
    const row = ledger.record({ source: 'review:CORRECTNESS', errorText: 'broken invariant', fingerprint });
    assert.equal(row.fingerprint, fingerprint);
    assert.throws(
      () => ledger.record({ source: 'review:CORRECTNESS', errorText: 'bad fingerprint', fingerprint: 'unsafe' }),
      /fingerprint/,
    );
  });
  it('写入 + 字段完整性 + 自动 fingerprint', () => {
    const ledger = new CorrectionsLedger();
    const row = ledger.record({
      source: 'reviewGate',
      severity: 'error',
      errorText: 'review verdict missing',
      context: { goalId: 'g-1', suggestion: '调 awkn-审核' },
    });
    assert.ok(row.id);
    assert.equal(row.source, 'reviewGate');
    assert.equal(row.severity, 'error');
    assert.equal(row.status, 'open');
    assert.equal(row.error_text, 'review verdict missing');
    assert.equal(row.fingerprint, computeFingerprint('reviewGate', 'review verdict missing'));
    assert.ok(JSON.parse(row.context_json).goalId === 'g-1');
    assert.ok(row.ts);
    assert.equal(row.resolution, null);
    assert.equal(row.experience_id, null);
  });

  it('severity 默认 error', () => {
    const ledger = new CorrectionsLedger();
    const row = ledger.record({ source: 'testGate', errorText: 'fail' });
    assert.equal(row.severity, 'error');
  });

  it('空 errorText 抛错', () => {
    const ledger = new CorrectionsLedger();
    assert.throws(
      () => ledger.record({ source: 'testGate', errorText: '' }),
      /errorText 不能为空/,
    );
    assert.throws(
      () => ledger.record({ source: 'testGate', errorText: '   ' }),
      /errorText 不能为空/,
    );
  });

  it('read 返回写入的记录', () => {
    const ledger = new CorrectionsLedger();
    const created = ledger.record({ source: 'loop_monitor', errorText: '3-strike reached' });
    const read = ledger.read(created.id);
    assert.ok(read);
    assert.equal(read!.id, created.id);
    assert.equal(read!.source, 'loop_monitor');
  });

  it('read 不存在 ID 返回 null', () => {
    const ledger = new CorrectionsLedger();
    assert.equal(ledger.read('nonexistent-id'), null);
  });
});

// ─── Manager: list ────────────────────────────────────────────────

describe('CorrectionsLedger.list', () => {
  it('按 source 过滤', () => {
    const ledger = new CorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'a' });
    ledger.record({ source: 'testGate', errorText: 'b' });
    ledger.record({ source: 'reviewGate', errorText: 'c' });
    const reviewRows = ledger.list({ source: 'reviewGate' });
    assert.equal(reviewRows.length, 2);
    const testRows = ledger.list({ source: 'testGate' });
    assert.equal(testRows.length, 1);
  });

  it('按 status 过滤', () => {
    const ledger = new CorrectionsLedger();
    const r1 = ledger.record({ source: 'reviewGate', errorText: 'a' });
    ledger.record({ source: 'reviewGate', errorText: 'b' });
    ledger.resolve(r1.id, 'fixed');
    const openRows = ledger.list({ status: 'open' });
    const resolvedRows = ledger.list({ status: 'resolved' });
    assert.equal(openRows.length, 1);
    assert.equal(resolvedRows.length, 1);
  });

  it('按 fingerprint 过滤', () => {
    const ledger = new CorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'error one' });
    ledger.record({ source: 'reviewGate', errorText: 'error one' }); // 同指纹
    ledger.record({ source: 'reviewGate', errorText: 'error two' }); // 不同指纹
    const fp = computeFingerprint('reviewGate', 'error one');
    const rows = ledger.list({ fingerprint: fp });
    assert.equal(rows.length, 2);
  });

  it('按 goalId 过滤', () => {
    const ledger = new CorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'a', goalId: 'goal-1' });
    ledger.record({ source: 'reviewGate', errorText: 'b', goalId: 'goal-2' });
    const rows = ledger.list({ goalId: 'goal-1' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.goal_id, 'goal-1');
  });

  it('limit 限制返回数', () => {
    const ledger = new CorrectionsLedger();
    for (let i = 0; i < 5; i++) {
      ledger.record({ source: 'testGate', errorText: `error-${i}` });
    }
    const rows = ledger.list({ limit: 2 });
    assert.equal(rows.length, 2);
  });

  it('默认按 ts DESC 排序', () => {
    const ledger = new CorrectionsLedger();
    const r1 = ledger.record({ source: 'testGate', errorText: 'first' });
    const r2 = ledger.record({ source: 'testGate', errorText: 'second' });
    const rows = ledger.list();
    assert.equal(rows[0]!.id, r2.id); // 最新的在前
    assert.equal(rows[1]!.id, r1.id);
  });
});

// ─── Manager: resolve / ignore ────────────────────────────────────

describe('CorrectionsLedger.resolve / ignore', () => {
  it('resolve 写入 resolution + experience_id', () => {
    const ledger = new CorrectionsLedger();
    const r = ledger.record({ source: 'reviewGate', errorText: 'a' });
    const resolved = ledger.resolve(r.id, 'fixed by calling awkn-审核', 'EXP-DRV-20260723-001');
    assert.ok(resolved);
    assert.equal(resolved!.status, 'resolved');
    assert.equal(resolved!.resolution, 'fixed by calling awkn-审核');
    assert.equal(resolved!.experience_id, 'EXP-DRV-20260723-001');
  });

  it('ignore 写入 reason', () => {
    const ledger = new CorrectionsLedger();
    const r = ledger.record({ source: 'reviewGate', errorText: 'a' });
    const ignored = ledger.ignore(r.id, 'false positive');
    assert.ok(ignored);
    assert.equal(ignored!.status, 'ignored');
    assert.equal(ignored!.resolution, 'false positive');
  });

  it('resolve 不存在的 ID 返回 null', () => {
    const ledger = new CorrectionsLedger();
    assert.equal(ledger.resolve('nonexistent', 'x'), null);
  });
});

// ─── Manager: resolveByFingerprint ─────────────────────────────────

describe('CorrectionsLedger.resolveByFingerprint', () => {
  it('批量关闭同指纹的 open 记录', () => {
    const ledger = new CorrectionsLedger();
    // 写 3 条同指纹 + 1 条不同指纹
    ledger.record({ source: 'reviewGate', errorText: 'same error' });
    ledger.record({ source: 'reviewGate', errorText: 'same error' });
    ledger.record({ source: 'reviewGate', errorText: 'same error' });
    ledger.record({ source: 'reviewGate', errorText: 'different error' });

    const fp = computeFingerprint('reviewGate', 'same error');
    const affected = ledger.resolveByFingerprint(fp, 'batch resolved', 'EXP-DRV-20260723-002');
    assert.equal(affected, 3);

    // 验证：同指纹的全 resolved，不同指纹的还是 open
    const open = ledger.list({ status: 'open' });
    assert.equal(open.length, 1);
    assert.equal(open[0]!.error_text, 'different error');
  });

  it('无匹配指纹返回 0', () => {
    const ledger = new CorrectionsLedger();
    const affected = ledger.resolveByFingerprint('nonexistent-fp', 'whatever');
    assert.equal(affected, 0);
  });
});

// ─── Manager: countByFingerprint ──────────────────────────────────

describe('CorrectionsLedger.countByFingerprint', () => {
  it('按 fingerprint 聚合 count + firstTs/lastTs', () => {
    const ledger = new CorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'error A' });
    ledger.record({ source: 'reviewGate', errorText: 'error A' });
    ledger.record({ source: 'reviewGate', errorText: 'error A' });
    ledger.record({ source: 'testGate', errorText: 'error B' });

    const stats = ledger.countByFingerprint();
    assert.equal(stats.length, 2);

    // 最多 count 的排前面
    const top = stats[0]!;
    assert.equal(top.count, 3);
    assert.equal(top.source, 'reviewGate');
    assert.ok(top.firstTs);
    assert.ok(top.lastTs);
    assert.equal(top.latestError, 'error A');
  });

  it('只统计 status=open', () => {
    const ledger = new CorrectionsLedger();
    const r1 = ledger.record({ source: 'reviewGate', errorText: 'error A' });
    ledger.record({ source: 'reviewGate', errorText: 'error A' });
    ledger.resolve(r1.id, 'fixed');

    const stats = ledger.countByFingerprint();
    assert.equal(stats.length, 1);
    assert.equal(stats[0]!.count, 1); // resolved 不算
  });
});

// ─── Manager: statsBySource ───────────────────────────────────────

describe('CorrectionsLedger.statsBySource', () => {
  it('按 source 分组统计 total / open / resolved', () => {
    const ledger = new CorrectionsLedger();
    const r1 = ledger.record({ source: 'reviewGate', errorText: 'a' });
    ledger.record({ source: 'reviewGate', errorText: 'b' });
    ledger.record({ source: 'testGate', errorText: 'c' });
    ledger.resolve(r1.id, 'fixed');

    const stats = ledger.statsBySource();
    assert.equal(stats.length, 2);

    const reviewStat = stats.find((s) => s.source === 'reviewGate')!;
    assert.ok(reviewStat);
    assert.equal(reviewStat.total, 2);
    assert.equal(reviewStat.open, 1);
    assert.equal(reviewStat.resolved, 1);

    const testStat = stats.find((s) => s.source === 'testGate')!;
    assert.ok(testStat);
    assert.equal(testStat.total, 1);
    assert.equal(testStat.open, 1);
    assert.equal(testStat.resolved, 0);
  });
});
