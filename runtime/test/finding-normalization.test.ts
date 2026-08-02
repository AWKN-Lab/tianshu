import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REVIEW_FINDING_SCHEMA,
  ReviewFindingSchema,
  createAwknId,
  type ActorRef,
  type ReviewFinding,
} from '../src/contracts/public.js';
import { normalizeFindings } from '../src/review/public.js';

const producer: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'reviewer-1', actorType: 'assistant' };
const verifier: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'reviewer-2', actorType: 'assistant' };
const evidenceId = createAwknId('evidence');
const unitId = createAwknId('reviewUnit');

function finding(overrides: Partial<ReviewFinding>): ReviewFinding {
  return ReviewFindingSchema.parse({
    schema: REVIEW_FINDING_SCHEMA,
    findingId: createAwknId('reviewFinding'),
    unitId,
    fingerprint: 'a'.repeat(64),
    axis: 'CODE',
    category: 'CORRECTNESS',
    severity: 'MEDIUM',
    confidence: 0.9,
    path: 'src/a.ts',
    startLine: 10,
    endLine: 10,
    positionStatus: 'EXACT',
    message: 'potential bug',
    impact: 'wrong behavior',
    suggestedFix: 'fix it',
    rationaleSummary: 'reasoning',
    ruleRefs: [],
    specRefs: [],
    evidenceRefs: [evidenceId],
    producer,
    verifiedBy: [verifier],
    verificationKind: 'INDEPENDENT_REVIEWER',
    disposition: 'OPEN',
    ...overrides,
  });
}

describe('normalizeFindings — Finding 去噪（P0-2）', () => {
  it('完全相同的重复项合并为一条', () => {
    const duplicate = finding({});
    const { findings, merged } = normalizeFindings([duplicate, { ...duplicate }]);
    assert.equal(findings.length, 1);
    assert.equal(merged, 1);
  });

  it('同文件同类别邻近行距 ≤ mergeDistance 合并，行范围为并集', () => {
    const a = finding({ startLine: 10, endLine: 12 });
    const b = finding({ startLine: 15, endLine: 16, message: 'nearby issue' });
    const { findings, merged } = normalizeFindings([a, b]);
    assert.equal(findings.length, 1);
    assert.equal(merged, 1);
    assert.equal(findings[0]!.startLine, 10);
    assert.equal(findings[0]!.endLine, 16);
    assert.ok(findings[0]!.rationaleSummary.includes('merged with 1 adjacent finding'));
    assert.ok(findings[0]!.findingId !== a.findingId, '合并后 fingerprint 需重新计算');
  });

  it('行距超过 mergeDistance 不合并', () => {
    const a = finding({ startLine: 10, endLine: 10 });
    const b = finding({ startLine: 50, endLine: 50 });
    const { findings, merged } = normalizeFindings([a, b]);
    assert.equal(findings.length, 2);
    assert.equal(merged, 0);
  });

  it('不同类别/轴/文件不合并', () => {
    const base = { startLine: 10, endLine: 12 };
    const differentCategory = finding({ ...base, category: 'SECURITY' });
    const differentAxis = finding({ ...base, axis: 'COVERAGE' });
    const differentPath = finding({ ...base, path: 'src/b.ts' });
    const { findings, merged } = normalizeFindings([
      finding(base),
      differentCategory,
      differentAxis,
      differentPath,
    ]);
    assert.equal(findings.length, 4);
    assert.equal(merged, 0);
  });

  it('低置信度 MEDIUM/LOW/INFO 被抑制', () => {
    const low = finding({ severity: 'LOW', confidence: 0.1 });
    const medium = finding({ severity: 'MEDIUM', confidence: 0.2 });
    const info = finding({ severity: 'INFO', confidence: 0.05 });
    const { findings, suppressed } = normalizeFindings([low, medium, info]);
    assert.equal(findings.length, 0);
    assert.equal(suppressed, 3);
  });

  it('HIGH/CRITICAL 不受低置信度抑制', () => {
    const high = finding({ severity: 'HIGH', confidence: 0.1, verificationKind: 'DETERMINISTIC_TOOL', startLine: 10, endLine: 10 });
    const critical = finding({ severity: 'CRITICAL', confidence: 0.05, verificationKind: 'DETERMINISTIC_TOOL', startLine: 40, endLine: 40 });
    const { findings, suppressed } = normalizeFindings([high, critical]);
    assert.equal(findings.length, 2);
    assert.equal(suppressed, 0);
  });

  it('置信度达到阈值保留', () => {
    const borderline = finding({ severity: 'MEDIUM', confidence: 0.35 });
    const { findings, suppressed } = normalizeFindings([borderline]);
    assert.equal(findings.length, 1);
    assert.equal(suppressed, 0);
  });

  it('可自定义阈值与合并距离', () => {
    const low = finding({ severity: 'MEDIUM', confidence: 0.5 });
    const { findings, suppressed } = normalizeFindings([low], { confidenceThreshold: 0.6 });
    assert.equal(findings.length, 0);
    assert.equal(suppressed, 1);

    const a = finding({ startLine: 10, endLine: 10 });
    const b = finding({ startLine: 15, endLine: 15 });
    const far = normalizeFindings([a, b], { mergeDistance: 4 });
    assert.equal(far.findings.length, 2);
  });

  it('合并结果仍满足 ReviewFinding 契约', () => {
    const a = finding({ severity: 'HIGH', startLine: 10, endLine: 12, verificationKind: 'INDEPENDENT_REVIEWER' });
    const b = finding({ severity: 'HIGH', startLine: 14, endLine: 15, verificationKind: 'INDEPENDENT_REVIEWER' });
    const { findings } = normalizeFindings([a, b]);
    assert.equal(findings.length, 1);
    assert.equal(ReviewFindingSchema.safeParse(findings[0]).success, true);
    assert.equal(findings[0]!.severity, 'HIGH');
    assert.equal(findings[0]!.confidence, 0.9);
  });

  it('跨 unit 不合并', () => {
    const a = finding({});
    const b = finding({ unitId: createAwknId('reviewUnit') });
    const { findings, merged } = normalizeFindings([a, b]);
    assert.equal(findings.length, 2);
    assert.equal(merged, 0);
  });

  it('合并取并集的 evidence/rule/verifier 引用', () => {
    const a = finding({ evidenceRefs: [createAwknId('evidence')] });
    const b = finding({ evidenceRefs: [createAwknId('evidence')] });
    const { findings } = normalizeFindings([a, b]);
    assert.equal(findings[0]!.evidenceRefs.length, 2);
  });

  it('输入乱序也能正确合并（内部按行号排序）', () => {
    const a = finding({ startLine: 10, endLine: 10 });
    const b = finding({ startLine: 50, endLine: 50 });
    const c = finding({ startLine: 12, endLine: 12 });
    const { findings, merged } = normalizeFindings([a, b, c]);
    assert.equal(findings.length, 2);
    assert.equal(merged, 1);
  });
});
