import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GoalFactoryInputSchema,
  GoalSpecSchema,
  LoopEligibilityReceiptPayloadSchema,
  receiptPayloadHash,
  type GoalFactoryInput,
  type IntentRouterInput,
  type LoopEligibilityInput,
} from '../../src/contracts/public.js';
import {
  buildGoalSpec,
  buildLoopEligibilityReceiptPayload,
  evaluateLoopEligibility,
  routeIntent,
} from '../../src/intent/public.js';

const inputId = `in_${'1'.repeat(32)}`;
const intentId = `intent_${'2'.repeat(32)}`;
const goalId = `goal_${'3'.repeat(32)}`;
const createdAt = '2026-07-27T04:00:00.000Z';

function routerInput(overrides: Partial<IntentRouterInput> = {}): IntentRouterInput {
  return {
    schema: 'awkn-intent-router-input/v1',
    inputId,
    sourceHash: 'a'.repeat(64),
    primaryIntent: 'repair code until checks pass',
    secondaryIntents: [],
    requestedOutcome: 'all checks pass',
    deliverableTypes: ['repository_change'],
    taskKind: 'engineering',
    operations: ['READ', 'WRITE'],
    toolCountHint: 2,
    dependencyCount: 0,
    iterative: true,
    deterministicAcceptance: true,
    multiAgent: false,
    externalSideEffects: false,
    timeDependency: 'none',
    confidence: 0.95,
    knownFields: ['repository'],
    missingFields: [],
    createdAt,
    ...overrides,
  };
}

function intent(overrides: Partial<IntentRouterInput> = {}) {
  return routeIntent({
    intentId,
    input: routerInput(overrides),
    routedAt: createdAt,
  });
}

function eligibilityInput(overrides: Partial<LoopEligibilityInput> = {}): LoopEligibilityInput {
  return {
    schema: 'awkn-loop-eligibility-input/v1',
    intent: intent(),
    clarityScore: 0.95,
    evidenceAvailability: 1,
    toolCoverage: 1,
    stopConditionDeterminism: 1,
    requiresTools: true,
    unresolvedHighImpactFields: [],
    evaluatedAt: createdAt,
    ...overrides,
  };
}

function eligibleDecision() {
  return evaluateLoopEligibility(eligibilityInput());
}

function goalFactoryInput(overrides: Partial<GoalFactoryInput> = {}): GoalFactoryInput {
  return {
    schema: 'awkn-goal-factory-input/v1',
    intent: intent(),
    eligibility: eligibleDecision(),
    goalId,
    title: 'Repair runtime checks',
    desiredState: {
      description: 'All required checks pass',
      successSignals: ['npm run check exits with code 0'],
    },
    scope: {
      included: ['runtime source and tests'],
      excluded: ['production deployment'],
    },
    acceptanceCriteria: [{
      criterionId: 'criterion-check',
      description: 'npm run check passes',
      required: true,
      evaluator: 'deterministic',
      evidenceSourceIds: ['source-test'],
    }],
    evidenceSources: [{
      sourceId: 'source-test',
      sourceType: 'test',
      required: true,
      minimumLevel: 3,
      freshnessClass: 'REAL_TIME',
    }],
    constraints: [],
    assumptions: [],
    assumptionBindings: [],
    budget: {
      maxCycles: 3,
      maxTokens: 20_000,
      maxDurationMs: 300_000,
    },
    stopPolicy: {
      noGainCycleLimit: 3,
      onBudgetExceeded: 'PAUSE',
      onBlocked: 'ASK_USER',
      onUncertain: 'PAUSE',
    },
    judgePolicy: {
      judgeVersion: 'goal-judge/v1',
      minimumEvidenceLevel: 3,
      requireAllAcceptanceCriteria: true,
      requireAllHardConstraints: true,
      requiredGateTypes: ['test'],
    },
    deliveryExpectation: {
      modes: ['CHAT'],
      primaryMode: 'CHAT',
      successPredicate: { kind: 'summary-delivered' },
    },
    riskLevel: 'R1',
    createdBy: {
      schema: 'awkn-actor-ref/v1',
      actorId: 'intent-goal-router',
      actorType: 'service',
    },
    createdAt,
    ...overrides,
  };
}

describe('loop eligibility gate', () => {
  it('skips loop execution for L0 and L1', () => {
    const l0 = intent({
      operations: ['ANALYZE'],
      toolCountHint: 0,
      iterative: false,
      deterministicAcceptance: false,
      taskKind: 'analysis',
    });
    const decision = evaluateLoopEligibility(eligibilityInput({ intent: l0, requiresTools: false }));
    assert.equal(decision.eligible, false);
    assert.equal(decision.decision, 'HUMAN_LED');
    assert.equal(decision.reasonCodes.includes('LOOP_NOT_REQUIRED'), true);
  });

  it('requires clarification for ASK_USER intents and unresolved high-impact fields', () => {
    const askIntent = intent({
      missingFields: [{
        fieldId: 'authorization',
        description: 'authorization scope is missing',
        answerImpact: 0.1,
        uncertaintyReduction: 0.1,
        safetyImpact: 0.1,
        irreversibility: 0.1,
        userEffort: 1,
        mandatoryReason: 'AUTHORIZATION_SCOPE_REQUIRED',
      }],
    });
    const ask = evaluateLoopEligibility(eligibilityInput({ intent: askIntent }));
    assert.equal(ask.eligible, false);
    assert.equal(ask.decision, 'ASK_USER');

    const unresolved = evaluateLoopEligibility(eligibilityInput({
      unresolvedHighImpactFields: ['production-target'],
    }));
    assert.equal(unresolved.eligible, false);
    assert.equal(unresolved.decision, 'ASK_USER');
  });

  it('freezes the plan when evidence, stop conditions or required tools are unavailable', () => {
    const noEvidence = evaluateLoopEligibility(eligibilityInput({ evidenceAvailability: 0 }));
    assert.equal(noEvidence.decision, 'FREEZE_PLAN');
    assert.equal(noEvidence.reasonCodes.includes('EVIDENCE_UNAVAILABLE'), true);

    const noStop = evaluateLoopEligibility(eligibilityInput({ stopConditionDeterminism: 0 }));
    assert.equal(noStop.decision, 'FREEZE_PLAN');
    assert.equal(noStop.reasonCodes.includes('STOP_CONDITION_NOT_DETERMINISTIC'), true);

    const noTools = evaluateLoopEligibility(eligibilityInput({ toolCoverage: 0 }));
    assert.equal(noTools.decision, 'FREEZE_PLAN');
    assert.equal(noTools.reasonCodes.includes('TOOL_COVERAGE_UNAVAILABLE'), true);
  });

  it('allows a fully specified L2 loop and emits a stable receipt payload', () => {
    const decision = eligibleDecision();
    assert.equal(decision.eligible, true);
    assert.equal(decision.decision, 'RUN');

    const payload = buildLoopEligibilityReceiptPayload(decision, createdAt);
    assert.equal(LoopEligibilityReceiptPayloadSchema.safeParse(payload).success, true);
    const first = receiptPayloadHash(payload.schema, payload);
    const second = receiptPayloadHash(payload.schema, payload);
    assert.equal(first, second);
  });
});

describe('GoalSpec factory', () => {
  it('builds strict GoalSpec v3 and derives taskProfile from IntentDecision', () => {
    const goal = buildGoalSpec(goalFactoryInput());
    assert.equal(GoalSpecSchema.safeParse(goal).success, true);
    assert.equal(goal.taskProfile, 'engineering');
    assert.equal(goal.goalId, goalId);
  });

  it('rejects L0/L1 intents and non-RUN eligibility decisions', () => {
    const l0 = intent({
      operations: ['ANALYZE'],
      toolCountHint: 0,
      iterative: false,
      deterministicAcceptance: false,
      taskKind: 'analysis',
    });
    const l0Eligibility = evaluateLoopEligibility(eligibilityInput({ intent: l0, requiresTools: false }));
    const invalidL0 = {
      ...goalFactoryInput(),
      intent: l0,
      eligibility: l0Eligibility,
    };
    assert.equal(GoalFactoryInputSchema.safeParse(invalidL0).success, false);

    const frozen = evaluateLoopEligibility(eligibilityInput({ evidenceAvailability: 0 }));
    assert.equal(GoalFactoryInputSchema.safeParse({
      ...goalFactoryInput(),
      eligibility: frozen,
    }).success, false);
  });

  it('requires every explicit Intent assumption to be represented in GoalSpec', () => {
    const assumptionIntent = intent({
      missingFields: [{
        fieldId: 'branch',
        description: 'target branch is not specified',
        answerImpact: 0.5,
        uncertaintyReduction: 0.5,
        safetyImpact: 0.4,
        irreversibility: 0.2,
        userEffort: 0.5,
      }],
    });
    const assumptionEligibility = evaluateLoopEligibility(eligibilityInput({
      intent: assumptionIntent,
      clarityScore: 0.8,
    }));

    const missingBinding = {
      ...goalFactoryInput(),
      intent: assumptionIntent,
      eligibility: assumptionEligibility,
    };
    assert.equal(GoalFactoryInputSchema.safeParse(missingBinding).success, false);

    const valid = goalFactoryInput({
      intent: assumptionIntent,
      eligibility: assumptionEligibility,
      assumptions: [{
        assumptionId: 'assumption-branch',
        description: 'Use the repository default branch',
        status: 'UNVERIFIED',
      }],
      assumptionBindings: [{
        fieldId: 'branch',
        assumptionId: 'assumption-branch',
      }],
    });
    assert.equal(GoalFactoryInputSchema.safeParse(valid).success, true);
    assert.equal(buildGoalSpec(valid).assumptions.length, 1);
  });

  it('rejects Intent and eligibility identity mismatches', () => {
    const mismatch = {
      ...goalFactoryInput(),
      eligibility: {
        ...eligibleDecision(),
        intentId: `intent_${'9'.repeat(32)}`,
      },
    };
    assert.equal(GoalFactoryInputSchema.safeParse(mismatch).success, false);
  });
});
