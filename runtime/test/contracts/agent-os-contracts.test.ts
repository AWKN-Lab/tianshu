import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ActorRefSchema,
  AuthorizationRecordSchema,
  ClaimSchema,
  DomainEventSchema,
  EvidenceRecordSchema,
  GoalSpecSchema,
  LoopEligibilityDecisionSchema,
  stableHash,
} from '../../src/contracts/public.js';

const id = (prefix: string, digit: string): string => `${prefix}_${digit.repeat(32)}`;

const actor = ActorRefSchema.parse({
  schema: 'awkn-actor-ref/v1',
  actorId: 'user-1',
  actorType: 'human',
  userId: 'user-1',
  projectId: 'tianshu',
});

const sourceRef = {
  schema: 'awkn-source-ref/v1' as const,
  sourceKind: 'current_human_message' as const,
  sourceId: 'message-1',
  observedAt: '2026-07-26T12:00:00.000Z',
};

describe('Claim v3', () => {
  it('keeps epistemic status and confirmation level as orthogonal axes', () => {
    const content = 'Use the contract-first migration plan.';
    const claim = ClaimSchema.parse({
      schema: 'awkn-claim/v3',
      claimId: id('clm', '1'),
      content,
      contentHash: stableHash('awkn-claim-content/v1', content),
      originator: 'human',
      speaker: 'human',
      claimType: 'decision',
      epistemicStatus: 'asserted',
      confirmationLevel: 'field',
      sourceRefs: [sourceRef],
      derivedFrom: [],
      authority: 1,
      confidence: 1,
      sensitivityClass: 'internal',
      projectId: 'tianshu',
      userId: 'user-1',
    });

    assert.equal(claim.epistemicStatus, 'asserted');
    assert.equal(claim.confirmationLevel, 'field');
  });

  it('rejects the removed v2 confirmed status and invalid observations', () => {
    const base = {
      schema: 'awkn-claim/v3',
      claimId: id('clm', '2'),
      content: 'Observed state',
      contentHash: 'a'.repeat(64),
      originator: 'assistant',
      speaker: 'assistant',
      claimType: 'observation',
      confirmationLevel: 'none',
      sourceRefs: [sourceRef],
      derivedFrom: [],
      authority: 0.5,
      confidence: 0.5,
      sensitivityClass: 'internal',
    };

    assert.throws(() => ClaimSchema.parse({ ...base, epistemicStatus: 'confirmed' }));
    assert.throws(() => ClaimSchema.parse({ ...base, epistemicStatus: 'observed' }), /tool speaker|system originator/);
  });
});

describe('GoalSpec v3', () => {
  const goal = {
    schema: 'awkn-goal-spec/v3' as const,
    goalId: id('goal', '3'),
    title: 'Freeze core contracts',
    desiredState: {
      description: 'Core contracts compile and pass contract tests.',
      successSignals: ['npm run check passes'],
    },
    scope: {
      included: ['runtime/src/contracts'],
      excluded: ['runtime/src/core/agent-loop.ts'],
    },
    acceptanceCriteria: [{
      criterionId: 'ac-1',
      description: 'Contract tests pass',
      required: true,
      evaluator: 'deterministic' as const,
      evidenceSourceIds: ['test-suite'],
    }],
    evidenceSources: [{
      sourceId: 'test-suite',
      sourceType: 'test' as const,
      required: true,
      minimumLevel: 4,
    }],
    constraints: [{
      constraintId: 'constraint-1',
      description: 'Do not modify AgentLoop',
      severity: 'HARD' as const,
      evaluator: 'deterministic' as const,
    }],
    assumptions: [],
    budget: {
      maxCycles: 5,
      maxTokens: 100000,
      maxDurationMs: 3600000,
    },
    stopPolicy: {
      noGainCycleLimit: 2,
      onBudgetExceeded: 'PAUSE' as const,
      onBlocked: 'ASK_USER' as const,
      onUncertain: 'PAUSE' as const,
    },
    judgePolicy: {
      judgeVersion: 'goal-judge/v1',
      minimumEvidenceLevel: 4,
      requireAllAcceptanceCriteria: true,
      requireAllHardConstraints: true,
      requiredGateTypes: ['contract-tests'],
    },
    deliveryExpectation: {
      modes: ['CONNECTED_SYSTEM'] as const,
      primaryMode: 'CONNECTED_SYSTEM' as const,
      successPredicate: { pullRequestCreated: true },
    },
    taskProfile: 'engineering',
    riskLevel: 'R2' as const,
    createdBy: actor,
    createdAt: '2026-07-26T12:00:00.000Z',
  };

  it('accepts a fully linked goal', () => {
    assert.equal(GoalSpecSchema.parse(goal).goalId, id('goal', '3'));
  });

  it('rejects missing evidence links and invalid primary delivery', () => {
    assert.throws(() => GoalSpecSchema.parse({
      ...goal,
      acceptanceCriteria: [{ ...goal.acceptanceCriteria[0], evidenceSourceIds: ['missing'] }],
    }), /unknown evidence source/);
    assert.throws(() => GoalSpecSchema.parse({
      ...goal,
      deliveryExpectation: {
        ...goal.deliveryExpectation,
        modes: ['FILE'],
      },
    }), /primaryMode must be included/);
  });

  it('requires eligible loop decisions to run', () => {
    assert.throws(() => LoopEligibilityDecisionSchema.parse({
      schema: 'awkn-loop-eligibility/v1',
      intentId: 'intent-1',
      eligible: true,
      targetLevel: 'L2',
      clarityScore: 1,
      evidenceAvailability: 1,
      toolCoverage: 1,
      stopConditionDeterminism: 1,
      unresolvedHighImpactFields: [],
      decision: 'ASK_USER',
      reasonCodes: [],
    }), /eligible loop decisions must be RUN/);
  });
});

describe('Evidence and Domain Event', () => {
  it('caps unverified model statements at evidence level 1', () => {
    assert.throws(() => EvidenceRecordSchema.parse({
      schema: 'awkn-evidence/v2',
      evidenceId: id('ev', '4'),
      executionId: id('exec', '5'),
      traceId: id('tr', '6'),
      claimIds: [],
      type: 'model_statement',
      level: 2,
      contentHash: 'b'.repeat(64),
      sourceRef,
      observedAt: '2026-07-26T12:00:00.000Z',
      producer: {
        schema: 'awkn-actor-ref/v1',
        actorId: 'assistant-1',
        actorType: 'assistant',
      },
      verifiedBy: [],
    }), /independent verifier/);
  });

  it('validates versioned, idempotent domain events', () => {
    const event = DomainEventSchema.parse({
      schema: 'awkn-domain-event/v1',
      eventId: id('evt', '7'),
      eventType: 'execution.received',
      eventVersion: 1,
      aggregateType: 'execution',
      aggregateId: id('exec', '5'),
      aggregateRevision: 0,
      executionId: id('exec', '5'),
      traceId: id('tr', '6'),
      actor,
      idempotencyKey: 'execution:received:1',
      receiptIds: [],
      payloadSchema: 'awkn-execution-received/v1',
      payload: { state: 'RECEIVED' },
      occurredAt: '2026-07-26T12:00:00.000Z',
    });
    assert.equal(event.eventVersion, 1);
  });
});

describe('AuthorizationRecord v1', () => {
  const base = {
    schema: 'awkn-authorization-token/v1' as const,
    authorizationId: id('auth', '8'),
    tokenHash: 'c'.repeat(64),
    actor,
    executionId: id('exec', '5'),
    allowedToolIds: ['github.create_file'],
    allowedOperations: ['create'],
    targetConstraints: { repository: 'AWKN-Lab/tianshu' },
    riskCeiling: 'R3' as const,
    maxUses: 1,
    usedCount: 0,
    status: 'ACTIVE' as const,
    issuedAt: '2026-07-26T12:00:00.000Z',
    expiresAt: '2026-07-26T13:00:00.000Z',
  };

  it('accepts active scoped authorization', () => {
    assert.equal(AuthorizationRecordSchema.parse(base).status, 'ACTIVE');
  });

  it('enforces consumption and revocation invariants', () => {
    assert.throws(() => AuthorizationRecordSchema.parse({
      ...base,
      status: 'CONSUMED',
      usedCount: 0,
    }), /full allowance/);
    assert.throws(() => AuthorizationRecordSchema.parse({
      ...base,
      status: 'REVOKED',
    }), /revokedAt is required/);
  });
});
