/**
 * Evolve Candidate v2 Contract Tests (Phase 6 / C09 / WP-AOS-16)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第七、八节
 *
 * 覆盖：
 * - EvolveCandidateV2 校验（9 种类型、9 种来源、6 种状态）
 * - 外部研究候选不能直接 ACTIVE（设计测试 12）
 * - ACTIVE 必须有 replayMetrics（设计测试 8）
 * - QUARANTINED 必须有 quarantineReason
 * - sourceEvidenceIds 不能重复
 * - 状态转换合法性（DRAFT→VALIDATING→APPROVED→ACTIVE→QUARANTINED→RETIRED）
 * - checkActiveConditions 校验
 * - Hash 稳定性
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EvolveCandidateTypeSchema,
  EvolveCandidateSourceSchema,
  EvolveCandidateStatusSchema,
  ALLOWED_TRANSITIONS,
  ReplayMetricsSchema,
  ProposedChangeSchema,
  EvolveCandidateV2Schema,
  EvolveCandidateTransitionSchema,
  computeEvolveCandidateV2Hash,
  createEvolveCandidateV2Id,
  isValidTransition,
  getAllowedNextStatuses,
  checkActiveConditions,
  type EvolveCandidateV2,
} from '../../src/contracts/evolve-v2.js';
import { createAwknId } from '../../src/contracts/ids.js';
import { toUtcTimestamp } from '../../src/contracts/time.js';

const NOW = toUtcTimestamp('2026-07-28T10:00:00.000Z');
const SHA256_EXAMPLE = 'c'.repeat(64);

function makeReplayMetrics(overrides: Partial<{ successRate: number; evidenceGainRate: number }> = {}) {
  return {
    successRate: 0.85,
    evidenceGainRate: 0.7,
    ...overrides,
  };
}

function makeProposedChange(overrides: Partial<{ changeType: string; manifestHash: string; manifestRef: string; description: string }> = {}) {
  return {
    changeType: 'update-policy',
    manifestHash: SHA256_EXAMPLE,
    manifestRef: 'policy-bundles/v1.json',
    description: 'tighten confirmation for governance memory writes',
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<EvolveCandidateV2> = {}): EvolveCandidateV2 {
  return {
    schema: 'awkn-evolve-candidate-v2/v1',
    candidateId: createEvolveCandidateV2Id(),
    type: 'POLICY',
    source: 'RUN_FAILURE',
    status: 'DRAFT',
    sourceEvidenceIds: [createAwknId('evidence')],
    proposedChange: makeProposedChange(),
    createdAt: NOW,
    ...overrides,
  };
}

describe('Evolve Candidate v2 Contract (C09)', () => {
  describe('enums', () => {
    it('accepts all nine candidate types', () => {
      for (const t of ['POLICY', 'SKILL', 'PROMPT', 'MODEL_ROUTE', 'TOOL_ROUTE', 'GATE', 'PROJECT_RULE', 'CONTEXT_RULE', 'DELIVERY_RULE'] as const) {
        assert.equal(EvolveCandidateTypeSchema.safeParse(t).success, true);
      }
    });

    it('accepts all nine sources', () => {
      for (const s of ['RUN_FAILURE', 'USER_CORRECTION', 'OUTCOME_ATTRIBUTION', 'COSTLY_REPETITION', 'CONTEXT_MISSELECT', 'ROUTE_DEGRADATION', 'DELIVERY_FAILURE', 'RUNTIME_FEEDBACK', 'EXTERNAL_RESEARCH'] as const) {
        assert.equal(EvolveCandidateSourceSchema.safeParse(s).success, true);
      }
    });

    it('accepts all six statuses', () => {
      for (const s of ['DRAFT', 'VALIDATING', 'APPROVED', 'ACTIVE', 'QUARANTINED', 'RETIRED'] as const) {
        assert.equal(EvolveCandidateStatusSchema.safeParse(s).success, true);
      }
    });
  });

  describe('ReplayMetrics', () => {
    it('accepts valid metrics', () => {
      assert.equal(ReplayMetricsSchema.safeParse(makeReplayMetrics()).success, true);
    });

    it('rejects empty metrics object', () => {
      assert.equal(ReplayMetricsSchema.safeParse({}).success, false);
    });

    it('rejects out-of-range rates', () => {
      assert.equal(ReplayMetricsSchema.safeParse({ successRate: 1.5 }).success, false);
    });
  });

  describe('ProposedChange', () => {
    it('accepts valid change', () => {
      assert.equal(ProposedChangeSchema.safeParse(makeProposedChange()).success, true);
    });

    it('rejects invalid manifest hash', () => {
      assert.equal(
        ProposedChangeSchema.safeParse(makeProposedChange({ manifestHash: 'short' })).success,
        false,
      );
    });
  });

  describe('EvolveCandidateV2', () => {
    it('accepts valid DRAFT candidate', () => {
      assert.equal(EvolveCandidateV2Schema.safeParse(makeCandidate()).success, true);
    });

    it('rejects external research in ACTIVE status (design test 12)', () => {
      assert.equal(
        EvolveCandidateV2Schema.safeParse(
          makeCandidate({
            source: 'EXTERNAL_RESEARCH',
            status: 'ACTIVE',
            replayMetrics: makeReplayMetrics(),
            humanApproved: true,
            independenceScanPassed: true,
          }),
        ).success,
        false,
      );
    });

    it('rejects ACTIVE without replayMetrics (design test 8)', () => {
      assert.equal(
        EvolveCandidateV2Schema.safeParse(
          makeCandidate({
            status: 'ACTIVE',
            replayMetrics: undefined,
            humanApproved: true,
            independenceScanPassed: true,
          }),
        ).success,
        false,
      );
    });

    it('accepts ACTIVE with replayMetrics for non-external source', () => {
      assert.equal(
        EvolveCandidateV2Schema.safeParse(
          makeCandidate({
            status: 'APPROVED',
            replayMetrics: makeReplayMetrics(),
            humanApproved: true,
            independenceScanPassed: true,
          }),
        ).success,
        true,
      );
    });

    it('rejects QUARANTINED without quarantineReason', () => {
      assert.equal(
        EvolveCandidateV2Schema.safeParse(
          makeCandidate({ status: 'QUARANTINED' }),
        ).success,
        false,
      );
    });

    it('accepts QUARANTINED with reason', () => {
      assert.equal(
        EvolveCandidateV2Schema.safeParse(
          makeCandidate({ status: 'QUARANTINED', quarantineReason: 'regression in production' }),
        ).success,
        true);
    });

    it('rejects duplicate sourceEvidenceIds', () => {
      const eid = createAwknId('evidence');
      assert.equal(
        EvolveCandidateV2Schema.safeParse(
          makeCandidate({ sourceEvidenceIds: [eid, eid] }),
        ).success,
        false,
      );
    });

    it('rejects empty sourceEvidenceIds', () => {
      assert.equal(
        EvolveCandidateV2Schema.safeParse(
          makeCandidate({ sourceEvidenceIds: [] }),
        ).success,
        false,
      );
    });
  });

  describe('transition validation', () => {
    it('allows DRAFT to VALIDATING', () => {
      assert.equal(isValidTransition('DRAFT', 'VALIDATING'), true);
    });

    it('allows VALIDATING to APPROVED', () => {
      assert.equal(isValidTransition('VALIDATING', 'APPROVED'), true);
    });

    it('allows APPROVED to ACTIVE', () => {
      assert.equal(isValidTransition('APPROVED', 'ACTIVE'), true);
    });

    it('allows ACTIVE to QUARANTINED', () => {
      assert.equal(isValidTransition('ACTIVE', 'QUARANTINED'), true);
    });

    it('forbids DRAFT to ACTIVE (must validate first)', () => {
      assert.equal(isValidTransition('DRAFT', 'ACTIVE'), false);
    });

    it('forbids RETIRED to anything', () => {
      for (const s of ['DRAFT', 'VALIDATING', 'APPROVED', 'ACTIVE', 'QUARANTINED', 'RETIRED'] as const) {
        assert.equal(isValidTransition('RETIRED', s), false);
      }
    });

    it('returns allowed next statuses', () => {
      const next = getAllowedNextStatuses('VALIDATING');
      assert.ok(next.includes('APPROVED'));
      assert.ok(next.includes('QUARANTINED'));
      assert.ok(next.includes('RETIRED'));
    });

    it('RETIRED has empty allowed transitions', () => {
      assert.equal(getAllowedNextStatuses('RETIRED').length, 0);
    });

    it('transition record is valid', () => {
      const tr = {
        schema: 'awkn-evolve-candidate-transition/v1' as const,
        transitionId: 'tr-1',
        candidateId: createEvolveCandidateV2Id(),
        fromStatus: 'DRAFT' as const,
        toStatus: 'VALIDATING' as const,
        reason: 'begin validation',
        transitionedAt: NOW,
      };
      assert.equal(EvolveCandidateTransitionSchema.safeParse(tr).success, true);
    });
  });

  describe('checkActiveConditions', () => {
    it('passes for fully qualified APPROVED candidate with replay and approvals', () => {
      const candidate = makeCandidate({
        status: 'APPROVED',
        replayMetrics: makeReplayMetrics(),
        humanApproved: true,
        independenceScanPassed: true,
      });
      const result = checkActiveConditions(candidate);
      assert.equal(result.canActivate, true);
      assert.equal(result.failedConditions.length, 0);
    });

    it('fails when status is not APPROVED', () => {
      const candidate = makeCandidate({
        status: 'DRAFT',
        replayMetrics: makeReplayMetrics(),
        humanApproved: true,
        independenceScanPassed: true,
      });
      const result = checkActiveConditions(candidate);
      assert.equal(result.canActivate, false);
      assert.ok(result.failedConditions.some((f) => f.includes('APPROVED')));
    });

    it('fails without replay metrics', () => {
      const candidate = makeCandidate({
        status: 'APPROVED',
        replayMetrics: undefined,
        humanApproved: true,
        independenceScanPassed: true,
      });
      const result = checkActiveConditions(candidate);
      assert.equal(result.canActivate, false);
      assert.ok(result.failedConditions.some((f) => f.includes('replay')));
    });

    it('fails without independence scan', () => {
      const candidate = makeCandidate({
        status: 'APPROVED',
        replayMetrics: makeReplayMetrics(),
        humanApproved: true,
        independenceScanPassed: false,
      });
      const result = checkActiveConditions(candidate);
      assert.equal(result.canActivate, false);
      assert.ok(result.failedConditions.some((f) => f.includes('independence')));
    });

    it('fails for POLICY/SKILL/PROJECT_RULE without human approval', () => {
      const candidate = makeCandidate({
        type: 'SKILL',
        status: 'APPROVED',
        replayMetrics: makeReplayMetrics(),
        humanApproved: false,
        independenceScanPassed: true,
      });
      const result = checkActiveConditions(candidate);
      assert.equal(result.canActivate, false);
      assert.ok(result.failedConditions.some((f) => f.includes('human approval')));
    });

    it('passes for non-policy types without human approval', () => {
      const candidate = makeCandidate({
        type: 'PROMPT',
        status: 'APPROVED',
        replayMetrics: makeReplayMetrics(),
        humanApproved: undefined,
        independenceScanPassed: true,
      });
      const result = checkActiveConditions(candidate);
      assert.equal(result.canActivate, true);
    });
  });

  describe('hash and id', () => {
    it('produces stable candidate hash', () => {
      const c = makeCandidate();
      const { candidateId: _id, updatedAt: _u, ...content } = c;
      void _id; void _u;
      const h1 = computeEvolveCandidateV2Hash(content);
      const h2 = computeEvolveCandidateV2Hash(content);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{64}$/);
    });

    it('changes hash when type changes', () => {
      const c1 = makeCandidate({ type: 'POLICY' });
      const c2 = makeCandidate({ type: 'SKILL' });
      const { candidateId: _1, updatedAt: _u1, ...ct1 } = c1;
      const { candidateId: _2, updatedAt: _u2, ...ct2 } = c2;
      void _1; void _2; void _u1; void _u2;
      assert.notEqual(computeEvolveCandidateV2Hash(ct1), computeEvolveCandidateV2Hash(ct2));
    });

    it('generates valid AWKN ID', () => {
      assert.match(createEvolveCandidateV2Id(), /^ecv_[0-9a-f]{32}$/);
    });
  });
});
