/**
 * Strategy Switcher 单元测试 (PR1 P2-1)
 *
 * 验证重复模式诊断保留 [ACTION]/[ERROR] 来源标记，且：
 * - ACTION 重复 → SWITCH + replace_skill + nextStrategy
 * - ERROR 重复 → SWITCH + replace_tool + nextStrategy
 * - 禁止用其他低增益条件（如 consecutive low delta）顺带通过
 *
 * 设计文档: docs/agent-os-3.0/07-Evidence-Gain-Loop.md 第七节
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { StrategyAttempt } from '../src/contracts/evidence-loop.js';
import { evaluateStrategySwitch } from '../src/loop/strategy-switcher.js';

function makeAttempt(overrides: Partial<StrategyAttempt> = {}): StrategyAttempt {
  return {
    schema: 'awkn-strategy-attempt/v1',
    strategyId: 'strat-1',
    hypothesis: 'test hypothesis',
    actionFingerprint: 'action-fp-default',
    resultFingerprint: 'result-fp-default',
    evidenceDeltaScore: 0.3,
    usedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

test('Strategy Switcher (PR1 P2-1)', async (t) => {
  await t.test('ACTION 重复 → SWITCH + replace_skill + [ACTION] 来源', () => {
    // 构造只触发 ACTION 重复的 attempts：
    // - actionFingerprint 相同 → 'repeated action fingerprint [ACTION]'
    // - evidenceDeltaScore > 0 → 不触发 lowDelta / hypothesis rejected
    // - currentDeltaScore > 0 → 不触发 'current delta score non-positive'
    // - failureType undefined → 不触发 'repeated failure type'
    const attempts: StrategyAttempt[] = [
      makeAttempt({ actionFingerprint: 'fp-A', evidenceDeltaScore: 0.5 }),
      makeAttempt({ actionFingerprint: 'fp-A', evidenceDeltaScore: 0.4 }),
    ];
    const result = evaluateStrategySwitch(attempts, 0.3, false);

    // 断言三要素：shouldSwitch + decision + nextStrategy
    assert.equal(result.shouldSwitch, true, 'shouldSwitch 应为 true');
    assert.equal(result.decision, 'SWITCH', 'decision 应为 SWITCH');
    assert.equal(result.recommendedOption, 'replace_skill', 'recommendedOption 应为 replace_skill');
    assert.equal(result.nextStrategy, 'replace_skill', 'nextStrategy 应为 replace_skill');

    // 断言 [ACTION] 来源标记存在
    assert.ok(
      result.reasons.some((r) => r.includes('[ACTION]')),
      'reasons 应含 [ACTION] 来源标记',
    );

    // 禁止其他低增益条件顺带通过：reasons 应只有 1 个
    assert.equal(
      result.reasons.length,
      1,
      '应只有 1 个 reason（ACTION 重复），禁止其他低增益条件顺带通过',
    );
  });

  await t.test('ERROR 重复 → SWITCH + replace_tool + [ERROR] 来源', () => {
    // 构造只触发 ERROR 重复的 attempts：
    // - failureType 相同（EXECUTION_ERROR）→ 'repeated failure type: EXECUTION_ERROR [ERROR]'
    // - actionFingerprint 不同 → 不触发 'repeated action fingerprint'
    // - evidenceDeltaScore > 0 → 不触发 lowDelta / hypothesis rejected
    // - currentDeltaScore > 0 → 不触发 'current delta score non-positive'
    // - failureType 为 EXECUTION_ERROR（非 HYPOTHESIS_REJECTED/REGRESSION）→ 不触发 'current hypothesis rejected'
    const attempts: StrategyAttempt[] = [
      makeAttempt({ actionFingerprint: 'fp-A', failureType: 'EXECUTION_ERROR', evidenceDeltaScore: 0.5 }),
      makeAttempt({ actionFingerprint: 'fp-B', failureType: 'EXECUTION_ERROR', evidenceDeltaScore: 0.4 }),
    ];
    const result = evaluateStrategySwitch(attempts, 0.3, false);

    // 断言三要素：shouldSwitch + decision + nextStrategy
    assert.equal(result.shouldSwitch, true, 'shouldSwitch 应为 true');
    assert.equal(result.decision, 'SWITCH', 'decision 应为 SWITCH');
    assert.equal(result.recommendedOption, 'replace_tool', 'recommendedOption 应为 replace_tool');
    assert.equal(result.nextStrategy, 'replace_tool', 'nextStrategy 应为 replace_tool');

    // 断言 [ERROR] 来源标记存在
    assert.ok(
      result.reasons.some((r) => r.includes('[ERROR]')),
      'reasons 应含 [ERROR] 来源标记',
    );

    // 不应含 [ACTION] 标记
    assert.ok(
      !result.reasons.some((r) => r.includes('[ACTION]')),
      '不应含 [ACTION] 来源标记',
    );

    // 禁止其他低增益条件顺带通过：reasons 应只有 1 个
    assert.equal(
      result.reasons.length,
      1,
      '应只有 1 个 reason（ERROR 重复），禁止其他低增益条件顺带通过',
    );
  });

  await t.test('ACTION 与 ERROR 同时重复 → replace_skill 优先（reasons 顺序无关）', () => {
    // 两者都触发时，strategy-switcher 按 reasons 匹配顺序返回第一个命中的选项
    // 当前实现：先检查 'repeated action' → replace_skill，再检查 'repeated failure' → replace_tool
    // 所以 ACTION 重复优先于 ERROR 重复
    const attempts: StrategyAttempt[] = [
      makeAttempt({ actionFingerprint: 'fp-A', failureType: 'EXECUTION_ERROR', evidenceDeltaScore: 0.5 }),
      makeAttempt({ actionFingerprint: 'fp-A', failureType: 'EXECUTION_ERROR', evidenceDeltaScore: 0.4 }),
    ];
    const result = evaluateStrategySwitch(attempts, 0.3, false);

    assert.equal(result.shouldSwitch, true);
    assert.equal(result.decision, 'SWITCH');
    // ACTION 优先（strategy-switcher.ts 中 replace_skill 检查在 replace_tool 之前）
    assert.equal(result.recommendedOption, 'replace_skill');
    assert.equal(result.nextStrategy, 'replace_skill');

    // 两个来源标记都应存在
    assert.ok(result.reasons.some((r) => r.includes('[ACTION]')), '应含 [ACTION]');
    assert.ok(result.reasons.some((r) => r.includes('[ERROR]')), '应含 [ERROR]');
  });

  await t.test('无重复时 → CONTINUE，无来源标记', () => {
    // actionFingerprint 不同、failureType 不同、delta > 0 → 不触发任何切换
    const attempts: StrategyAttempt[] = [
      makeAttempt({ actionFingerprint: 'fp-A', evidenceDeltaScore: 0.5 }),
      makeAttempt({ actionFingerprint: 'fp-B', evidenceDeltaScore: 0.4 }),
    ];
    const result = evaluateStrategySwitch(attempts, 0.3, false);

    assert.equal(result.shouldSwitch, false);
    assert.equal(result.decision, 'CONTINUE');
    assert.equal(result.recommendedOption, undefined);
    assert.equal(result.nextStrategy, undefined);
    // 无来源标记
    assert.ok(!result.reasons.some((r) => r.includes('[ACTION]')), '不应含 [ACTION]');
    assert.ok(!result.reasons.some((r) => r.includes('[ERROR]')), '不应含 [ERROR]');
  });
});
