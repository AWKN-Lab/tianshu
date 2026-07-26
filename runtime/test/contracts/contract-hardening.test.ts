import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AuthorizationRecordSchema,
  ClaimSchema,
  EvidenceRecordSchema,
  GoalJudgementSchema,
  GoalSpecSchema,
  authorizationScopeHash,
  canonicalizeJson,
  claimContentHash,
  goalSpecContentHash,
  migrateClaimV2ToV3,
  stableHash,
} from '../../src/contracts/public.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures', 'contracts');
const id = (prefix: string, digit: string): string => `${prefix}_${digit.repeat(32)}`;

const actor = {
  schema: 'awkn-actor-ref/v1' as const,
  actorId: 'user-1',
  actorType: 'human' as const,
  userId: 'user-1',
  projectId: 'tianshu',
};

const sourceRef = {
  schema: 'awkn-source-ref/v1' as const,
  sourceKind: 'current_human_message' as const,
  sourceId: 'message-1',
  observedAt: '2026-07-26T12:00:00.000Z',
};

function validGoal() {
  return {
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
}

describe('Claim v2 to v3 golden migration', () => {
  it('matches normalized output, canonical bytes and stable hash', () => {
    const root = join(fixtureRoot, 'claim', 'v2-confirmed-to-v3-field');
    const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8')) as unknown;
    const normalized = JSON.parse(readFileSync(join(root, 'normalized.json'), 'utf8')) as unknown;
    const expectedCanonical = readFileSync(join(root, 'canonical.json'), 'utf8');
    const expectedHash = readFileSync(join(root, 'sha256.txt'), 'utf8').trim();
    const expectation = JSON.parse(readFileSync(join(root, 'expected-validation.json'), 'utf8')) as {
      valid: boolean;
      migration: string;
    };

    const migrated = migrateClaimV2ToV3(input);
    assert.equal(expectation.valid, true);
    assert.equal(expectation.migration, 'v2-to-v3');
    assert.deepEqual(migrated, normalized);
    assert.equal(canonicalizeJson(migrated), expectedCanonical);
    assert.equal(stableHash(migrated.schema, migrated), expectedHash);
    assert.equal(migrated.epistemicStatus, 'asserted');
    assert.equal(migrated.confirmationLevel, 'field');
  });

  it('rejects a Claim whose content hash does not match canonical content', () => {
    assert.throws(() => ClaimSchema.parse({
      schema: 'awkn-claim/v3',
      claimId: id('clm', '1'),
      content: 'Contract-first',
      contentHash: '0'.repeat(64),
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
    }), /contentHash does not match/);

    assert.match(claimContentHash('Contract-first'), /^[0-9a-f]{64}$/);
  });
});

describe('Hardened Goal invariants', () => {
  it('requires unique scope and identifiers plus at least one required evidence source', () => {
    const goal = validGoal();
    assert.throws(() => GoalSpecSchema.parse({
      ...goal,
      scope: { included: ['same'], excluded: ['same'] },
    }), /both included and excluded/);
    assert.throws(() => GoalSpecSchema.parse({
      ...goal,
      evidenceSources: [{ ...goal.evidenceSources[0], required: false }],
    }), /at least one required evidence source/);
    assert.throws(() => GoalSpecSchema.parse({
      ...goal,
      acceptanceCriteria: [goal.acceptanceCriteria[0], goal.acceptanceCriteria[0]],
    }), /duplicate criterionId/);
  });

  it('does not allow ACHIEVED without acceptance results and evidence', () => {
    assert.throws(() => GoalJudgementSchema.parse({
      schema: 'awkn-goal-judgement/v1',
      goalId: id('goal', '3'),
      runId: id('run', '4'),
      verdict: 'ACHIEVED',
      acceptanceResults: [],
      constraintResults: [],
      gateReceiptIds: [],
      evidenceIds: [],
      deliveryPreconditionResults: [],
      judgeVersion: 'goal-judge/v1',
      judgedAt: '2026-07-26T12:00:00.000Z',
    }), /requires acceptance evaluation results|requires verified evidence/);
  });

  it('uses a content projection independent of Goal ID and creation time', () => {
    const first = GoalSpecSchema.parse(validGoal());
    const second = GoalSpecSchema.parse({
      ...validGoal(),
      goalId: id('goal', '9'),
      createdAt: '2026-07-26T13:00:00.000Z',
    });
    assert.equal(goalSpecContentHash(first), goalSpecContentHash(second));
  });
});

describe('Evidence and authorization hardening', () => {
  it('requires a verifier independent from the model producer', () => {
    const producer = {
      schema: 'awkn-actor-ref/v1' as const,
      actorId: 'assistant-1',
      actorType: 'assistant' as const,
    };
    assert.throws(() => EvidenceRecordSchema.parse({
      schema: 'awkn-evidence/v2',
      evidenceId: id('ev', '5'),
      executionId: id('exec', '6'),
      traceId: id('tr', '7'),
      claimIds: [],
      type: 'model_statement',
      level: 2,
      contentHash: 'a'.repeat(64),
      sourceRef,
      observedAt: '2026-07-26T12:00:00.000Z',
      producer,
      verifiedBy: [producer],
    }), /independent verifier/);
  });

  it('enforces authorization lifecycle and hashes only the stable scope', () => {
    const base = {
      schema: 'awkn-authorization-token/v1' as const,
      authorizationId: id('auth', '8'),
      tokenHash: 'c'.repeat(64),
      actor,
      executionId: id('exec', '6'),
      allowedToolIds: ['github.create_file'],
      allowedOperations: ['create'],
      targetConstraints: { repository: 'AWKN-Lab/tianshu' },
      riskCeiling: 'R3' as const,
      maxUses: 2,
      usedCount: 0,
      status: 'ACTIVE' as const,
      issuedAt: '2026-07-26T12:00:00.000Z',
      expiresAt: '2026-07-26T13:00:00.000Z',
    };

    assert.throws(() => AuthorizationRecordSchema.parse({
      ...base,
      allowedToolIds: ['github.create_file', 'github.create_file'],
    }), /duplicate authorization scope/);
    assert.throws(() => AuthorizationRecordSchema.parse({
      ...base,
      usedCount: 2,
      status: 'ACTIVE',
    }), /must be CONSUMED/);

    const active = AuthorizationRecordSchema.parse(base);
    const consumed = AuthorizationRecordSchema.parse({
      ...base,
      tokenHash: 'd'.repeat(64),
      usedCount: 2,
      status: 'CONSUMED',
      issuedAt: '2026-07-26T12:05:00.000Z',
      expiresAt: '2026-07-26T13:05:00.000Z',
    });
    assert.equal(authorizationScopeHash(active), authorizationScopeHash(consumed));
  });
});
