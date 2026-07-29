import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REVIEW_SCOPE_SPEC_SCHEMA,
  ReviewReceiptSchema,
  createAwknId,
  stableHash,
  type ActorRef,
  type ReviewScopeSpec,
} from '../src/contracts/public.js';
import {
  ReviewService,
  type ReviewAuditPort,
  type ReviewerPort,
  type ReviewSpecProviderPort,
  type ReviewWorkspacePort,
} from '../src/review/public.js';

const now = '2026-07-28T08:00:00.000Z';
const serviceActor: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'review-service', actorType: 'service' };
const implementer: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'builder', actorType: 'assistant' };
const reviewerActor: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'reviewer', actorType: 'assistant' };
const evidenceId = createAwknId('evidence');

function makeScope(): ReviewScopeSpec {
  const fileHash = stableHash('awkn-test-file/v1', { patch: '+safe' });
  return {
    schema: REVIEW_SCOPE_SPEC_SCHEMA,
    provider: 'native-git',
    providerVersion: 'native-git/v1',
    repositoryRoot: 'D:\\repo',
    baseRef: '1'.repeat(40),
    headRef: 'WORKTREE',
    mergeBase: '1'.repeat(40),
    diffFingerprint: stableHash('awkn-test-diff/v1', { fileHash }),
    files: [{
      path: 'src/a.ts',
      status: 'MODIFIED',
      insertions: 1,
      deletions: 0,
      diffFingerprint: fileHash,
      willReview: true,
      ruleGroupIds: [],
    }],
    ruleGroups: [],
  };
}

function dependencies(options?: {
  readonly currentFingerprint?: string;
  readonly reviewer?: ReviewerPort;
  readonly audit?: ReviewAuditPort;
}) {
  const scope = makeScope();
  const specProvider: ReviewSpecProviderPort = {
    provider: 'native-git',
    async createScope() { return scope; },
  };
  const workspace: ReviewWorkspacePort = {
    async freeze() {
      return {
        targetFingerprint: options?.currentFingerprint ?? scope.diffFingerprint,
        files: [{
          path: 'src/a.ts',
          patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+safe\n',
          diffFingerprint: scope.files[0]!.diffFingerprint,
        }],
      };
    },
    async currentFingerprint() { return options?.currentFingerprint ?? scope.diffFingerprint; },
  };
  const reviewer: ReviewerPort = options?.reviewer ?? {
    actor: reviewerActor,
    supportedRisk: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    async reviewUnit() {
      return { reviewer: reviewerActor, findings: [], evidenceRefs: [evidenceId], usage: { totalTokens: 17 } };
    },
  };
  return { scope, specProvider, workspace, reviewer, audit: options?.audit };
}

async function runService(options?: Parameters<typeof dependencies>[0]) {
  const deps = dependencies(options);
  const service = new ReviewService({
    specProvider: deps.specProvider,
    workspace: deps.workspace,
    reviewers: [deps.reviewer],
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    clock: () => now,
  });
  const target = await service.prepare({ repositoryRoot: 'D:\\repo', mode: 'WORKTREE' }, {
    initiator: implementer,
    implementer,
    createdAt: now,
  });
  const plan = await service.plan(target);
  const context = {
    executionId: createAwknId('execution'),
    traceId: createAwknId('trace'),
    serviceActor,
    artifactRefs: [],
    evidence: [{
      schema: 'awkn-evidence/v2' as const,
      evidenceId,
      executionId: createAwknId('execution'),
      traceId: createAwknId('trace'),
      claimIds: [],
      type: 'artifact' as const,
      level: 1 as const,
      contentHash: deps.scope.diffFingerprint,
      sourceRef: {
        schema: 'awkn-source-ref/v1' as const,
        sourceKind: 'tool_observation' as const,
        sourceId: 'test-frozen-diff',
        contentHash: deps.scope.diffFingerprint,
      },
      observedAt: now,
      producer: serviceActor,
      verifiedBy: [],
    }],
  };
  context.evidence[0]!.executionId = context.executionId;
  context.evidence[0]!.traceId = context.traceId;
  const run = await service.execute(plan, context);
  const receipt = await service.evaluate(run, context);
  return { run, receipt };
}

describe('ReviewService', () => {
  it('requires an implementer actor at the core service boundary', async () => {
    const deps = dependencies();
    const service = new ReviewService({
      specProvider: deps.specProvider,
      workspace: deps.workspace,
      reviewers: [deps.reviewer],
      clock: () => now,
    });
    await assert.rejects(
      service.prepare(
        { repositoryRoot: 'D:\\repo', mode: 'WORKTREE' },
        { initiator: implementer, createdAt: now } as never,
      ),
      /implementer/i,
    );
  });

  it('produces a hashed PASS receipt and accounts reviewer tokens', async () => {
    let persisted = false;
    const audit: ReviewAuditPort = { async persist() { persisted = true; } };
    const { run, receipt } = await runService({ audit });
    assert.equal(run.totalTokens, 17);
    assert.equal(receipt.payload.verdict.status, 'PASS');
    assert.equal(receipt.status, 'SUCCESS');
    assert.equal(ReviewReceiptSchema.safeParse(receipt).success, true);
    assert.equal(persisted, true);
  });

  it('returns STALE and never runs a reviewer when fingerprint changed', async () => {
    let called = false;
    const reviewer: ReviewerPort = {
      actor: reviewerActor,
      supportedRisk: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      async reviewUnit() {
        called = true;
        return { reviewer: reviewerActor, findings: [], evidenceRefs: [], usage: { totalTokens: 1 } };
      },
    };
    const { receipt } = await runService({ currentFingerprint: 'f'.repeat(64), reviewer });
    assert.equal(called, false);
    assert.equal(receipt.payload.verdict.status, 'STALE');
    assert.equal(receipt.status, 'FAILURE');
  });

  it('rejects actual self-review and fails closed as PARTIAL', async () => {
    const routedReviewer: ReviewerPort = {
      actor: reviewerActor,
      supportedRisk: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      async reviewUnit() {
        return { reviewer: implementer, findings: [], evidenceRefs: [], usage: { totalTokens: 3 } };
      },
    };
    const { receipt } = await runService({ reviewer: routedReviewer });
    assert.equal(receipt.payload.verdict.status, 'PARTIAL');
    assert.ok(receipt.payload.verdict.reasonCodes.includes('UNIT_FAILED'));
  });

  it('fails on an independently verified high finding', async () => {
    const blockingReviewer: ReviewerPort = {
      actor: reviewerActor,
      supportedRisk: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      async reviewUnit(request) {
        return {
          reviewer: reviewerActor,
          evidenceRefs: [evidenceId],
          usage: { totalTokens: 9 },
          findings: [{
            axis: 'CODE',
            category: 'CORRECTNESS',
            severity: 'HIGH',
            confidence: 0.95,
            path: request.unit.paths[0]!,
            startLine: 1,
            endLine: 1,
            positionStatus: 'EXACT',
            message: 'The validation branch is bypassed.',
            impact: 'Invalid state can be persisted.',
            suggestedFix: 'Restore validation before persistence.',
            rationaleSummary: 'The patch deletes the only guard.',
            ruleRefs: [],
            specRefs: [],
            evidenceRefs: [evidenceId],
            verificationKind: 'DETERMINISTIC_TOOL',
          }],
        };
      },
    };
    const { receipt } = await runService({ reviewer: blockingReviewer });
    assert.equal(receipt.payload.verdict.status, 'FAIL');
    assert.equal(receipt.payload.verdict.blockerFindingIds.length, 1);
  });

  it('marks a finding outside the frozen diff as INVALID', async () => {
    const invalidReviewer: ReviewerPort = {
      actor: reviewerActor,
      supportedRisk: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      async reviewUnit(request) {
        return {
          reviewer: reviewerActor,
          evidenceRefs: [evidenceId],
          usage: { totalTokens: 4 },
          findings: [{
            axis: 'CODE', category: 'CORRECTNESS', severity: 'MEDIUM', confidence: 0.9,
            path: request.unit.paths[0]!, startLine: 99, endLine: 99, positionStatus: 'EXACT',
            message: 'Out of range.', impact: 'Unknown.', suggestedFix: 'Relocate it.',
            rationaleSummary: 'The cited line is not in the frozen patch.', ruleRefs: [], specRefs: [],
            evidenceRefs: [evidenceId], verificationKind: 'DETERMINISTIC_TOOL',
          }],
        };
      },
    };
    const { receipt } = await runService({ reviewer: invalidReviewer });
    assert.equal(receipt.payload.verdict.status, 'INVALID');
    assert.ok(receipt.payload.verdict.reasonCodes.includes('FINDING_INVALID'));
  });

  it('rejects evidence references outside the frozen execution', async () => {
    const forgedEvidence = createAwknId('evidence');
    const invalidReviewer: ReviewerPort = {
      actor: reviewerActor,
      supportedRisk: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      async reviewUnit(request) {
        return {
          reviewer: reviewerActor,
          evidenceRefs: [forgedEvidence],
          usage: { totalTokens: 4 },
          findings: [{
            axis: 'CODE', category: 'CORRECTNESS', severity: 'MEDIUM', confidence: 0.9,
            path: request.unit.paths[0]!, startLine: 1, endLine: 1, positionStatus: 'EXACT',
            message: 'Forged evidence.', impact: 'Unverifiable.', suggestedFix: 'Use frozen evidence.',
            rationaleSummary: 'The evidence ID is not part of the execution.', ruleRefs: [], specRefs: [],
            evidenceRefs: [forgedEvidence], verificationKind: 'DETERMINISTIC_TOOL',
          }],
        };
      },
    };
    const { receipt } = await runService({ reviewer: invalidReviewer });
    assert.equal(receipt.payload.verdict.status, 'PARTIAL');
  });

  it('fails closed when the final target freshness check fails', async () => {
    const deps = dependencies();
    const workspace: ReviewWorkspacePort = {
      ...deps.workspace,
      async currentFingerprint() { throw new Error('git unavailable'); },
    };
    const service = new ReviewService({
      specProvider: deps.specProvider,
      workspace,
      reviewers: [deps.reviewer],
      clock: () => now,
    });
    const target = await service.prepare({ repositoryRoot: 'D:\\repo', mode: 'WORKTREE' }, {
      initiator: implementer, implementer, createdAt: now,
    });
    const plan = await service.plan(target);
    const context = {
      executionId: createAwknId('execution'), traceId: createAwknId('trace'), serviceActor,
      artifactRefs: [], evidence: [],
    };
    const run = await service.execute(plan, context);
    const receipt = await service.evaluate(run, context);
    assert.equal(run.providerStatus, 'INVALID');
    assert.equal(receipt.payload.verdict.status, 'PARTIAL');
  });
});
