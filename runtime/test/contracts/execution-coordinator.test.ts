import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  IntentRouterInputSchema,
  type ActorRef,
  type AgentOsFlag,
  type ContextPlannerInput,
  type ExecutionScope,
  type FeatureFlagValue,
} from '../../src/contracts/public.js';
import { parseTrustedJson } from '../../src/input/application/trusted-json-parser.js';
import { buildInputJsonReceipt } from '../../src/input/application/input-receipt.js';
import { routeIntent, buildIntentReceiptPayload } from '../../src/intent/application/intent-router.js';
import { planContext } from '../../src/context/planner/application/context-planner.js';
import { ExecutionCoordinator } from '../../src/composition/execution-coordinator.js';
import type { ExecutionPorts } from '../../src/composition/ports.js';
import { FeatureFlagError } from '../../src/contracts/feature-flag.js';

const now = '2026-07-28T03:00:00.000Z';
const sourceHash = 'a'.repeat(64);

const actor: ActorRef = {
  schema: 'awkn-actor-ref/v1',
  actorId: 'test-actor',
  actorType: 'assistant',
};

const scope: ExecutionScope = {
  schema: 'awkn-execution-scope/v1',
  projectId: 'test-project',
  sessionId: 'test-session',
};

function baseIntentInput() {
  return {
    primaryIntent: 'analyze the supplied information',
    secondaryIntents: [],
    requestedOutcome: 'a grounded answer',
    deliverableTypes: ['chat'],
    taskKind: 'analysis' as const,
    operations: ['ANALYZE' as const],
    toolCountHint: 0,
    dependencyCount: 0,
    iterative: false,
    deterministicAcceptance: false,
    multiAgent: false,
    externalSideEffects: false,
    timeDependency: 'none' as const,
    confidence: 0.9,
    knownFields: [],
    missingFields: [],
  };
}

function baseContextPlannerInput(): Omit<ContextPlannerInput, 'schema'> {
  return {
    plan: {
      schema: 'awkn-context-query-plan/v1',
      contextId: `ctx_${'1'.repeat(32)}`,
      executionId: `exec_${'2'.repeat(32)}`,
      query: 'prepare a verified engineering decision',
      tokenBudget: 200,
      allowStale: false,
      allowedSensitivityClasses: ['internal'],
      policyVersion: 'context-policy/v1',
      plannerVersion: 'context-planner/v1',
      createdAt: now,
    },
    candidates: [],
  };
}

function buildRealPorts(): ExecutionPorts {
  return {
    inputGateway: { parse: (input) => parseTrustedJson(input) },
    intentRouter: { route: (command) => routeIntent(command) },
    claimResolver: { resolve: () => { throw new Error('claim resolver not configured for this test'); } },
    contextPlanner: { plan: (input) => planContext(input) },
  };
}

function buildCoordinator(env?: Record<string, string | undefined>, flagConfig?: Partial<Record<AgentOsFlag, FeatureFlagValue>>): ExecutionCoordinator {
  return new ExecutionCoordinator({
    ports: buildRealPorts(),
    inputReceiptBuilder: { build: (request) => buildInputJsonReceipt(request) },
    intentReceiptPayloadBuilder: { buildPayload: (decision) => buildIntentReceiptPayload(decision) },
    env,
    flagConfig,
    clock: () => now,
  });
}

const validJsonInput = JSON.stringify({ hello: 'world' });
const invalidJsonInput = '{not valid json';

describe('ExecutionCoordinator', () => {
  let coordinator: ExecutionCoordinator;

  beforeEach(() => {
    coordinator = buildCoordinator();
  });

  describe('default flags (all "0") — Engine v2 authoritative path', () => {
    it('creates Execution with RECEIVED state and only Input receipt', () => {
      const handle = coordinator.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      assert.equal(handle.envelope.state, 'RECEIVED');
      assert.ok(handle.inputReceipt, 'inputReceipt must be present');
      assert.equal(handle.inputReceipt.receiptType, 'INPUT');
      assert.equal(handle.inputReceipt.status, 'SUCCESS');
      assert.equal(handle.intentReceipt, undefined, 'intentReceipt must be absent');
      assert.equal(handle.intentDecision, undefined, 'intentDecision must be absent');
      assert.equal(handle.contextManifest, undefined, 'contextManifest must be absent');
    });

    it('does not call Intent/Context/Claim Ports when Input flag is "0"', () => {
      let intentCalled = false;
      let contextCalled = false;
      const portsWithTracking: ExecutionPorts = {
        inputGateway: { parse: (input) => parseTrustedJson(input) },
        intentRouter: { route: (cmd) => { intentCalled = true; return routeIntent(cmd); } },
        claimResolver: { resolve: () => { throw new Error('should not be called'); } },
        contextPlanner: { plan: (input) => { contextCalled = true; return planContext(input); } },
      };
      const coordinatorWithTracking = new ExecutionCoordinator({
        ports: portsWithTracking,
        inputReceiptBuilder: { build: (req) => buildInputJsonReceipt(req) },
        intentReceiptPayloadBuilder: { buildPayload: (dec) => buildIntentReceiptPayload(dec) },
        clock: () => now,
      });

      coordinatorWithTracking.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      assert.equal(intentCalled, false, 'Intent Port must not be called when Input flag is "0"');
      assert.equal(contextCalled, false, 'Context Port must not be called when Input flag is "0"');
    });
  });

  describe('shadow flags — Engine v2 authoritative, R2 bypass computes', () => {
    it('creates Execution with CONTEXT_READY state when manifest is READY', () => {
      const shadowEnv = {
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      };
      const shadowCoordinator = buildCoordinator(shadowEnv);

      const handle = shadowCoordinator.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      assert.equal(handle.envelope.state, 'CONTEXT_READY');
      assert.ok(handle.inputReceipt);
      assert.ok(handle.intentReceipt, 'intentReceipt must be present under shadow');
      assert.ok(handle.intentDecision, 'intentDecision must be present under shadow');
      assert.ok(handle.contextManifest, 'contextManifest must be present under shadow');
      assert.equal(handle.envelope.intentRef?.objectId, handle.intentDecision!.intentId);
      assert.equal(handle.envelope.contextRef?.objectId, handle.contextManifest!.contextId);
    });

    it('sets envelope state to BLOCKED when context manifest status is BLOCKED', () => {
      const shadowEnv = {
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      };
      const shadowCoordinator = buildCoordinator(shadowEnv);

      // 构造一个 required 但 freshness=EXPIRED 的 candidate，
      // 触发 hardFilterReasons 返回 FRESHNESS_EXPIRED → requiredUnavailable → manifest BLOCKED
      const blockedInput = baseContextPlannerInput();
      const expiredCandidate = {
        schema: 'awkn-context-candidate/v1' as const,
        itemId: 'expired-required-item',
        itemType: 'goal' as const,
        section: 'CORE_GOAL' as const,
        ref: {
          schema: 'awkn-object-ref/v1' as const,
          objectType: 'context_item',
          objectId: 'expired-required-item',
          schemaId: 'awkn-context-item/v1',
          contentHash: 'f'.repeat(64),
        },
        tokenCount: 10,
        required: true,
        permission: 'ALLOW' as const,
        sensitivityAllowed: true,
        freshnessDecision: 'EXPIRED' as const,
        freshness: {
          schema: 'awkn-freshness-contract/v1' as const,
          class: 'STATIC',
          observedAt: now,
          refreshPolicy: 'none',
          sourceAuthority: 'test',
          conflictStatus: 'none',
        },
        conflictRisk: 'NONE' as const,
        factors: {
          decisionImpact: 0.8,
          taskRelevance: 0.8,
          sourceTrust: 0.8,
          freshness: 0,
          novelty: 0.5,
          userExpectation: 0.5,
          sensitivityRisk: 0,
          tokenCost: 0.1,
          contradictionRisk: 0,
        },
        sourceReceiptIds: [`rcpt_${'1'.repeat(32)}`],
        sourceVersion: 'v1',
      };
      blockedInput.candidates = [expiredCandidate];

      const handle = shadowCoordinator.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: blockedInput,
      });

      assert.equal(handle.envelope.state, 'BLOCKED');
      assert.ok(handle.contextManifest);
      assert.equal(handle.contextManifest!.status, 'BLOCKED');
    });
  });

  describe('enforce flags — Agent OS 3.0 authoritative path', () => {
    it('creates Execution with CONTEXT_READY state using enforce flags', () => {
      const enforceEnv = {
        AWKN_INPUT_GATEWAY_V1: 'enforce',
        AWKN_INTENT_ROUTER_V1: 'enforce',
        AWKN_CONTEXT_PLANNER_V1: 'enforce',
      };
      const enforceCoordinator = buildCoordinator(enforceEnv);

      const handle = enforceCoordinator.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      assert.equal(handle.envelope.state, 'CONTEXT_READY');
      assert.equal(handle.flagSnapshot.flags.AWKN_INPUT_GATEWAY_V1, 'enforce');
      assert.equal(handle.flagSnapshot.flags.AWKN_INTENT_ROUTER_V1, 'enforce');
      assert.equal(handle.flagSnapshot.flags.AWKN_CONTEXT_PLANNER_V1, 'enforce');
    });
  });

  describe('Input rejection — fail-closed on invalid JSON', () => {
    it('creates BLOCKED Execution when input parsing fails', () => {
      const handle = coordinator.createExecution({
        actor,
        scope,
        rawInput: invalidJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      assert.equal(handle.envelope.state, 'BLOCKED');
      assert.ok(handle.inputReceipt);
      assert.equal(handle.inputReceipt.status, 'FAILURE');
      assert.equal(handle.inputReceipt.payload.status, 'REJECTED');
      assert.equal(handle.intentReceipt, undefined);
      assert.equal(handle.contextManifest, undefined);
    });
  });

  describe('dependency validation — fail-closed on illegal flag combination', () => {
    it('rejects Intent=shadow when Input="0"', () => {
      const illegalEnv = {
        AWKN_INTENT_ROUTER_V1: 'shadow',
      };
      const illegalCoordinator = buildCoordinator(illegalEnv);

      assert.throws(
        () => illegalCoordinator.createExecution({
          actor,
          scope,
          rawInput: validJsonInput,
          intentRouterInput: baseIntentInput(),
          contextPlannerInput: baseContextPlannerInput(),
        }),
        (err: FeatureFlagError) => err.code === 'AOS_FLAG_DEPENDENCY_INVALID',
      );
    });

    it('rejects Context=shadow when Intent="0"', () => {
      const illegalEnv = {
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      };
      const illegalCoordinator = buildCoordinator(illegalEnv);

      assert.throws(
        () => illegalCoordinator.createExecution({
          actor,
          scope,
          rawInput: validJsonInput,
          intentRouterInput: baseIntentInput(),
          contextPlannerInput: baseContextPlannerInput(),
        }),
        (err: FeatureFlagError) => err.code === 'AOS_FLAG_DEPENDENCY_INVALID',
      );
    });
  });

  describe('Port fail-closed error propagation', () => {
    it('propagates Intent Port errors directly', () => {
      const shadowEnv = {
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      };
      const intentErrorMessage = 'intent router simulated failure';
      const portsWithFailingIntent: ExecutionPorts = {
        inputGateway: { parse: (input) => parseTrustedJson(input) },
        intentRouter: {
          route: () => { throw new Error(intentErrorMessage); },
        },
        claimResolver: { resolve: () => { throw new Error('should not be called'); } },
        contextPlanner: { plan: (input) => planContext(input) },
      };
      const failingCoordinator = new ExecutionCoordinator({
        ports: portsWithFailingIntent,
        inputReceiptBuilder: { build: (req) => buildInputJsonReceipt(req) },
        intentReceiptPayloadBuilder: { buildPayload: (dec) => buildIntentReceiptPayload(dec) },
        env: shadowEnv,
        clock: () => now,
      });

      assert.throws(
        () => failingCoordinator.createExecution({
          actor,
          scope,
          rawInput: validJsonInput,
          intentRouterInput: baseIntentInput(),
          contextPlannerInput: baseContextPlannerInput(),
        }),
        (err: Error) => err.message === intentErrorMessage,
      );
    });

    it('propagates Context Port errors directly', () => {
      const shadowEnv = {
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      };
      const contextErrorMessage = 'context planner simulated failure';
      const portsWithFailingContext: ExecutionPorts = {
        inputGateway: { parse: (input) => parseTrustedJson(input) },
        intentRouter: { route: (cmd) => routeIntent(cmd) },
        claimResolver: { resolve: () => { throw new Error('should not be called'); } },
        contextPlanner: {
          plan: () => { throw new Error(contextErrorMessage); },
        },
      };
      const failingCoordinator = new ExecutionCoordinator({
        ports: portsWithFailingContext,
        inputReceiptBuilder: { build: (req) => buildInputJsonReceipt(req) },
        intentReceiptPayloadBuilder: { buildPayload: (dec) => buildIntentReceiptPayload(dec) },
        env: shadowEnv,
        clock: () => now,
      });

      assert.throws(
        () => failingCoordinator.createExecution({
          actor,
          scope,
          rawInput: validJsonInput,
          intentRouterInput: baseIntentInput(),
          contextPlannerInput: baseContextPlannerInput(),
        }),
        (err: Error) => err.message === contextErrorMessage,
      );
    });
  });

  describe('Execution isolation — concurrent Executions do not share state', () => {
    it('creates independent snapshots for each Execution', () => {
      const shadowEnv = {
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      };
      const shadowCoordinator = buildCoordinator(shadowEnv);

      const handle1 = shadowCoordinator.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      const handle2 = shadowCoordinator.createExecution({
        actor,
        scope,
        rawInput: JSON.stringify({ another: 'input' }),
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      assert.notEqual(handle1.flagSnapshot.snapshotId, handle2.flagSnapshot.snapshotId);
      assert.equal(handle1.flagSnapshot.sourceHash, handle2.flagSnapshot.sourceHash);
      assert.notEqual(handle1.envelope.executionId, handle2.envelope.executionId);
    });
  });

  describe('Execution-level override — highest precedence', () => {
    it('Execution override overrides env values', () => {
      const coordinatorWithEnv = buildCoordinator({
        AWKN_INPUT_GATEWAY_V1: '0',
        AWKN_INTENT_ROUTER_V1: '0',
        AWKN_CONTEXT_PLANNER_V1: '0',
      });

      const handle = coordinatorWithEnv.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
        flagOverrides: {
          AWKN_INPUT_GATEWAY_V1: 'shadow',
          AWKN_INTENT_ROUTER_V1: 'shadow',
          AWKN_CONTEXT_PLANNER_V1: 'shadow',
        },
      });

      assert.equal(handle.envelope.state, 'CONTEXT_READY');
      assert.equal(handle.flagSnapshot.flags.AWKN_INPUT_GATEWAY_V1, 'shadow');
      assert.equal(handle.flagSnapshot.sourceVersions.AWKN_INPUT_GATEWAY_V1, 'execution-override');
    });

    it('Execution override to "0" cancels shadow env', () => {
      const coordinatorWithShadowEnv = buildCoordinator({
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      });

      const handle = coordinatorWithShadowEnv.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
        flagOverrides: {
          AWKN_INPUT_GATEWAY_V1: '0',
          AWKN_INTENT_ROUTER_V1: '0',
          AWKN_CONTEXT_PLANNER_V1: '0',
        },
      });

      assert.equal(handle.envelope.state, 'RECEIVED');
      assert.equal(handle.flagSnapshot.flags.AWKN_INPUT_GATEWAY_V1, '0');
      assert.equal(handle.flagSnapshot.sourceVersions.AWKN_INPUT_GATEWAY_V1, 'execution-override');
    });
  });

  describe('Snapshot immutability — frozen at Execution creation', () => {
    it('flagSnapshot is Object.freeze-d (shallowly immutable)', () => {
      const shadowEnv = {
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      };
      const shadowCoordinator = buildCoordinator(shadowEnv);

      const handle = shadowCoordinator.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      assert.throws(() => {
        (handle.flagSnapshot.flags as Record<AgentOsFlag, FeatureFlagValue>).AWKN_INPUT_GATEWAY_V1 = 'enforce';
      });
    });

    it('produces stable sourceHash for identical configuration', () => {
      const shadowEnv = {
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      };
      const c1 = buildCoordinator(shadowEnv);
      const c2 = buildCoordinator(shadowEnv);

      const h1 = c1.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });
      const h2 = c2.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      assert.equal(h1.flagSnapshot.sourceHash, h2.flagSnapshot.sourceHash);
    });
  });

  describe('Envelope integrity', () => {
    it('featureFlagsRef points to the frozen snapshot', () => {
      const shadowEnv = {
        AWKN_INPUT_GATEWAY_V1: 'shadow',
        AWKN_INTENT_ROUTER_V1: 'shadow',
        AWKN_CONTEXT_PLANNER_V1: 'shadow',
      };
      const shadowCoordinator = buildCoordinator(shadowEnv);

      const handle = shadowCoordinator.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      assert.equal(handle.envelope.featureFlagsRef.objectId, handle.flagSnapshot.snapshotId);
      assert.equal(handle.envelope.featureFlagsRef.contentHash, handle.flagSnapshot.sourceHash);
    });

    it('inputRef points to the parsed document sourceHash', () => {
      const handle = coordinator.createExecution({
        actor,
        scope,
        rawInput: validJsonInput,
        intentRouterInput: baseIntentInput(),
        contextPlannerInput: baseContextPlannerInput(),
      });

      assert.equal(handle.envelope.inputRef.objectType, 'input-json');
      assert.ok(handle.envelope.inputRef.contentHash);
    });
  });
});
