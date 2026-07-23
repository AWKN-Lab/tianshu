/**
 * PRD 一致性算法测试 — 验证移除"前 20 字符"匹配策略后不再自评自满
 *
 * 用 node:test（Node 20+ 内置），不依赖 vitest native binding
 * 运行：node --import tsx --test test/prd-consistency.test.ts
 *
 * 历史问题（v0.1）：
 * - 策略 3"文本前 20 字符出现"导致 LLM 复述 PRD 即可让 consistency=1.0
 * - EXP-DRV-20260710-001 场景B 实测 consistency=1.0 是假达成
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRequirements,
  evaluatePrdConsistency,
  parseReviewVerdict,
} from '../src/gates/prd-consistency.js';

describe('extractRequirements', () => {
  it('抽取 US-xxx / AC-xxx / 验收标准 三种格式', () => {
    const prd = [
      '# PRD: hash 工具',
      'US-001: 给 runtime 加一个 sha256 hash 工具',
      'AC-001: 输入文本返回 hex 字符串',
      'AC-002: 长度固定 64 字符',
      '验收标准: tsc 0 错误且 vitest 全过',
    ].join('\n');

    const reqs = extractRequirements(prd);
    assert.equal(reqs.length, 4);
    assert.deepEqual(reqs.map((r) => r.id), ['US-001', 'AC-001', 'AC-002', 'REQ-4']);
    assert.ok(reqs[3].text.includes('tsc 0 错误'));
  });

  it('同 ID 不重复加入', () => {
    const prd = 'US-001: 第一条\nUS-001: 第二条';
    const reqs = extractRequirements(prd);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].text, '第一条');
  });

  it('空 PRD 返回空数组', () => {
    assert.deepEqual(extractRequirements(''), []);
    assert.deepEqual(extractRequirements('纯文本无 ID'), []);
  });
});

describe('evaluatePrdConsistency — hash 精确匹配', () => {
  it('产出逐行复述 PRD 需求 → 全部命中（hash 一致）', () => {
    const prd = 'US-001: 输入文本算 sha256 返回 hex\nAC-001: 输出长度 64 字符';
    const plan = 'US-001: 输入文本算 sha256 返回 hex\nAC-001: 输出长度 64 字符';
    const result = evaluatePrdConsistency(prd, [plan]);
    assert.equal(result.consistency, 1);
    assert.equal(result.passed, true);
    assert.equal(result.uncovered.length, 0);
  });

  it('空 PRD 默认 1.0（无需求可不一致）', () => {
    const result = evaluatePrdConsistency('纯描述无 ID', ['任意产出']);
    assert.equal(result.consistency, 1);
    assert.equal(result.passed, true);
  });
});

describe('evaluatePrdConsistency — ID 出现匹配', () => {
  it('产出包含 ID 但不复述原文 → 命中（ID 是结构化引用）', () => {
    const prd = 'US-001: 给 runtime 加一个 hash 工具';
    const plan = '已实现 US-001，参考 SKILL.md 路径';
    const result = evaluatePrdConsistency(prd, [plan]);
    assert.equal(result.consistency, 1);
    assert.equal(result.passed, true);
    assert.ok(result.covered[0].coverageProof?.includes('US-001 found in artifacts'));
  });
});

describe('evaluatePrdConsistency — 移除策略 3 后防自评自满', () => {
  /**
   * M0-2 核心验证点：
   * - 旧版：LLM 把 PRD 需求文本前 20 字符复述到 plan → 自动 100% 一致（自评自满）
   * - 新版：必须 hash 精确命中或 ID 出现才算覆盖
   */
  it('LLM 复述需求文本但未引用 ID → 不应命中（防自评自满回归）', () => {
    const prd = 'US-001: 给 runtime 加一个 sha256 hash 工具\nAC-001: 输入文本返回 hex 字符串';
    const plan = [
      '执行计划：',
      '给 runtime 加一个 sha256 工具，',
      '输入文本返回 hex 字符串。',
      '实现：crypto.createHash("sha256")',
    ].join('\n');
    const result = evaluatePrdConsistency(prd, [plan]);
    // 旧版会返回 1.0（前 20 字符匹配）
    // 新版应 < 1.0（既无 hash 精确匹配，也无 ID 出现）
    assert.ok(result.consistency < 1, `consistency 应小于 1，实际 ${result.consistency}`);
    assert.equal(result.uncovered.length, 2);
    assert.equal(result.passed, false);
  });

  it('ID 部分引用 → 部分一致', () => {
    const prd = 'US-001: A\nAC-001: B\nAC-002: C\nAC-003: D';
    const plan = 'US-001 done\nAC-001 done';
    const result = evaluatePrdConsistency(prd, [plan]);
    assert.equal(result.consistency, 0.5);
    assert.equal(result.passed, false);
  });
});

describe('parseReviewVerdict', () => {
  it('英文 PASS', () => {
    assert.equal(parseReviewVerdict('VERDICT: PASS\nNo issues found.'), 'PASS');
    assert.equal(parseReviewVerdict('review: PASS'), 'PASS');
  });

  it('英文 FAIL', () => {
    assert.equal(parseReviewVerdict('VERDICT: FAIL\nISSUES: [..]'), 'FAIL');
    assert.equal(parseReviewVerdict('Result: FAIL'), 'FAIL');
  });

  it('PASS_WITH_RISKS 算 PASS', () => {
    assert.equal(parseReviewVerdict('PASS_WITH_RISKS：有低风险项'), 'PASS');
  });

  it('中文匹配', () => {
    assert.equal(parseReviewVerdict('审核通过'), 'PASS');
    assert.equal(parseReviewVerdict('不通过，存在 3 个问题'), 'FAIL');
    assert.equal(parseReviewVerdict('未通过验收'), 'FAIL');
  });

  it('无明确 verdict → null', () => {
    assert.equal(parseReviewVerdict('看起来还行'), null);
    assert.equal(parseReviewVerdict(''), null);
  });
});
