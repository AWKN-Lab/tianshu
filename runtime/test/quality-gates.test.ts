/**
 * Quality Gates 测试 — 验证修复后的 reviewGate / securityGate 不再"假达成"
 *
 * 用 node:test（Node 20+ 内置），不依赖 vitest native binding
 * 运行：node --import tsx --test test/quality-gates.test.ts
 *
 * 历史问题（v0.1）：
 * - reviewGate 默认 passed=true，注释说"由 agent-loop 调 LLM 执行"，但实际没人调
 * - securityGate 同样 passed=true 空壳
 * - 导致 L2 evaluateL2StopConditions 中 reviewGate 永远通过 → 停止条件永远满足
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewGate,
  securityGate,
  parseVerdict,
  cicdTesterGate,
  evaluateL2StopConditions,
  type GateContext,
  type TianhuoCicdGateContext,
} from '../src/gates/quality-gates.js';
import {
  REVIEW_COVERAGE_SCHEMA,
  REVIEW_RECEIPT_SCHEMA,
  REVIEW_VERDICT_SCHEMA,
  createAwknId,
  parseJsonValue,
  receiptPayloadHash,
  type ReviewReceipt,
} from '../src/contracts/public.js';

// 跑 typecheck/test/lint 命令的 gate 需要一个真实 cwd，这里用 runtime 自身
const RUNTIME_CWD = process.cwd();

function reviewReceipt(status: 'PASS' | 'PARTIAL'): ReviewReceipt {
  const coverage = {
    schema: REVIEW_COVERAGE_SCHEMA,
    plannedFiles: ['src/a.ts'],
    reviewedFiles: status === 'PASS' ? ['src/a.ts'] : [],
    excludedFiles: [],
    failedFiles: status === 'PASS' ? [] : ['src/a.ts'],
    plannedUnits: 1,
    completedUnits: status === 'PASS' ? 1 : 0,
    failedUnits: status === 'PASS' ? 0 : 1,
    fileCoverage: status === 'PASS' ? 1 : 0,
    riskCoverage: status === 'PASS' ? 1 : 0,
    missing: status === 'PASS' ? [] : [{ path: 'src/a.ts', reason: 'unit failed' }],
  } as const;
  const payload = parseJsonValue({
    schema: REVIEW_RECEIPT_SCHEMA,
    reviewRunId: createAwknId('reviewRun'),
    targetFingerprint: 'a'.repeat(64),
    planHash: 'b'.repeat(64),
    ruleBundleHash: 'c'.repeat(64),
    reviewerActors: [],
    findings: [],
    coverage,
    verdict: {
      schema: REVIEW_VERDICT_SCHEMA,
      status,
      reasonCodes: status === 'PASS' ? ['OK'] : ['UNIT_FAILED'],
      blockerFindingIds: [],
      coverage,
      evaluatedAt: '2026-07-28T08:00:00.000Z',
    },
    evidenceRefs: [],
  });
  return {
    schema: 'awkn-receipt-envelope/v1',
    receiptId: createAwknId('receipt'),
    receiptType: 'REVIEW',
    payloadSchema: REVIEW_RECEIPT_SCHEMA,
    executionId: createAwknId('execution'),
    traceId: createAwknId('trace'),
    aggregateType: 'review-target',
    aggregateId: 'target',
    producer: { schema: 'awkn-actor-ref/v1', actorId: 'review-service', actorType: 'service' },
    status: status === 'PASS' ? 'SUCCESS' : 'PARTIAL',
    payload: payload as ReviewReceipt['payload'],
    payloadHash: receiptPayloadHash(REVIEW_RECEIPT_SCHEMA, payload),
    artifactRefs: [],
    createdAt: '2026-07-28T08:00:00.000Z',
  };
}

describe('reviewGate — 修复后不再默认通过', () => {
  it('无 reviewVerdict → returned=false（M0-3 核心修复点）', async () => {
    const ctx: GateContext = { cwd: RUNTIME_CWD };
    const result = await reviewGate(ctx);
    assert.equal(result.passed, false);
    assert.ok(result.details.includes('未提供 review verdict'));
    assert.ok(result.suggestion?.includes('callSkill'));
  });

  it('传入 PASS verdict → passed=true', async () => {
    const ctx: GateContext = {
      cwd: RUNTIME_CWD,
      reviewVerdict: '审查结论：PASS，无致命问题。',
    };
    const result = await reviewGate(ctx);
    assert.equal(result.passed, true);
  });

  it('传入 FAIL verdict → passed=false', async () => {
    const ctx: GateContext = {
      cwd: RUNTIME_CWD,
      reviewVerdict: 'VERDICT: FAIL\nISSUES: [类型错误, 缺测试]',
    };
    const result = await reviewGate(ctx);
    assert.equal(result.passed, false);
    assert.ok(result.suggestion?.includes('ISSUES 清单'));
  });

  it('传入无明确标记的文本 → returned=false（不能让模糊输出假通过）', async () => {
    const ctx: GateContext = {
      cwd: RUNTIME_CWD,
      reviewVerdict: '看起来还行，没什么大问题。',
    };
    const result = await reviewGate(ctx);
    assert.equal(result.passed, false);
    assert.ok(result.suggestion?.includes('未包含 PASS/FAIL 标记'));
  });

  it('enforce 仅接受结构化 PASS receipt', async () => {
    const passed = await reviewGate({ cwd: RUNTIME_CWD, reviewMode: 'enforce', reviewReceipt: reviewReceipt('PASS') });
    const partial = await reviewGate({ cwd: RUNTIME_CWD, reviewMode: 'enforce', reviewReceipt: reviewReceipt('PARTIAL') });
    assert.equal(passed.passed, true);
    assert.equal(partial.passed, false);
    assert.deepEqual(partial.reasonCodes, ['UNIT_FAILED']);
  });

  it('shadow 保持 legacy verdict 权威', async () => {
    const result = await reviewGate({
      cwd: RUNTIME_CWD,
      reviewMode: 'shadow',
      reviewVerdict: 'VERDICT: FAIL',
      reviewReceipt: reviewReceipt('PASS'),
    });
    assert.equal(result.passed, false);
  });
});

describe('securityGate — 独立安全证据', () => {
  it('无 securityVerdict → returned=false（M0-4 核心修复点）', async () => {
    const ctx: GateContext = { cwd: RUNTIME_CWD };
    const result = await securityGate(ctx);
    assert.equal(result.passed, false);
    assert.ok(result.details.includes('未提供 security 扫描结果'));
  });

  it('传入 PASS verdict → passed=true', async () => {
    const ctx: GateContext = {
      cwd: RUNTIME_CWD,
      securityVerdict: '安全扫描 PASS，无密钥泄露。',
    };
    const result = await securityGate(ctx);
    assert.equal(result.passed, true);
  });
});

describe('parseVerdict — cicd-tester VERDICT 格式', () => {
  it('VERDICT: PASS', () => {
    assert.equal(parseVerdict('VERDICT: PASS'), 'PASS');
  });

  it('VERDICT: FAIL', () => {
    assert.equal(parseVerdict('VERDICT: FAIL\nISSUES: [...]'), 'FAIL');
  });

  it('大小写不敏感', () => {
    assert.equal(parseVerdict('verdict: pass'), 'PASS');
    assert.equal(parseVerdict('Verdict: Fail'), 'FAIL');
  });

  it('无 VERDICT 标记 → null', () => {
    assert.equal(parseVerdict('看起来不错'), null);
    assert.equal(parseVerdict(''), null);
  });
});

describe('cicdTesterGate', () => {
  it('cicd-tester 输出 PASS → passed=true', async () => {
    const ctx: TianhuoCicdGateContext = {
      cwd: RUNTIME_CWD,
      cicdTesterVerdict: 'VERDICT: PASS',
    };
    const result = await cicdTesterGate(ctx);
    assert.equal(result.passed, true);
  });

  it('cicd-tester 输出 FAIL → passed=false', async () => {
    const ctx: TianhuoCicdGateContext = {
      cwd: RUNTIME_CWD,
      cicdTesterVerdict: 'VERDICT: FAIL\nISSUES: [hash 工具未注册]',
    };
    const result = await cicdTesterGate(ctx);
    assert.equal(result.passed, false);
    assert.ok(result.suggestion?.includes('ISSUES 清单'));
  });

  it('无 cicdTesterVerdict → returned=false', async () => {
    const ctx: TianhuoCicdGateContext = { cwd: RUNTIME_CWD };
    const result = await cicdTesterGate(ctx);
    assert.equal(result.passed, false);
    assert.ok(result.details.includes('无 cicd-tester 评审输出'));
  });
});

describe('evaluateL2StopConditions — 修复后不再假达成', () => {
  /**
   * 核心回归测试：v0.1 中 reviewGate 永远 passed=true，导致即使无真实 review
   * evaluateL2StopConditions 也可能因其他 3 项通过而假达成。
   * 修复后，无 reviewVerdict 时 reviewGate 必 FAIL，整个 L2 不应 achieved。
   */
  it('无 reviewVerdict 时 → achieved=false（无论其他 gate 如何）', async () => {
    const ctx: GateContext = { cwd: RUNTIME_CWD };
    const result = await evaluateL2StopConditions(ctx);
    assert.equal(result.achieved, false);
    const reviewResult = result.results.find((g) => g.name === 'reviewGate');
    assert.equal(reviewResult?.passed, false);
  });
});
