import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  IntentDecisionSchema,
  IntentReceiptPayloadSchema,
  IntentRouterInputSchema,
  receiptPayloadHash,
  type IntentRouterInput,
  type MissingField,
} from '../../src/contracts/public.js';
import {
  buildIntentReceiptPayload,
  clarificationValue,
  evaluateClarification,
  routeIntent,
} from '../../src/intent/public.js';

const inputId = `in_${'1'.repeat(32)}`;
const intentId = `intent_${'2'.repeat(32)}`;
const sourceHash = 'a'.repeat(64);
const createdAt = '2026-07-27T03:00:00.000Z';

function baseInput(overrides: Partial<IntentRouterInput> = {}): IntentRouterInput {
  return IntentRouterInputSchema.parse({
    schema: 'awkn-intent-router-input/v1',
    inputId,
    sourceHash,
    primaryIntent: 'analyze the supplied information',
    secondaryIntents: [],
    requestedOutcome: 'a grounded answer',
    deliverableTypes: ['chat'],
    taskKind: 'analysis',
    operations: ['ANALYZE'],
    toolCountHint: 0,
    dependencyCount: 0,
    iterative: false,
    deterministicAcceptance: false,
    multiAgent: false,
    externalSideEffects: false,
    timeDependency: 'none',
    confidence: 0.9,
    knownFields: [],
    missingFields: [],
    createdAt,
    ...overrides,
  });
}

function route(input: IntentRouterInput) {
  return routeIntent({ intentId, input, routedAt: createdAt });
}

function missingField(overrides: Partial<MissingField> = {}): MissingField {
  return {
    fieldId: 'target',
    description: 'target resource is not specified',
    answerImpact: 0.1,
    uncertaintyReduction: 0.1,
    safetyImpact: 0.1,
    irreversibility: 0.1,
    userEffort: 1,
    ...overrides,
  };
}

describe('intent execution-level routing', () => {
  it('routes static analysis with no tools to L0', () => {
    const decision = route(baseInput());
    assert.equal(decision.executionLevel, 'L0');
    assert.equal(decision.taskProfile, 'analysis');
    assert.equal(decision.goalRequired, false);
    assert.equal(decision.persistentRunRequired, false);
  });

  it('routes a bounded write action to L1', () => {
    const decision = route(baseInput({
      primaryIntent: 'create one document',
      requestedOutcome: 'a document',
      taskKind: 'document_creation',
      operations: ['WRITE'],
      toolCountHint: 1,
      externalSideEffects: true,
    }));
    assert.equal(decision.executionLevel, 'L1');
    assert.equal(decision.taskProfile, 'document_creation');
    assert.equal(decision.goalRequired, false);
  });

  it('routes iterative verification work to L2', () => {
    const decision = route(baseInput({
      primaryIntent: 'repair code until checks pass',
      requestedOutcome: 'all checks pass',
      taskKind: 'engineering',
      operations: ['READ', 'WRITE'],
      toolCountHint: 2,
      iterative: true,
      deterministicAcceptance: true,
    }));
    assert.equal(decision.executionLevel, 'L2');
    assert.equal(decision.taskProfile, 'engineering');
    assert.equal(decision.goalRequired, true);
    assert.equal(decision.persistentRunRequired, true);
    assert.equal(decision.reasonCodes.includes('DETERMINISTIC_ACCEPTANCE_AVAILABLE'), true);
  });

  it('routes scheduled monitoring to L3', () => {
    const decision = route(baseInput({
      primaryIntent: 'check the condition every day',
      requestedOutcome: 'notify on change',
      taskKind: 'automation',
      operations: ['MONITOR'],
      toolCountHint: 1,
      timeDependency: 'condition_watch',
    }));
    assert.equal(decision.executionLevel, 'L3');
    assert.equal(decision.taskProfile, 'scheduled_check');
    assert.equal(decision.goalRequired, true);
  });

  it('routes multi-agent dependency work to L4', () => {
    const decision = route(baseInput({
      primaryIntent: 'coordinate internal agents and tools',
      requestedOutcome: 'a verified workflow result',
      taskKind: 'engineering',
      operations: ['ORCHESTRATE'],
      toolCountHint: 4,
      dependencyCount: 3,
      multiAgent: true,
      deterministicAcceptance: true,
    }));
    assert.equal(decision.executionLevel, 'L4');
    assert.equal(decision.taskProfile, 'multi_agent_orchestration');
    assert.equal(decision.persistentRunRequired, true);
  });
});

describe('clarification value gate', () => {
  it('uses the documented weighted formula', () => {
    const field = missingField({
      answerImpact: 0.5,
      uncertaintyReduction: 0.5,
      safetyImpact: 0.4,
      irreversibility: 0.2,
      userEffort: 0.5,
    });
    assert.equal(clarificationValue(field), 0.45);
  });

  it('asks the user at or above 0.70', () => {
    const result = evaluateClarification([missingField({
      answerImpact: 1,
      uncertaintyReduction: 1,
      safetyImpact: 1,
      irreversibility: 1,
      userEffort: 0,
    })]);
    assert.equal(result.value, 1);
    assert.equal(result.decision, 'ASK_USER');
  });

  it('continues with explicit assumptions from 0.40 through 0.69', () => {
    const input = baseInput({
      missingFields: [missingField({
        answerImpact: 0.5,
        uncertaintyReduction: 0.5,
        safetyImpact: 0.4,
        irreversibility: 0.2,
        userEffort: 0.5,
      })],
    });
    const decision = route(input);
    assert.equal(decision.clarificationValue, 0.45);
    assert.equal(decision.clarificationDecision, 'CONTINUE_WITH_EXPLICIT_ASSUMPTION');
    assert.equal(decision.assumptions.length, 1);
  });

  it('continues below 0.40 without manufacturing assumptions', () => {
    const decision = route(baseInput({ missingFields: [missingField()] }));
    assert.equal(decision.clarificationValue, 0.09);
    assert.equal(decision.clarificationDecision, 'CONTINUE');
    assert.equal(decision.assumptions.length, 0);
  });

  it('forces ASK_USER for mandatory irreversible fields regardless of score', () => {
    const decision = route(baseInput({
      missingFields: [missingField({ mandatoryReason: 'AUTHORIZATION_SCOPE_REQUIRED' })],
    }));
    assert.equal(decision.clarificationDecision, 'ASK_USER');
    assert.equal(decision.reasonCodes.includes('MANDATORY_FIELD_MISSING'), true);
  });
});

describe('intent contract boundaries', () => {
  it('rejects non-Tianshu task profiles', () => {
    const invalid = {
      ...baseInput(),
      taskKind: 'investment_runtime',
    };
    assert.equal(IntentRouterInputSchema.safeParse(invalid).success, false);
  });

  it('rejects duplicate operations and known/missing overlap', () => {
    const duplicate = {
      ...baseInput(),
      operations: ['READ', 'READ'],
    };
    assert.equal(IntentRouterInputSchema.safeParse(duplicate).success, false);

    const overlap = {
      ...baseInput(),
      knownFields: ['target'],
      missingFields: [missingField()],
    };
    assert.equal(IntentRouterInputSchema.safeParse(overlap).success, false);
  });

  it('builds a valid and stable-hashable intent receipt payload', () => {
    const decision = route(baseInput({
      iterative: true,
      deterministicAcceptance: true,
      taskKind: 'engineering',
      operations: ['READ', 'WRITE'],
      toolCountHint: 2,
    }));
    assert.equal(IntentDecisionSchema.safeParse(decision).success, true);

    const payload = buildIntentReceiptPayload(decision);
    assert.equal(IntentReceiptPayloadSchema.safeParse(payload).success, true);
    const first = receiptPayloadHash(payload.schema, payload);
    const second = receiptPayloadHash(payload.schema, payload);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
  });
});
