import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GoalJudgeInputSchema,
  GoalJudgementSchema,
  GoalSpecSchema,
  type EvidenceRecord,
  type GoalJudgeInput,
  type GoalSpec,
  type ObjectRef,
} from '../../src/contracts/public.js';
import { judgeGoal } from '../../src/goal/public.js';

const id = (prefix: string, digit: string): string => `${prefix}_${digit.repeat(32)}`;
const runId = id('run', '1');
const goalId = id('goal', '2');
const evidenceId = id('ev', '3');
const gateReceiptId = id('rcpt', '4');
const executionId = id('exec', '5');
const traceId = id('tr', '6');
const now = '2026-07-27T04:00:00.000Z';

function objectRef(objectType: string, objectId: string): ObjectRef {
  return {
    schema: 'awkn-object-ref/v1',
    objectType,
    objectId,
    schemaId: 'awkn-evaluation-result/v1',
    contentHash: 'a'.repeat(64),
  };
}

function goal(): GoalSpec {
  return GoalSpecSchema.parse({
    schema: 'awkn-goal-spec/v3',
    goalId,
    title: 'Verify the runtime change',
    desiredState: {
      description: 'Required checks and constraints pass',
      successSignals: ['test gate passes'],
    },
    scope: {
      included: ['runtime change'],
      excluded: ['production deployment'],
    },
    acceptanceCriteria: [{
      criterionId: 'criterion-tests',
      description: 'All tests pass',
      required: true,
      evaluator: 'deterministic',
      evidenceSourceIds: ['source-tests'],
    }],
    evidenceSources: [{
      sourceId: 'source-tests',
      sourceType: 'test',
      required: true,
      minimumLevel: 3,
      freshnessClass: 'REAL_TIME',
    }],
    constraints: [{
      constraintId: 'constraint-no-main-write',
      description: 'No unreviewed main write',
      severity: 'HARD',
      evaluator: 'deterministic',
    }],
    assumptions: [],
    budget: {
      maxCycles: 3,
      maxTokens: 10_000,
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
      successPredicate: { delivered: true },
    },
    taskProfile: 'engineering',
    riskLevel: 'R1',
    createdBy: {
      schema: 'awkn-actor-ref/v1',
      actorId: 'intent-goal-router',
      actorType: 'service',
    },
    createdAt: now,
  });
}

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    schema: 'awkn-evidence/v2',
    evidenceId,
    executionId,
    traceId,
    runId,
    claimIds: [],
    type: 'test_result',
    level: 4,
    contentHash: 'b'.repeat(64),
    sourceRef: {
      schema: 'awkn-source-ref/v1',
      sourceKind: 'tool_observation',
      sourceId: 'runtime-ci/test',
      observedAt: now,
    },
    observedAt: now,
    producer: {
      schema: 'awkn-actor-ref/v1',
      actorId: 'runtime-ci',
      actorType: 'service',
    },
    verifiedBy: [{
      schema: 'awkn-actor-ref/v1',
      actorId: 'test-evaluator',
      actorType: 'service',
    }],
    ...overrides,
  };
}

function judgeInput(overrides: Partial<GoalJudgeInput> = {}): GoalJudgeInput {
  return {
    schema: 'awkn-goal-judge-input/v1',
    goal: goal(),
    runId,
    acceptanceEvaluations: [{
      criterionId: 'criterion-tests',
      status: 'PASS',
      resultRef: objectRef('acceptance_evaluation', 'criterion-tests'),
    }],
    constraintEvaluations: [{
      constraintId: 'constraint-no-main-write',
      status: 'PASS',
      resultRef: objectRef('constraint_evaluation', 'constraint-no-main-write'),
    }],
    gateEvaluations: [{
      gateType: 'test',
      status: 'PASS',
      receiptId: gateReceiptId,
    }],
    requiredDeliveryPreconditionIds: ['delivery-ready'],
    deliveryPreconditions: [{
      preconditionId: 'delivery-ready',
      status: 'PASS',
      resultRef: objectRef('delivery_precondition', 'delivery-ready'),
    }],
    evidenceRecords: [evidence()],
    evidenceBindings: [{
      sourceId: 'source-tests',
      evidenceId,
    }],
    judgeVersion: 'goal-judge/v1',
    judgedAt: now,
    ...overrides,
  };
}

describe('deterministic Goal Judge', () => {
  it('returns ACHIEVED only when every required input passes', () => {
    const judgement = judgeGoal(judgeInput());
    assert.equal(GoalJudgementSchema.safeParse(judgement).success, true);
    assert.equal(judgement.verdict, 'ACHIEVED');
    assert.deepEqual(judgement.gateReceiptIds, [gateReceiptId]);
    assert.deepEqual(judgement.evidenceIds, [evidenceId]);
    assert.equal(judgement.acceptanceResults.length, 1);
    assert.equal(judgement.constraintResults.length, 1);
    assert.equal(judgement.deliveryPreconditionResults.length, 1);
  });

  it('returns NOT_ACHIEVED for a required failure', () => {
    const judgement = judgeGoal(judgeInput({
      acceptanceEvaluations: [{
        criterionId: 'criterion-tests',
        status: 'FAIL',
        resultRef: objectRef('acceptance_evaluation', 'criterion-tests-failed'),
      }],
    }));
    assert.equal(judgement.verdict, 'NOT_ACHIEVED');
  });

  it('returns BLOCKED before failure or unknown states', () => {
    const judgement = judgeGoal(judgeInput({
      acceptanceEvaluations: [{
        criterionId: 'criterion-tests',
        status: 'FAIL',
        resultRef: objectRef('acceptance_evaluation', 'criterion-tests-failed'),
      }],
      gateEvaluations: [{
        gateType: 'test',
        status: 'BLOCKED',
        receiptId: gateReceiptId,
      }],
      evidenceBindings: [],
    }));
    assert.equal(judgement.verdict, 'BLOCKED');
  });

  it('returns UNKNOWN when required evaluation or evidence is missing', () => {
    const missingAcceptance = judgeGoal(judgeInput({ acceptanceEvaluations: [] }));
    assert.equal(missingAcceptance.verdict, 'UNKNOWN');

    const missingEvidence = judgeGoal(judgeInput({ evidenceBindings: [] }));
    assert.equal(missingEvidence.verdict, 'UNKNOWN');

    const missingDelivery = judgeGoal(judgeInput({ deliveryPreconditions: [] }));
    assert.equal(missingDelivery.verdict, 'UNKNOWN');
  });

  it('returns NOT_ACHIEVED when evidence level is below the required threshold', () => {
    const judgement = judgeGoal(judgeInput({
      evidenceRecords: [evidence({ level: 2 })],
    }));
    assert.equal(judgement.verdict, 'NOT_ACHIEVED');
  });

  it('rejects model evidence above level one without an independent verifier', () => {
    const invalidModelEvidence = evidence({
      type: 'model_statement',
      level: 3,
      producer: {
        schema: 'awkn-actor-ref/v1',
        actorId: 'model-a',
        actorType: 'assistant',
      },
      verifiedBy: [{
        schema: 'awkn-actor-ref/v1',
        actorId: 'model-a',
        actorType: 'assistant',
      }],
    });
    assert.equal(GoalJudgeInputSchema.safeParse({
      ...judgeInput(),
      evidenceRecords: [invalidModelEvidence],
    }).success, false);
  });

  it('rejects duplicate evaluations and cross-run evidence', () => {
    const duplicate = {
      ...judgeInput(),
      gateEvaluations: [
        { gateType: 'test', status: 'PASS', receiptId: gateReceiptId },
        { gateType: 'test', status: 'PASS', receiptId: id('rcpt', '7') },
      ],
    };
    assert.equal(GoalJudgeInputSchema.safeParse(duplicate).success, false);

    const crossRun = {
      ...judgeInput(),
      evidenceRecords: [evidence({ runId: id('run', '8') })],
    };
    assert.equal(GoalJudgeInputSchema.safeParse(crossRun).success, false);
  });
});
