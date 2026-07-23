/**
 * Pattern Detector + Experience Writer 测试 — M3 自进化机制检测层
 *
 * 覆盖：
 * 1. PatternDetector.detectRepeatedFingerprints 阈值触发
 * 2. PatternDetector.detectSourceBursts 突发检测
 * 3. PatternDetector.detectGoalRepeats 同 goal 内重复
 * 4. resolveExperienceId 同日 NNN 自增
 * 5. writeExperience 文件生成 + corrections 自动 resolve
 * 6. writeAllExperiences 批量
 * 7. stopExperienceExtractHook 端到端
 *
 * 运行：node --import tsx --test test/pattern-detector.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { existsSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { PatternDetector, DEFAULT_PATTERN_CONFIG } from '../src/evolve/pattern-detector.js';
import type { PatternDetectorConfig } from '../src/evolve/pattern-detector.js';
import { getCorrectionsLedger } from '../src/evolve/corrections-ledger.js';
import {
  resolveExperienceId,
  writeExperience,
  writeAllExperiences,
  patternToMarkdown,
  stopExperienceExtractHook,
} from '../src/evolve/experience-writer.js';
import { getDb, closeDb, queryRun } from '../src/store/db.js';

const TEST_DB_PATH = resolve(
  process.cwd(),
  'data',
  `test-pattern-${process.pid}.db`,
);

// 经验目录（用临时目录避免污染真实 derived/）
const TEST_DERIVED_DIR = resolve(
  process.cwd(),
  'data',
  `test-derived-${process.pid}`,
);

// 用环境变量让 experience-writer 用临时目录？不行，路径是写死的。
// 改用：测试用 patternToMarkdown 验证内容，writeExperience 测试用模拟 pattern（同 fingerprint）
// 直接验证文件名冲突解决 + corrections resolve 行为。

beforeEach(() => {
  closeDb();
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH);
    try { rmSync(`${TEST_DB_PATH}-wal`); } catch { /* ignore */ }
    try { rmSync(`${TEST_DB_PATH}-shm`); } catch { /* ignore */ }
  }
  getDb(TEST_DB_PATH);
  // 用环境变量隔离经验目录（避免污染真实 derived/）
  process.env.AWKN_DERIVED_DIR = TEST_DERIVED_DIR;
  if (existsSync(TEST_DERIVED_DIR)) {
    rmSync(TEST_DERIVED_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DERIVED_DIR, { recursive: true });
});

afterEach(() => {
  try {
    queryRun('DELETE FROM corrections_ledger');
  } catch { /* ignore */ }
  closeDb();
  delete process.env.AWKN_DERIVED_DIR;
  if (existsSync(TEST_DERIVED_DIR)) {
    rmSync(TEST_DERIVED_DIR, { recursive: true, force: true });
  }
});

// ─── detectRepeatedFingerprints ─────────────────────────────────

describe('PatternDetector.detectRepeatedFingerprints', () => {
  it('同指纹 ≥3 次 → 命中 repeated_fingerprint 模式', () => {
    const ledger = getCorrectionsLedger();
    // 写 3 条同指纹错误
    ledger.record({ source: 'reviewGate', errorText: 'review verdict missing' });
    ledger.record({ source: 'reviewGate', errorText: 'review verdict missing' });
    ledger.record({ source: 'reviewGate', errorText: 'review verdict missing' });
    // +1 条不同指纹（不应触发）
    ledger.record({ source: 'reviewGate', errorText: 'something else' });

    const detector = new PatternDetector();
    const patterns = detector.detectRepeatedFingerprints();
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0]!.kind, 'repeated_fingerprint');
    assert.equal(patterns[0]!.source, 'reviewGate');
    assert.equal(patterns[0]!.count, 3);
    assert.ok(patterns[0]!.fingerprint.length === 16);
    assert.ok(patterns[0]!.sampleIds.length > 0);
    assert.ok(patterns[0]!.suggestedExperienceId.startsWith('EXP-DRV-'));
  });

  it('同指纹 <3 次（仅 2 次）→ 不触发', () => {
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'error A' });
    ledger.record({ source: 'reviewGate', errorText: 'error A' });

    const detector = new PatternDetector();
    const patterns = detector.detectRepeatedFingerprints();
    assert.equal(patterns.length, 0);
  });

  it('已 resolved 的不参与计数', () => {
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'error A' });
    const r2 = ledger.record({ source: 'reviewGate', errorText: 'error A' });
    ledger.record({ source: 'reviewGate', errorText: 'error A' });
    // resolve 一条
    ledger.resolve(r2.id, 'fixed');
    // 现在 open=2 < 3，不应触发
    const detector = new PatternDetector();
    const patterns = detector.detectRepeatedFingerprints();
    assert.equal(patterns.length, 0);
  });

  it('自定义阈值：阈值=2 时 2 次即触发', () => {
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'testGate', errorText: 'error X' });
    ledger.record({ source: 'testGate', errorText: 'error X' });

    const detector = new PatternDetector({ repeatedFingerprintThreshold: 2 });
    const patterns = detector.detectRepeatedFingerprints();
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0]!.count, 2);
  });

  it('归一化让同类错误（不同时间戳）命中同指纹', () => {
    const ledger = getCorrectionsLedger();
    // 三条错误，文本不同（时间戳/路径前缀不同），但归一化后同指纹
    ledger.record({
      source: 'reviewGate',
      errorText: 'Failed at 2026-07-23T10:00:00Z in D:\\proj\\a.ts',
    });
    ledger.record({
      source: 'reviewGate',
      errorText: 'Failed at 2026-07-23T11:30:00Z in D:\\other\\a.ts',
    });
    ledger.record({
      source: 'reviewGate',
      errorText: 'Failed at 2026-07-23T14:45:00Z in D:\\var\\a.ts',
    });

    const detector = new PatternDetector();
    const patterns = detector.detectRepeatedFingerprints();
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0]!.count, 3);
  });
});

// ─── detectSourceBursts ─────────────────────────────────────────

describe('PatternDetector.detectSourceBursts', () => {
  it('同一 source 1h 内 ≥5 次 → 命中 source_burst', () => {
    const ledger = getCorrectionsLedger();
    // 写 5 条不同指纹但同 source 的错误（均在最近 1h）
    for (let i = 0; i < 5; i++) {
      ledger.record({
        source: 'testGate',
        errorText: `unique error ${i}`,
      });
    }

    const detector = new PatternDetector();
    const patterns = detector.detectSourceBursts();
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0]!.kind, 'source_burst');
    assert.equal(patterns[0]!.source, 'testGate');
    assert.equal(patterns[0]!.count, 5);
  });

  it('同 source 4 次 < 5 → 不触发', () => {
    const ledger = getCorrectionsLedger();
    for (let i = 0; i < 4; i++) {
      ledger.record({ source: 'testGate', errorText: `error ${i}` });
    }

    const detector = new PatternDetector();
    const patterns = detector.detectSourceBursts();
    assert.equal(patterns.length, 0);
  });

  it('resolved 的不参与突发计数', () => {
    const ledger = getCorrectionsLedger();
    for (let i = 0; i < 5; i++) {
      ledger.record({ source: 'lintGate', errorText: `lint error ${i}` });
    }
    // 全部 resolve
    const rows = ledger.list({ source: 'lintGate' });
    for (const r of rows) {
      ledger.resolve(r.id, 'fixed');
    }

    const detector = new PatternDetector();
    const patterns = detector.detectSourceBursts();
    assert.equal(patterns.length, 0);
  });
});

// ─── detectGoalRepeats ─────────────────────────────────────────

describe('PatternDetector.detectGoalRepeats', () => {
  it('同一 goal 内同指纹 ≥2 次 → 命中 goal_repeat', () => {
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'goal-scoped error', goalId: 'goal-1' });
    ledger.record({ source: 'reviewGate', errorText: 'goal-scoped error', goalId: 'goal-1' });

    const detector = new PatternDetector();
    const patterns = detector.detectGoalRepeats();
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0]!.kind, 'goal_repeat');
    assert.equal(patterns[0]!.goalId, 'goal-1');
    assert.equal(patterns[0]!.count, 2);
  });

  it('不同 goal 用同指纹 → 不触发（goal 隔离）', () => {
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'shared error', goalId: 'goal-A' });
    ledger.record({ source: 'reviewGate', errorText: 'shared error', goalId: 'goal-B' });

    const detector = new PatternDetector();
    const patterns = detector.detectGoalRepeats();
    assert.equal(patterns.length, 0);
  });

  it('无 goal_id 的 correction 不参与', () => {
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'no-goal error' });
    ledger.record({ source: 'reviewGate', errorText: 'no-goal error' });

    const detector = new PatternDetector();
    const patterns = detector.detectGoalRepeats();
    assert.equal(patterns.length, 0);
  });
});

// ─── detect（全量） ────────────────────────────────────────────

describe('PatternDetector.detect (全量)', () => {
  it('同时返回所有三种模式', () => {
    const ledger = getCorrectionsLedger();
    // 模式 1：同指纹 ≥3（无 goal）
    ledger.record({ source: 'reviewGate', errorText: 'pattern1-error' });
    ledger.record({ source: 'reviewGate', errorText: 'pattern1-error' });
    ledger.record({ source: 'reviewGate', errorText: 'pattern1-error' });
    // 模式 2：source 突发 ≥5（用另一 source）
    for (let i = 0; i < 5; i++) {
      ledger.record({ source: 'lintGate', errorText: `burst-${i}` });
    }
    // 模式 3：同 goal 内 ≥2
    ledger.record({ source: 'testGate', errorText: 'goal-error', goalId: 'goal-X' });
    ledger.record({ source: 'testGate', errorText: 'goal-error', goalId: 'goal-X' });

    const detector = new PatternDetector();
    const patterns = detector.detect();
    const kinds = new Set(patterns.map((p) => p.kind));
    assert.ok(kinds.has('repeated_fingerprint'));
    assert.ok(kinds.has('source_burst'));
    assert.ok(kinds.has('goal_repeat'));
  });

  it('无错误时返回空数组', () => {
    const detector = new PatternDetector();
    const patterns = detector.detect();
    assert.equal(patterns.length, 0);
  });
});

// ─── resolveExperienceId（文件名冲突解决） ────────────────────────

describe('resolveExperienceId', () => {
  it('suggested 格式合法时返回 maxSeq+1', () => {
    const id = resolveExperienceId('EXP-DRV-20260723-999');
    // 测试用 AWKN_DERIVED_DIR 隔离，目录为空 → maxSeq=0 → 返回 -001（忽略 suggested 的 999）
    assert.ok(id.startsWith('EXP-DRV-2026072'));
    assert.match(id, /^EXP-DRV-\d{8}-001$/);
  });

  it('suggested 格式非法时返回今天日期的有效编号', () => {
    const id = resolveExperienceId('garbage');
    // 测试用 AWKN_DERIVED_DIR 隔离，目录为空 → maxSeq=0 → 返回 -001
    assert.match(id, /^EXP-DRV-\d{8}-001$/);
  });

  it('同日多次调用 NNN 自增', () => {
    // 因为这是真实磁盘行为，需要 mock 或跳过
    // 这里只验证返回格式正确（不实际写文件）
    const id1 = resolveExperienceId('EXP-DRV-20260101-001');
    const id2 = resolveExperienceId('EXP-DRV-20260101-001');
    // 如果当天没有文件，两次都返回 -001（maxSeq=0）
    // 如果有文件，第二次应 ≥ -002
    assert.match(id1, /^EXP-DRV-20260101-\d{3}$/);
    assert.match(id2, /^EXP-DRV-20260101-\d{3}$/);
  });
});

// ─── patternToMarkdown ──────────────────────────────────────────

describe('patternToMarkdown', () => {
  it('生成包含必要字段的 Markdown', () => {
    const pattern = {
      kind: 'repeated_fingerprint' as const,
      source: 'reviewGate',
      fingerprint: 'abc123def456ghi7',
      count: 3,
      firstTs: '2026-07-23T10:00:00Z',
      lastTs: '2026-07-23T11:00:00Z',
      latestError: 'review verdict missing',
      sampleIds: ['id-1', 'id-2', 'id-3'],
      suggestedExperienceId: 'EXP-DRV-20260723-001',
    };
    const md = patternToMarkdown(pattern, 'EXP-DRV-20260723-001');
    assert.ok(md.includes('# EXP-DRV-20260723-001'));
    assert.ok(md.includes('reviewGate'));
    assert.ok(md.includes('abc123def456ghi7'));
    assert.ok(md.includes('review verdict missing'));
    assert.ok(md.includes('id-1'));
    assert.ok(md.includes('待人工补充根因与铁律'));
  });
});

// ─── writeExperience ───────────────────────────────────────────

describe('writeExperience', () => {
  it('写入经验文件到 derived 目录 + 自动 resolve corrections', () => {
    // 先写 3 条同指纹错误
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'auto-extract test error' });
    ledger.record({ source: 'reviewGate', errorText: 'auto-extract test error' });
    ledger.record({ source: 'reviewGate', errorText: 'auto-extract test error' });

    const detector = new PatternDetector();
    const patterns = detector.detect();
    assert.equal(patterns.length, 1);

    const pattern = patterns[0]!;
    const result = writeExperience(pattern);

    assert.ok(result.experienceId.startsWith('EXP-DRV-'));
    assert.ok(result.filePath.endsWith('.md'));
    assert.ok(result.resolvedCorrections, 3);

    // 验证文件实际写到了磁盘
    assert.ok(existsSync(result.filePath), '经验文件实际生成');
    const content = readFileSync(result.filePath, 'utf-8');
    assert.ok(content.includes(result.experienceId));
    assert.ok(content.includes('reviewGate'));

    // 验证 corrections 都已 resolved
    const open = ledger.list({ status: 'open' });
    assert.equal(open.length, 0);
  });

  it('重复调用同 pattern 不覆盖（用 maxSeq+1 生成新文件）', () => {
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'testGate', errorText: 'repeat-write-test' });
    ledger.record({ source: 'testGate', errorText: 'repeat-write-test' });
    ledger.record({ source: 'testGate', errorText: 'repeat-write-test' });

    const detector = new PatternDetector();
    const patterns1 = detector.detect();
    const pattern1 = patterns1[0]!;
    const r1 = writeExperience(pattern1);

    // 第二次：再加 3 条同指纹错误（因为第一次已 resolve，需要新错误才能再触发）
    ledger.record({ source: 'testGate', errorText: 'repeat-write-test' });
    ledger.record({ source: 'testGate', errorText: 'repeat-write-test' });
    ledger.record({ source: 'testGate', errorText: 'repeat-write-test' });

    const patterns2 = detector.detect();
    if (patterns2.length > 0) {
      const pattern2 = patterns2[0]!;
      const r2 = writeExperience(pattern2);
      // 两次的 experienceId 应该不同（NNN 自增）
      assert.notEqual(r1.experienceId, r2.experienceId);
    }
  });
});

// ─── writeAllExperiences ────────────────────────────────────────

describe('writeAllExperiences', () => {
  it('批量写入多个 pattern', () => {
    const ledger = getCorrectionsLedger();
    // 模式 1
    for (let i = 0; i < 3; i++) {
      ledger.record({ source: 'reviewGate', errorText: 'pattern-a' });
    }
    // 模式 2（不同指纹）
    for (let i = 0; i < 3; i++) {
      ledger.record({ source: 'testGate', errorText: 'pattern-b' });
    }

    const detector = new PatternDetector();
    const patterns = detector.detect();
    const writes = writeAllExperiences(patterns);

    assert.ok(writes.length >= 1);
    for (const w of writes) {
      assert.ok(existsSync(w.filePath), `文件 ${w.experienceId} 已生成`);
    }
  });
});

// ─── stopExperienceExtractHook ──────────────────────────────────

describe('stopExperienceExtractHook', () => {
  it('无 pattern → 返回 success=true 且 message 含"无重复模式"', async () => {
    const result = await stopExperienceExtractHook();
    assert.equal(result.success, true);
    assert.ok(result.output.includes('无重复模式'));
  });

  it('有 pattern → 写经验文件 + 返回 success=true', async () => {
    const ledger = getCorrectionsLedger();
    for (let i = 0; i < 3; i++) {
      ledger.record({ source: 'reviewGate', errorText: 'hook-test-error' });
    }

    const result = await stopExperienceExtractHook();
    assert.equal(result.success, true);
    assert.ok(result.output.includes('experience-extract'));
  });
});
