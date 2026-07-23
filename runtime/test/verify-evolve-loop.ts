/**
 * M3 进阶-17 端到端验证：自进化闭环连通性
 *
 * 核心验证：record() 断链已修复 — corrections-ledger → pattern-detector → experience-writer 闭环连通
 *
 * 验证点：
 * 1. 静态：quality-gates.ts 含 recordGateFailures + import getCorrectionsLedger
 * 2. 静态：agent-loop.ts 含 recordLoopFailure + import getCorrectionsLedger
 * 3. 静态：prd-centric-loop.ts 含 recordGateFailures + getCorrectionsLedger 调用
 * 4. 静态：3 个批量评估器（runAllGates/evaluateL2StopConditions/evaluateTianhuoCicdStop）调用 recordGateFailures
 * 5. 单元：recordGateFailures 只记录 FAIL 结果（PASS 跳过）
 * 6. 单元：recordGateFailures 记录正确的 source/severity/errorText
 * 7. 端到端：record 3 次同指纹 → detect 返回 repeated_fingerprint → writeExperience 写文件 → corrections resolved
 * 8. 端到端：resolve 后再 detect → 返回 []（已 resolved 的不参与）
 * 9. 端到端：stopExperienceExtractHook 完整跑通（detect + write + resolve）
 * 10. 端到端：goal_repeat 模式（同 goal 内 2 次同指纹）
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb, queryAll } from '../src/store/db.js';
import { getCorrectionsLedger } from '../src/evolve/corrections-ledger.js';
import { getPatternDetector } from '../src/evolve/pattern-detector.js';
import { writeAllExperiences, stopExperienceExtractHook, scanPendingDrafts } from '../src/evolve/experience-writer.js';
import { recordGateFailures } from '../src/gates/quality-gates.js';
import type { GateResult } from '../src/gates/quality-gates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 临时 DB + 临时 derived 目录（避免污染正式数据）
const tmpDbPath = resolve(__dirname, '..', 'data', `verify-evolve-${Date.now()}.db`);
const tmpDerivedDir = resolve(__dirname, '..', 'data', `verify-evolve-derived-${Date.now()}`);
process.env.AWKN_DB_PATH = tmpDbPath;
process.env.AWKN_DERIVED_DIR = tmpDerivedDir;

describe('M3 进阶-17: 自进化闭环连通性', () => {
  // ========== 静态结构验证 ==========

  it('静态：quality-gates.ts 含 recordGateFailures + import getCorrectionsLedger', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'gates', 'quality-gates.ts'),
      'utf-8',
    );
    assert.ok(src.includes("import { getCorrectionsLedger } from '../evolve/corrections-ledger.js'"), '应 import getCorrectionsLedger');
    assert.ok(src.includes('export function recordGateFailures('), '应含 recordGateFailures 函数');
    assert.ok(src.includes('M3 进阶-17'), '应含 M3 进阶-17 注释');
  });

  it('静态：3 个批量评估器调用 recordGateFailures', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'gates', 'quality-gates.ts'),
      'utf-8',
    );
    // runAllGates
    assert.ok(src.includes('recordGateFailures(ctx.goalId, results)'), '应含 recordGateFailures 调用');
    // 统计出现次数（应在 3 个批量评估器中各调用一次，runAllGates + evaluateL2StopConditions + evaluateTianhuoCicdStop + 可能的导出函数本身不算）
    const callCount = (src.match(/recordGateFailures\(ctx\.goalId, results\)/g) || []).length;
    assert.ok(callCount >= 3, `recordGateFailures 应被调用 ≥3 次，实际 ${callCount} 次`);
  });

  it('静态：agent-loop.ts 含 recordLoopFailure + import getCorrectionsLedger', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'core', 'agent-loop.ts'),
      'utf-8',
    );
    assert.ok(src.includes("import { getCorrectionsLedger } from '../evolve/corrections-ledger.js'"), '应 import getCorrectionsLedger');
    assert.ok(src.includes('const recordLoopFailure'), '应含 recordLoopFailure 闭包');
    // 3 个失败点调用
    assert.ok(src.includes("recordLoopFailure(`LLM 连续失败"), '应在 LLM 3-strike 处调用');
    assert.ok(src.includes('recordLoopFailure(`工具执行失败'), '应在工具错误处调用');
    assert.ok(src.includes('recordLoopFailure(`工具调用重复模式'), '应在重复模式处调用');
  });

  it('静态：prd-centric-loop.ts 含 recordGateFailures + getCorrectionsLedger 调用', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'orchestrator', 'prd-centric-loop.ts'),
      'utf-8',
    );
    assert.ok(src.includes('recordGateFailures'), '应含 recordGateFailures');
    assert.ok(src.includes("getCorrectionsLedger().record("), '应含 getCorrectionsLedger().record() 调用');
  });

  // ========== 单元验证 ==========

  it('单元：recordGateFailures 只记录 FAIL（PASS 跳过）', () => {
    // 先清空 corrections_ledger
    const db = getDb();
    db.exec('DELETE FROM corrections_ledger');

    const results: GateResult[] = [
      { name: 'typecheckGate', passed: true, details: '0 errors', durationMs: 10 },
      { name: 'testGate', passed: false, details: '3 failed', suggestion: 'fix tests', durationMs: 20 },
      { name: 'lintGate', passed: true, details: '0 problems', durationMs: 5 },
      { name: 'reviewGate', passed: false, details: 'FAIL: issues found', suggestion: 'fix issues', durationMs: 30 },
    ];

    recordGateFailures('test-goal-1', results);

    const rows = getCorrectionsLedger().list({ goalId: 'test-goal-1' });
    assert.equal(rows.length, 2, '应只记录 2 个 FAIL（testGate + reviewGate）');
    const sources = rows.map((r) => r.source).sort();
    assert.deepEqual(sources, ['reviewGate', 'testGate'], 'source 应为 testGate 和 reviewGate');
  });

  it('单元：recordGateFailures 记录正确的 severity', () => {
    const db = getDb();
    db.exec('DELETE FROM corrections_ledger');

    const results: GateResult[] = [
      { name: 'securityGate', passed: false, details: 'secret leaked', durationMs: 10 },
      { name: 'budgetGate', passed: false, details: 'budget exceeded', durationMs: 10 },
      { name: 'testGate', passed: false, details: '1 failed', durationMs: 10 },
    ];

    recordGateFailures(undefined, results);

    const rows = getCorrectionsLedger().list({});
    assert.equal(rows.length, 3, '应记录 3 个 FAIL');
    const sec = rows.find((r) => r.source === 'securityGate');
    const bud = rows.find((r) => r.source === 'budgetGate');
    const test = rows.find((r) => r.source === 'testGate');
    assert.equal(sec?.severity, 'fatal', 'securityGate 应为 fatal');
    assert.equal(bud?.severity, 'fatal', 'budgetGate 应为 fatal');
    assert.equal(test?.severity, 'error', 'testGate 应为 error');
  });

  // ========== 端到端：完整自进化闭环 ==========

  it('端到端：record 3 次同指纹 → detect → writeExperience → corrections resolved', () => {
    const db = getDb();
    db.exec('DELETE FROM corrections_ledger');

    // 清空 derived 目录
    mkdirSync(tmpDerivedDir, { recursive: true });
    for (const f of readdirSync(tmpDerivedDir)) {
      rmSync(resolve(tmpDerivedDir, f), { force: true });
    }

    const ledger = getCorrectionsLedger();
    const errorText = 'typecheck error: TS2304 Cannot find name foo';

    // Step 1: 记录 3 次相同的错误（同 source + 同 errorText → 同 fingerprint）
    for (let i = 0; i < 3; i++) {
      ledger.record({
        goalId: 'goal-e2e-1',
        source: 'typecheckGate',
        severity: 'error',
        errorText,
      });
    }

    // 验证 ledger 有 3 条 open 记录
    const openRows = ledger.list({ status: 'open' });
    assert.equal(openRows.length, 3, '应有 3 条 open corrections');

    // Step 2: pattern-detector 检测
    const patterns = getPatternDetector().detect();
    assert.ok(patterns.length > 0, '应检测到至少 1 个 pattern');

    const repeated = patterns.find((p) => p.kind === 'repeated_fingerprint');
    assert.ok(repeated, '应检测到 repeated_fingerprint pattern');
    assert.equal(repeated!.count, 3, 'count 应为 3');
    assert.equal(repeated!.source, 'typecheckGate', 'source 应为 typecheckGate');

    // Step 3: writeAllExperiences 写经验文件
    const writes = writeAllExperiences(patterns);
    assert.ok(writes.length > 0, '应写入至少 1 个经验文件');

    const write = writes[0]!;
    assert.ok(write.experienceId.startsWith('EXP-DRV-'), `experienceId 格式正确: ${write.experienceId}`);
    assert.ok(existsSync(write.filePath), `经验文件应存在: ${write.filePath}`);
    assert.ok(write.resolvedCorrections > 0, '应 resolve 了 corrections');

    // Step 4: 验证 corrections 已被 resolve
    const stillOpen = ledger.list({ status: 'open' });
    assert.equal(stillOpen.length, 0, '所有 corrections 应已 resolved');

    const resolved = ledger.list({ status: 'resolved' });
    assert.equal(resolved.length, 3, '应有 3 条 resolved corrections');
    assert.ok(resolved.every((r) => r.experience_id === write.experienceId), '所有 resolved 的 experience_id 应匹配');
  });

  it('端到端：resolve 后再 detect → 返回 []（已 resolved 的不参与）', () => {
    // 上一轮已 resolve 所有 corrections
    const patterns = getPatternDetector().detect();
    // 应该没有 open 的 corrections → 无 pattern
    const openPatterns = patterns.filter((p) => p.kind === 'repeated_fingerprint');
    assert.equal(openPatterns.length, 0, 'resolve 后不应再检测到 repeated_fingerprint');
  });

  it('端到端：stopExperienceExtractHook 完整跑通', async () => {
    const db = getDb();
    db.exec('DELETE FROM corrections_ledger');

    // 清空 derived 目录
    for (const f of readdirSync(tmpDerivedDir)) {
      rmSync(resolve(tmpDerivedDir, f), { force: true });
    }

    // 记录 3 次相同错误
    for (let i = 0; i < 3; i++) {
      getCorrectionsLedger().record({
        goalId: 'goal-hook-1',
        source: 'testGate',
        severity: 'error',
        errorText: 'test failed: AssertionError: expected 5 but got 3',
      });
    }

    // 调用 stopExperienceExtractHook（模拟 session_stop 触发）
    const result = await stopExperienceExtractHook();
    assert.ok(result.success, 'hook 应成功');
    assert.ok(result.output.includes('检测到'), 'output 应含"检测到"');
    assert.ok(result.output.includes('EXP-DRV-'), 'output 应含经验文件 ID');

    // 验证 corrections 已 resolved
    const open = getCorrectionsLedger().list({ status: 'open' });
    assert.equal(open.length, 0, '所有 corrections 应已 resolved');

    // 验证经验文件存在
    const files = readdirSync(tmpDerivedDir).filter((f) => f.startsWith('EXP-DRV-'));
    assert.ok(files.length > 0, 'derived 目录应有经验文件');
  });

  it('端到端：goal_repeat 模式（同 goal 内 2 次同指纹）', () => {
    const db = getDb();
    db.exec('DELETE FROM corrections_ledger');

    // 清空 derived 目录
    for (const f of readdirSync(tmpDerivedDir)) {
      rmSync(resolve(tmpDerivedDir, f), { force: true });
    }

    // 记录 2 次相同错误（同 goal，同 fingerprint）
    // goal_repeat 阈值是 2，所以 2 次就够
    for (let i = 0; i < 2; i++) {
      getCorrectionsLedger().record({
        goalId: 'goal-repeat-1',
        source: 'lintGate',
        severity: 'error',
        errorText: 'eslint: no-unused-vars at line 42',
      });
    }

    const patterns = getPatternDetector().detect();
    const goalRepeat = patterns.find((p) => p.kind === 'goal_repeat');
    assert.ok(goalRepeat, '应检测到 goal_repeat pattern');
    assert.equal(goalRepeat!.count, 2, 'count 应为 2');
    assert.equal(goalRepeat!.goalId, 'goal-repeat-1', 'goalId 应为 goal-repeat-1');

    // 写经验文件
    const writes = writeAllExperiences([goalRepeat!]);
    assert.ok(writes.length > 0, '应写入经验文件');
    assert.ok(existsSync(writes[0]!.filePath), '经验文件应存在');
  });

  it('端到端：无 corrections 时 detect 返回 []', () => {
    const db = getDb();
    db.exec('DELETE FROM corrections_ledger');

    const patterns = getPatternDetector().detect();
    assert.equal(patterns.length, 0, '无 corrections 时应返回空数组');
  });

  // ========== M3 进阶-18：scanPendingDrafts 验证 ==========

  it('静态：experience-writer.ts 含 scanPendingDrafts + completePendingDrafts', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'evolve', 'experience-writer.ts'),
      'utf-8',
    );
    assert.ok(src.includes('export function scanPendingDrafts('), '应含 scanPendingDrafts');
    assert.ok(src.includes('export async function completePendingDrafts('), '应含 completePendingDrafts');
    assert.ok(src.includes('M3 进阶-18'), '应含 M3 进阶-18 注释');
  });

  it('静态：cli.ts 含 scan-drafts / complete-drafts 子命令', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'cli.ts'),
      'utf-8',
    );
    assert.ok(src.includes("case 'scan-drafts'"), '应含 scan-drafts case');
    assert.ok(src.includes("case 'complete-drafts'"), '应含 complete-drafts case');
    assert.ok(src.includes('scanPendingDrafts'), '应调用 scanPendingDrafts');
    assert.ok(src.includes('completePendingDrafts'), '应调用 completePendingDrafts');
  });

  it('端到端：scanPendingDrafts 找到待补全草稿', () => {
    // 清空 derived 目录，写入一个含"待人工补充"标记的草稿
    mkdirSync(tmpDerivedDir, { recursive: true });
    for (const f of readdirSync(tmpDerivedDir)) {
      rmSync(resolve(tmpDerivedDir, f), { force: true });
    }

    // 写一个待补全草稿
    writeFileSync(
      resolve(tmpDerivedDir, 'EXP-DRV-20260723-999.md'),
      `# EXP-DRV-20260723-999 — 测试草稿\n\n- **状态**: 待人工补充\n\n## 4. 根因分析（待人工补充）\n\n待补充内容\n\n## 5. 待提炼的铁律（待人工补充）\n\n待补充内容\n`,
      'utf-8',
    );

    // 写一个已完成的草稿（无标记）
    writeFileSync(
      resolve(tmpDerivedDir, 'EXP-DRV-20260723-998.md'),
      `# EXP-DRV-20260723-998 — 已完成草稿\n\n- **状态**: 已提炼\n\n## 4. 根因分析\n\n已完成的根因\n\n## 5. 铁律\n\nE96: 测试铁律\n`,
      'utf-8',
    );

    const pending = scanPendingDrafts();
    assert.equal(pending.length, 1, '应只找到 1 个待补全草稿（999），已完成草稿（998）应跳过');
    assert.equal(pending[0]!.experienceId, 'EXP-DRV-20260723-999', 'experienceId 应为 999');
    assert.ok(pending[0]!.pendingMarkerCount >= 3, '应检测到 ≥3 个待补全标记');
  });

  it('端到端：scanPendingDrafts 无草稿时返回空数组', () => {
    // 清空 derived 目录
    mkdirSync(tmpDerivedDir, { recursive: true });
    for (const f of readdirSync(tmpDerivedDir)) {
      rmSync(resolve(tmpDerivedDir, f), { force: true });
    }

    const pending = scanPendingDrafts();
    assert.equal(pending.length, 0, '无草稿时应返回空数组');
  });

  it('端到端：writeAllExperiences 后 scanPendingDrafts 能找到新生成的草稿', () => {
    const db = getDb();
    db.exec('DELETE FROM corrections_ledger');

    // 清空 derived 目录
    mkdirSync(tmpDerivedDir, { recursive: true });
    for (const f of readdirSync(tmpDerivedDir)) {
      rmSync(resolve(tmpDerivedDir, f), { force: true });
    }

    // 记录 3 次相同错误触发经验写入
    for (let i = 0; i < 3; i++) {
      getCorrectionsLedger().record({
        goalId: 'goal-scan-1',
        source: 'typecheckGate',
        severity: 'error',
        errorText: 'TS9999: test error for scanPendingDrafts',
      });
    }

    // detect + write
    const patterns = getPatternDetector().detect();
    assert.ok(patterns.length > 0, '应检测到 pattern');
    const writes = writeAllExperiences(patterns);
    assert.ok(writes.length > 0, '应写入经验文件');

    // scan 应找到刚写入的草稿（含"待人工补充"标记）
    const pending = scanPendingDrafts();
    assert.ok(pending.length > 0, 'scanPendingDrafts 应找到刚写入的草稿');
    assert.ok(
      pending.some((p) => p.experienceId === writes[0]!.experienceId),
      '应包含刚写入的 experienceId',
    );
  });

  // ========== 清理 ==========

  after(() => {
    closeDb();
    // 清理临时文件
    try {
      rmSync(tmpDbPath, { force: true });
      rmSync(tmpDerivedDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });
});
