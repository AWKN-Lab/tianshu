import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ContextManifestSchema,
  ContextPlannerInputSchema,
  contextManifestHash,
  type ContextCandidate,
  type ContextPlannerInput,
  type ContextSection,
} from '../../src/contracts/public.js';
import { contextUtilityScore, planContext } from '../../src/context/public.js';

const id = (prefix: string, digit: string): string => `${prefix}_${digit.repeat(32)}`;
const now = '2026-07-27T05:00:00.000Z';

function candidate(
  itemId: string,
  section: ContextSection,
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return {
    schema: 'awkn-context-candidate/v1',
    itemId,
    itemType: section === 'HIGH_IMPACT_CLAIM' ? 'claim' : 'document',
    section,
    ref: {
      schema: 'awkn-object-ref/v1',
      objectType: 'context_item',
      objectId: itemId,
      schemaId: 'awkn-context-item/v1',
      contentHash: itemId.padEnd(64, 'a').slice(0, 64).replace(/[^0-9a-f]/g, 'a'),
    },
    ...(section === 'HIGH_IMPACT_CLAIM' ? { claimId: id('clm', itemId.slice(-1)) } : {}),
    tokenCount: 10,
    required: false,
    permission: 'ALLOW',
    sensitivityAllowed: true,
    freshnessDecision: 'VALID',
    freshness: {
      schema: 'awkn-freshness-contract/v1',
      class: 'STATIC',
      observedAt: now,
      refreshPolicy: 'none',
      sourceAuthority: 'test',
      conflictStatus: 'none',
    },
    conflictRisk: 'NONE',
    factors: {
      decisionImpact: 0.8,
      taskRelevance: 0.8,
      sourceTrust: 0.8,
      freshness: 1,
      novelty: 0.5,
      userExpectation: 0.5,
      sensitivityRisk: 0,
      tokenCost: 0.1,
      contradictionRisk: 0,
    },
    sourceReceiptIds: [id('rcpt', itemId.slice(-1))],
    sourceVersion: 'v1',
    ...overrides,
  };
}

function plannerInput(
  candidates: ContextCandidate[],
  overrides: Partial<ContextPlannerInput['plan']> = {},
): ContextPlannerInput {
  return ContextPlannerInputSchema.parse({
    schema: 'awkn-context-planner-input/v1',
    plan: {
      schema: 'awkn-context-query-plan/v1',
      contextId: id('ctx', '1'),
      executionId: id('exec', '2'),
      query: 'prepare a verified engineering decision',
      tokenBudget: 200,
      allowStale: false,
      allowedSensitivityClasses: ['internal'],
      policyVersion: 'context-policy/v1',
      plannerVersion: 'context-planner/v1',
      createdAt: now,
      ...overrides,
    },
    candidates,
  });
}

describe('Context Utility Score', () => {
  it('uses the frozen weighted formula', () => {
    const score = contextUtilityScore({
      decisionImpact: 1,
      taskRelevance: 1,
      sourceTrust: 1,
      freshness: 1,
      novelty: 1,
      userExpectation: 1,
      sensitivityRisk: 1,
      tokenCost: 1,
      contradictionRisk: 1,
    });
    assert.equal(score, 0.6);
  });
});

describe('Context hard filters', () => {
  it('excludes permission, sensitivity, freshness and high-conflict candidates with reason codes', () => {
    const manifest = planContext(plannerInput([
      candidate('item1', 'KNOWLEDGE', { permission: 'DENY' }),
      candidate('item2', 'KNOWLEDGE', { permission: 'UNKNOWN' }),
      candidate('item3', 'KNOWLEDGE', { sensitivityAllowed: false }),
      candidate('item4', 'KNOWLEDGE', { freshnessDecision: 'EXPIRED' }),
      candidate('item5', 'KNOWLEDGE', { freshnessDecision: 'UNKNOWN' }),
      candidate('item6', 'KNOWLEDGE', { freshnessDecision: 'STALE' }),
      candidate('item7', 'HIGH_IMPACT_CLAIM', { conflictRisk: 'HIGH' }),
      candidate('item8', 'KNOWLEDGE', {
        factors: {
          decisionImpact: 0,
          taskRelevance: 1,
          sourceTrust: 1,
          freshness: 1,
          novelty: 1,
          userExpectation: 1,
          sensitivityRisk: 0,
          tokenCost: 0,
          contradictionRisk: 0,
        },
      }),
    ]));
    assert.equal(manifest.status, 'READY');
    assert.equal(manifest.included.length, 0);
    const reasons = new Map(manifest.excluded.map((item) => [item.itemId, item.reasonCodes]));
    assert.deepEqual(reasons.get('item1'), ['PERMISSION_DENIED']);
    assert.deepEqual(reasons.get('item2'), ['PERMISSION_UNKNOWN']);
    assert.deepEqual(reasons.get('item3'), ['SENSITIVITY_BLOCKED']);
    assert.deepEqual(reasons.get('item4'), ['FRESHNESS_EXPIRED']);
    assert.deepEqual(reasons.get('item5'), ['FRESHNESS_UNKNOWN']);
    assert.deepEqual(reasons.get('item6'), ['STALE_NOT_ALLOWED']);
    assert.deepEqual(reasons.get('item7'), ['HIGH_IMPACT_CONFLICT']);
    assert.deepEqual(reasons.get('item8'), ['NO_DECISION_IMPACT']);
    assert.deepEqual(manifest.conflicts, [{
      itemId: 'item7',
      claimId: id('clm', '7'),
      risk: 'HIGH',
      resolution: 'ASK_USER',
    }]);
  });

  it('allows stale candidates only when the query plan explicitly permits it', () => {
    const item = candidate('item1', 'KNOWLEDGE', { freshnessDecision: 'STALE' });
    assert.equal(planContext(plannerInput([item])).included.length, 0);
    assert.equal(planContext(plannerInput([item], { allowStale: true })).included.length, 1);
  });
});

describe('Required Context Gate', () => {
  it('blocks the entire manifest when a required item fails a hard filter', () => {
    const manifest = planContext(plannerInput([
      candidate('item1', 'POLICY_SYSTEM', { required: true, permission: 'DENY' }),
      candidate('item2', 'KNOWLEDGE'),
    ]));
    assert.equal(manifest.status, 'BLOCKED');
    assert.deepEqual(manifest.included, []);
    assert.equal(manifest.blockingReasonCodes.includes('REQUIRED_ITEM_UNAVAILABLE'), true);
    assert.equal(manifest.excluded.find((item) => item.itemId === 'item1')?.reasonCodes.includes('PERMISSION_DENIED'), true);
  });

  it('blocks without partial selection when required items exceed usable budget', () => {
    const manifest = planContext(plannerInput([
      candidate('item1', 'CORE_GOAL', { required: true, tokenCount: 100 }),
      candidate('item2', 'POLICY_SYSTEM', { required: true, tokenCount: 100 }),
      candidate('item3', 'KNOWLEDGE', { tokenCount: 1 }),
    ], { tokenBudget: 200 }));
    assert.equal(manifest.safetyReserveTokens, 10);
    assert.equal(manifest.status, 'BLOCKED');
    assert.equal(manifest.selectedTokenCount, 0);
    assert.deepEqual(manifest.included, []);
    assert.deepEqual(manifest.blockingReasonCodes, ['REQUIRED_ITEM_TOO_LARGE']);
  });
});

describe('Token Budget Allocator and Manifest determinism', () => {
  it('reserves five percent, selects required items first and never exceeds the budget', () => {
    const manifest = planContext(plannerInput([
      candidate('item1', 'CORE_GOAL', { required: true, tokenCount: 20 }),
      candidate('item2', 'POLICY_SYSTEM', { required: true, tokenCount: 20 }),
      candidate('item3', 'HIGH_IMPACT_CLAIM', { tokenCount: 50 }),
      candidate('item4', 'KNOWLEDGE', { tokenCount: 80 }),
      candidate('item5', 'TOOL_SKILL', { tokenCount: 40 }),
    ], { tokenBudget: 200 }));
    assert.equal(manifest.status, 'READY');
    assert.equal(manifest.safetyReserveTokens, 10);
    assert.equal(manifest.selectedTokenCount + manifest.safetyReserveTokens <= 200, true);
    assert.equal(manifest.included.some((item) => item.itemId === 'item1' && item.reasonCodes.includes('REQUIRED_ITEM')), true);
    assert.equal(manifest.included.some((item) => item.itemId === 'item2' && item.reasonCodes.includes('REQUIRED_ITEM')), true);
    assert.equal(manifest.excluded.some((item) => item.reasonCodes.includes('TOKEN_BUDGET_EXCEEDED')), true);
    assert.equal(
      manifest.sectionAllocations.reduce((total, item) => total + item.consumedTokens, 0),
      manifest.selectedTokenCount,
    );
  });

  it('sorts equal-utility candidates deterministically by section then itemId', () => {
    const candidates = [
      candidate('item3', 'KNOWLEDGE', { tokenCount: 45 }),
      candidate('item2', 'CORE_GOAL', { tokenCount: 45 }),
      candidate('item1', 'CORE_GOAL', { tokenCount: 45 }),
    ];
    const manifest = planContext(plannerInput(candidates, { tokenBudget: 100 }));
    assert.deepEqual(manifest.included.map((item) => item.itemId), ['item1', 'item2']);
    assert.deepEqual(manifest.excluded.map((item) => item.itemId), ['item3']);
  });

  it('generates the same Manifest Hash for the same normalized input', () => {
    const value = plannerInput([
      candidate('item1', 'CORE_GOAL', { required: true }),
      candidate('item2', 'KNOWLEDGE'),
    ]);
    const first = planContext(value);
    const second = planContext(value);
    assert.equal(ContextManifestSchema.safeParse(first).success, true);
    assert.equal(first.manifestHash, second.manifestHash);
    const { manifestHash, ...projection } = first;
    assert.equal(manifestHash, contextManifestHash(projection));
    assert.deepEqual(first.sourceReceipts, [id('rcpt', '1'), id('rcpt', '2')]);
  });
});
