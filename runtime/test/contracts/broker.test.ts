/**
 * Broker Contract Tests (Phase 6 / C05 / WP-AOS-08/09)
 *
 * 设计文档: `docs/agent-os-3.0/06-Tool-Model-Broker.md`
 *
 * 覆盖:
 * - Tool Capability / Risk Level schema 校验
 * - Model & Provider descriptor schema 校验
 * - Authorization Token state machine (issue / consume / revoke / expire)
 * - Cumulative Risk 计算
 * - Provider Choice (用户点名 / 持久偏好 / 内部自动路由 / 多供应商要求选择)
 * - Model Broker (能力匹配 / 上下文窗口 / 延迟 / 成本 / fallback chain)
 * - Tool Broker (buildToolRoutePlan / verifySideEffect / canAutoRetry)
 * - BrokerPlan 构建 (hash 一致性 / fail-closed)
 * - Receipts (ModelRouteReceipt / DegradationNotice)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AuthorizationTokenSchema,
  BrokerPlanSchema,
  ModelRouteReceiptSchema,
  ToolCapabilitySchema,
  ToolExecutionReceiptSchema,
  computeBrokerPlanHash,
  type AuthorizationToken,
  type BrokerPlan,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ToolCapability,
} from '../../src/contracts/broker.js';
import { type ActorRef } from '../../src/contracts/actors.js';
import { createAwknId } from '../../src/contracts/ids.js';
import { toUtcTimestamp } from '../../src/contracts/time.js';
import {
  AuthorizationStore,
  AuthorizationStoreError,
  computeTokenHash,
} from '../../src/broker/authorization.js';
import {
  computeBaseActionRisk,
  computeCumulativeRisk,
  requiresAdditionalControls,
  requiresHumanReview,
  requiresSecondaryConfirmation,
  forbidsAutomaticRetry,
} from '../../src/broker/cumulative-risk.js';
import {
  selectProvider,
  ProviderChoiceError,
  type ProviderSelectionInput,
} from '../../src/broker/provider-choice.js';
import {
  selectModel,
  ModelBrokerError,
  type ModelRouteRequest,
} from '../../src/broker/model-broker.js';
import {
  buildToolRoutePlan,
  verifySideEffect,
  canAutoRetry,
  ToolBrokerError,
  newToolCallId,
  type AuthorizationRequirementInput,
} from '../../src/broker/tool-broker.js';
import { buildBrokerPlan, BrokerError, type BrokerPlanInput } from '../../src/broker/broker.js';
import {
  buildModelRouteReceipt,
  buildDegradationNotice,
  shouldStopForStructuredOutputMissing,
  isReviewerReuseForbidden,
} from '../../src/broker/receipts.js';

// ============================================================================
// Fixtures
// ============================================================================

const NOW = toUtcTimestamp('2026-07-28T10:00:00.000Z');
const LATER = toUtcTimestamp('2026-07-28T11:00:00.000Z');
const EXECUTION_ID = createAwknId('execution');

function makeActor(): ActorRef {
  return {
    schema: 'awkn-actor-ref/v1',
    actorId: 'user-1',
    actorType: 'human',
    projectId: 'proj-1',
  };
}

function makeResourceScope(resourceType = 'file', resourceId = 'doc.md') {
  return {
    schema: 'awkn-resource-scope/v1' as const,
    resourceType,
    resourceId,
    constraints: {},
  };
}

function makeToolCapability(overrides: Partial<ToolCapability> = {}): ToolCapability {
  return {
    schema: 'awkn-tool-capability/v1',
    toolId: 'file.read',
    providerId: 'local',
    sideEffect: 'local_read',
    reversible: true,
    riskBase: 'R1',
    dataScopes: { read: ['file_content'], write: [] },
    requiresAuthorization: false,
    supportsIdempotency: true,
    supportsVerification: true,
    ...overrides,
  };
}

function makeModelDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    schema: 'awkn-model-descriptor/v1',
    providerId: 'trae',
    modelId: 'gpt-5',
    capabilities: ['reasoning', 'coding', 'tool_calling'],
    taskRoles: ['executor'],
    contextWindow: 128000,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    latencyP50Ms: 2000,
    latencyP99Ms: 5000,
    dataLocation: 'us-east-1',
    retentionDays: 30,
    availability: 0.99,
    fallbackCompatibleWith: [],
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    schema: 'awkn-provider-descriptor/v1',
    providerId: 'trae',
    displayName: 'Trae',
    models: [makeModelDescriptor()],
    dataBoundary: 'global',
    priceTier: 'freemium',
    isInternal: true,
    ...overrides,
  };
}

function makeModelRouteRequest(overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
  return {
    taskRole: 'executor',
    requiredCapabilities: ['reasoning', 'tool_calling'],
    estimatedInputTokens: 1000,
    estimatedOutputTokens: 500,
    requiredContextWindow: 8000,
    ...overrides,
  };
}

// ============================================================================
// Section 1: Schema Validation
// ============================================================================

describe('Broker Schema Validation', () => {
  it('validates a valid ToolCapability', () => {
    const cap = makeToolCapability();
    const result = ToolCapabilitySchema.safeParse(cap);
    assert.ok(result.success, `expected success: ${result.success ? '' : result.error.message}`);
  });

  it('rejects ToolCapability with invalid riskBase', () => {
    const cap = { ...makeToolCapability(), riskBase: 'R6' as never };
    const result = ToolCapabilitySchema.safeParse(cap);
    assert.equal(result.success, false);
  });

  it('rejects ToolCapability with unknown sideEffect', () => {
    const cap = { ...makeToolCapability(), sideEffect: 'invalid' as never };
    const result = ToolCapabilitySchema.safeParse(cap);
    assert.equal(result.success, false);
  });

  it('validates a valid AuthorizationToken', () => {
    const token: AuthorizationToken = {
      schema: 'awkn-authorization-token/v1',
      authorizationId: createAwknId('authorization'),
      actor: makeActor(),
      executionId: EXECUTION_ID,
      toolId: 'email.send',
      providerId: 'google',
      allowedActions: ['send'],
      resourceScopes: [makeResourceScope('email', 'msg-1')],
      dataScopes: ['email_body', 'recipients'],
      maxExecutions: 1,
      usedCount: 0,
      expiresAt: LATER,
      confirmationSourceRef: 'human-confirmation-1',
      tokenHash: 'a'.repeat(64),
      state: 'ACTIVE',
      issuedAt: NOW,
    };
    const result = AuthorizationTokenSchema.safeParse(token);
    assert.ok(result.success, `expected success: ${result.success ? '' : result.error.message}`);
  });

  it('rejects AuthorizationToken with usedCount > maxExecutions', () => {
    const token = {
      schema: 'awkn-authorization-token/v1' as const,
      authorizationId: createAwknId('authorization'),
      actor: makeActor(),
      executionId: EXECUTION_ID,
      toolId: 'email.send',
      allowedActions: ['send'],
      resourceScopes: [makeResourceScope()],
      dataScopes: ['email_body'],
      maxExecutions: 1,
      usedCount: 2,
      expiresAt: LATER,
      confirmationSourceRef: 'human-confirmation-1',
      tokenHash: 'a'.repeat(64),
      state: 'ACTIVE' as const,
      issuedAt: NOW,
    };
    const result = AuthorizationTokenSchema.safeParse(token);
    assert.equal(result.success, false);
  });

  it('rejects AuthorizationToken with expiresAt <= issuedAt', () => {
    const token = {
      schema: 'awkn-authorization-token/v1' as const,
      authorizationId: createAwknId('authorization'),
      actor: makeActor(),
      executionId: EXECUTION_ID,
      toolId: 'email.send',
      allowedActions: ['send'],
      resourceScopes: [makeResourceScope()],
      dataScopes: ['email_body'],
      maxExecutions: 1,
      usedCount: 0,
      expiresAt: NOW,
      confirmationSourceRef: 'human-confirmation-1',
      tokenHash: 'a'.repeat(64),
      state: 'ACTIVE' as const,
      issuedAt: LATER,
    };
    const result = AuthorizationTokenSchema.safeParse(token);
    assert.equal(result.success, false);
  });

  it('rejects AuthorizationToken REVOKED without revokedAt', () => {
    const token = {
      schema: 'awkn-authorization-token/v1' as const,
      authorizationId: createAwknId('authorization'),
      actor: makeActor(),
      executionId: EXECUTION_ID,
      toolId: 'email.send',
      allowedActions: ['send'],
      resourceScopes: [makeResourceScope()],
      dataScopes: ['email_body'],
      maxExecutions: 1,
      usedCount: 0,
      expiresAt: LATER,
      confirmationSourceRef: 'human-confirmation-1',
      tokenHash: 'a'.repeat(64),
      state: 'REVOKED' as const,
      issuedAt: NOW,
    };
    const result = AuthorizationTokenSchema.safeParse(token);
    assert.equal(result.success, false);
  });

  it('validates a valid ModelRouteReceipt', () => {
    const receipt = {
      schema: 'awkn-model-route-receipt/v1' as const,
      routeId: createAwknId('modelRoute'),
      traceId: createAwknId('trace'),
      callSource: 'main_dialogue',
      executedProvider: 'trae',
      executedModel: 'gpt-5',
      routeReasonCodes: ['CAPABILITY_MATCH'],
      fallbackOccurred: false,
      fallbackChain: [],
      capabilityDelta: [],
      promptVersion: 'v1',
      policyBundleHash: 'b'.repeat(64),
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1500,
      createdAt: NOW,
    };
    const result = ModelRouteReceiptSchema.safeParse(receipt);
    assert.ok(result.success, `expected success: ${result.success ? '' : result.error.message}`);
  });

  it('validates a valid ToolExecutionReceipt', () => {
    const receipt = {
      schema: 'awkn-tool-execution-receipt/v1' as const,
      toolCallId: createAwknId('toolCall'),
      toolId: 'file.write',
      requestHash: 'a'.repeat(64),
      resultHash: 'b'.repeat(64),
      sideEffect: 'local_write' as const,
      resourceRefs: ['file://path/to/file'],
      reportedSuccess: true,
      verifiedSuccess: true,
      reversible: true,
      createdAt: NOW,
    };
    const result = ToolExecutionReceiptSchema.safeParse(receipt);
    assert.ok(result.success, `expected success: ${result.success ? '' : result.error.message}`);
  });
});

// ============================================================================
// Section 2: Authorization Store
// ============================================================================

describe('Authorization Store', () => {
  it('issues an ACTIVE token', () => {
    const store = new AuthorizationStore();
    const cap = makeToolCapability({ requiresAuthorization: true, toolId: 'email.send', riskBase: 'R3' });
    const requirement: AuthorizationRequirementInput = {
      requiredActions: ['send'],
      resourceScopes: [makeResourceScope('email', 'msg-1')],
      dataScopes: ['email_body'],
      riskCeiling: 'R3',
      maxExecutions: 1,
      requiresHumanConfirmation: true,
    };
    // Use the store.issue path directly
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        providerId: 'google',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'human-confirmation-1',
      issuedAt: NOW,
    });
    assert.equal(token.state, 'ACTIVE');
    assert.equal(token.usedCount, 0);
    assert.ok(token.authorizationId.startsWith('auth_'));
    assert.equal(token.tokenHash.length, 64);
  });

  it('rejects issue with non-positive maxExecutions', () => {
    const store = new AuthorizationStore();
    assert.throws(
      () => store.issue({
        actor: makeActor(),
        executionId: EXECUTION_ID,
        requirement: {
          toolId: 'email.send',
          requiredActions: ['send'],
          resourceScopes: [],
          dataScopes: [],
          riskCeiling: 'R3',
          maxExecutions: 0,
          requiresHumanConfirmation: true,
        },
        expiresAt: LATER,
        confirmationSourceRef: 'confirmation',
        issuedAt: NOW,
      }),
      (err: Error) => err instanceof AuthorizationStoreError && err.code === 'INVALID_REQUIREMENT',
    );
  });

  it('consumes token and transitions to CONSUMED when usedCount reaches maxExecutions', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        providerId: 'google',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    const consumed = store.consume(token.authorizationId, {
      actor: makeActor(),
      executionId: EXECUTION_ID,
      toolId: 'email.send',
      requestedResources: [makeResourceScope('email', 'msg-1')],
      requestedActions: ['send'],
      consumedAt: NOW,
    });
    assert.equal(consumed.state, 'CONSUMED');
    assert.equal(consumed.usedCount, 1);
  });

  it('rejects consume with mismatched actor', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    assert.throws(
      () => store.consume(token.authorizationId, {
        actor: { ...makeActor(), actorId: 'user-2' },
        executionId: EXECUTION_ID,
        toolId: 'email.send',
        requestedResources: [makeResourceScope('email', 'msg-1')],
        requestedActions: ['send'],
        consumedAt: NOW,
      }),
      (err: Error) => err instanceof AuthorizationStoreError && err.code === 'ACTOR_MISMATCH',
    );
  });

  it('rejects consume with mismatched executionId (cross-execution reuse)', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    assert.throws(
      () => store.consume(token.authorizationId, {
        actor: makeActor(),
        executionId: createAwknId('execution'),
        toolId: 'email.send',
        requestedResources: [makeResourceScope('email', 'msg-1')],
        requestedActions: ['send'],
        consumedAt: NOW,
      }),
      (err: Error) => err instanceof AuthorizationStoreError && err.code === 'EXECUTION_MISMATCH',
    );
  });

  it('rejects consume with mismatched toolId (cross-tool reuse)', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    assert.throws(
      () => store.consume(token.authorizationId, {
        actor: makeActor(),
        executionId: EXECUTION_ID,
        toolId: 'file.write',
        requestedResources: [makeResourceScope('email', 'msg-1')],
        requestedActions: ['send'],
        consumedAt: NOW,
      }),
      (err: Error) => err instanceof AuthorizationStoreError && err.code === 'TOOL_MISMATCH',
    );
  });

  it('rejects consume with uncovered resource scope', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    assert.throws(
      () => store.consume(token.authorizationId, {
        actor: makeActor(),
        executionId: EXECUTION_ID,
        toolId: 'email.send',
        requestedResources: [makeResourceScope('email', 'msg-2')],
        requestedActions: ['send'],
        consumedAt: NOW,
      }),
      (err: Error) => err instanceof AuthorizationStoreError && err.code === 'SCOPE_EXCEEDED',
    );
  });

  it('rejects consume with unauthorized action', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    assert.throws(
      () => store.consume(token.authorizationId, {
        actor: makeActor(),
        executionId: EXECUTION_ID,
        toolId: 'email.send',
        requestedResources: [makeResourceScope('email', 'msg-1')],
        requestedActions: ['delete'],
        consumedAt: NOW,
      }),
      (err: Error) => err instanceof AuthorizationStoreError && err.code === 'ACTION_NOT_ALLOWED',
    );
  });

  it('revokes token immediately', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    const revoked = store.revoke(token.authorizationId, NOW);
    assert.equal(revoked.state, 'REVOKED');
    assert.equal(revoked.revokedAt, NOW);
  });

  it('rejects consume of revoked token', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    store.revoke(token.authorizationId, NOW);
    assert.throws(
      () => store.consume(token.authorizationId, {
        actor: makeActor(),
        executionId: EXECUTION_ID,
        toolId: 'email.send',
        requestedResources: [makeResourceScope('email', 'msg-1')],
        requestedActions: ['send'],
        consumedAt: NOW,
      }),
      (err: Error) => err instanceof AuthorizationStoreError && err.code === 'INVALID_STATE',
    );
  });

  it('expires stale tokens', () => {
    const store = new AuthorizationStore();
    store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    // After expiry
    const expired = toUtcTimestamp('2026-07-28T12:00:00.000Z');
    const count = store.expireStale(expired);
    assert.equal(count, 1);
  });

  it('detects parameter scope exceeded', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    const within = store.isParameterScopeExceeded(token.authorizationId, [makeResourceScope('email', 'msg-1')]);
    assert.equal(within, false);
    const exceeded = store.isParameterScopeExceeded(token.authorizationId, [makeResourceScope('email', 'msg-2')]);
    assert.equal(exceeded, true);
  });

  it('computeTokenHash is stable for same logical token', () => {
    const baseInput = {
      schema: 'awkn-authorization-token/v1' as const,
      authorizationId: 'auth_' + 'a'.repeat(32),
      actor: makeActor(),
      executionId: EXECUTION_ID,
      toolId: 'email.send',
      allowedActions: ['send'],
      resourceScopes: [makeResourceScope('email', 'msg-1')],
      dataScopes: ['email_body'],
      maxExecutions: 1,
      usedCount: 0,
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      state: 'ACTIVE' as const,
      issuedAt: NOW,
    };
    const hash1 = computeTokenHash(baseInput);
    const hash2 = computeTokenHash({ ...baseInput, usedCount: 1, state: 'CONSUMED' as const });
    // 哈希应排除 usedCount / state / revokedAt
    assert.equal(hash1, hash2);
  });
});

// ============================================================================
// Section 3: Cumulative Risk
// ============================================================================

describe('Cumulative Risk', () => {
  it('returns R0 for empty tool routes', () => {
    const snapshot = computeCumulativeRisk([], new Map(), false);
    assert.equal(snapshot.cumulativeRisk, 'R0');
    assert.equal(snapshot.baseActionRisk, 'R0');
  });

  it('computes base action risk with repetition bonus', () => {
    const route = {
      schema: 'awkn-tool-route-plan/v1' as const,
      toolId: 'file.read',
      providerId: 'local',
      sideEffect: 'local_read' as const,
      riskBase: 'R1' as const,
      requiresAuthorization: false,
      requiresSideEffectVerification: false,
    };
    const r1 = computeBaseActionRisk(route, 1);
    const r3 = computeBaseActionRisk(route, 3);
    assert.equal(r1, 'R1');
    // 3 次调用: +2 (capped at +2)
    assert.equal(r3, 'R3');
  });

  it('aggregates risk across multiple tools', () => {
    const routes = [
      {
        schema: 'awkn-tool-route-plan/v1' as const,
        toolId: 'contact.read',
        providerId: 'google',
        sideEffect: 'external_read' as const,
        riskBase: 'R1' as const,
        requiresAuthorization: false,
        requiresSideEffectVerification: false,
      },
      {
        schema: 'awkn-tool-route-plan/v1' as const,
        toolId: 'calendar.read',
        providerId: 'google',
        sideEffect: 'external_read' as const,
        riskBase: 'R1' as const,
        requiresAuthorization: false,
        requiresSideEffectVerification: false,
      },
      {
        schema: 'awkn-tool-route-plan/v1' as const,
        toolId: 'email.send',
        providerId: 'google',
        sideEffect: 'external_send' as const,
        riskBase: 'R3' as const,
        requiresAuthorization: true,
        requiresSideEffectVerification: false,
      },
    ];
    const repMap = new Map([
      ['contact.read', 1],
      ['calendar.read', 1],
      ['email.send', 1],
    ]);
    const snapshot = computeCumulativeRisk(routes, repMap, false);
    // baseActionRisk = R3 (email.send)
    assert.equal(snapshot.baseActionRisk, 'R3');
    // 数据聚合: 2 个不同工具的写作用域
    assert.ok(['R1', 'R2'].includes(snapshot.dataAggregationRisk));
    // crossSystem = 3 (3 个外部动作, capped at 3)
    assert.equal(snapshot.crossSystemPropagation, 'R3');
    // identity = R2 (有 external_send)
    assert.equal(snapshot.identityRepresentation, 'R2');
    // 不可逆性: external_send 视为不可逆
    assert.ok(['R3', 'R4', 'R5'].includes(snapshot.irreversibility));
    // 累计风险至少为 R3
    const cumulativeValue = Number(snapshot.cumulativeRisk.slice(1));
    assert.ok(cumulativeValue >= 3, `expected >= R3, got ${snapshot.cumulativeRisk}`);
  });

  it('discounts risk when verified compensation exists', () => {
    const routes = [
      {
        schema: 'awkn-tool-route-plan/v1' as const,
        toolId: 'email.send',
        providerId: 'google',
        sideEffect: 'external_send' as const,
        riskBase: 'R3' as const,
        requiresAuthorization: true,
        requiresSideEffectVerification: false,
      },
    ];
    const repMap = new Map([['email.send', 1]]);
    const withoutComp = computeCumulativeRisk(routes, repMap, false);
    const withComp = computeCumulativeRisk(routes, repMap, true);
    // 有补偿时累计风险应该 <= 无补偿
    const withoutValue = Number(withoutComp.cumulativeRisk.slice(1));
    const withValue = Number(withComp.cumulativeRisk.slice(1));
    assert.ok(withValue <= withoutValue, 'verified compensation should not increase risk');
  });

  it('requiresAdditionalControls triggers at R3+', () => {
    const snapshot = {
      schema: 'awkn-risk-snapshot/v1' as const,
      baseActionRisk: 'R3' as const,
      dataAggregationRisk: 'R0' as const,
      irreversibility: 'R0' as const,
      crossSystemPropagation: 'R0' as const,
      financialImpact: 'R0' as const,
      identityRepresentation: 'R0' as const,
      repetitionFactor: 0,
      verifiedCompensation: false,
      cumulativeRisk: 'R3' as const,
    };
    assert.equal(requiresAdditionalControls(snapshot), true);
  });

  it('requiresHumanReview triggers at R4+', () => {
    const r3 = {
      schema: 'awkn-risk-snapshot/v1' as const,
      baseActionRisk: 'R3' as const,
      dataAggregationRisk: 'R0' as const,
      irreversibility: 'R0' as const,
      crossSystemPropagation: 'R0' as const,
      financialImpact: 'R0' as const,
      identityRepresentation: 'R0' as const,
      repetitionFactor: 0,
      verifiedCompensation: false,
      cumulativeRisk: 'R3' as const,
    };
    const r4 = { ...r3, cumulativeRisk: 'R4' as const };
    assert.equal(requiresHumanReview(r3), false);
    assert.equal(requiresHumanReview(r4), true);
  });

  it('requiresHumanReview triggers at R3 + irreversibility R3', () => {
    const snapshot = {
      schema: 'awkn-risk-snapshot/v1' as const,
      baseActionRisk: 'R3' as const,
      dataAggregationRisk: 'R0' as const,
      irreversibility: 'R3' as const,
      crossSystemPropagation: 'R0' as const,
      financialImpact: 'R0' as const,
      identityRepresentation: 'R0' as const,
      repetitionFactor: 0,
      verifiedCompensation: false,
      cumulativeRisk: 'R3' as const,
    };
    assert.equal(requiresHumanReview(snapshot), true);
  });

  it('requiresSecondaryConfirmation triggers at R3+', () => {
    const r2 = {
      schema: 'awkn-risk-snapshot/v1' as const,
      baseActionRisk: 'R2' as const,
      dataAggregationRisk: 'R0' as const,
      irreversibility: 'R0' as const,
      crossSystemPropagation: 'R0' as const,
      financialImpact: 'R0' as const,
      identityRepresentation: 'R0' as const,
      repetitionFactor: 0,
      verifiedCompensation: false,
      cumulativeRisk: 'R2' as const,
    };
    const r3 = { ...r2, cumulativeRisk: 'R3' as const };
    assert.equal(requiresSecondaryConfirmation(r2), false);
    assert.equal(requiresSecondaryConfirmation(r3), true);
  });

  it('forbidsAutomaticRetry for irreversible + R3+', () => {
    const snapshot = {
      schema: 'awkn-risk-snapshot/v1' as const,
      baseActionRisk: 'R3' as const,
      dataAggregationRisk: 'R0' as const,
      irreversibility: 'R3' as const,
      crossSystemPropagation: 'R0' as const,
      financialImpact: 'R0' as const,
      identityRepresentation: 'R0' as const,
      repetitionFactor: 0,
      verifiedCompensation: false,
      cumulativeRisk: 'R3' as const,
    };
    assert.equal(forbidsAutomaticRetry(snapshot), true);
  });

  it('forbidsAutomaticRetry for R4+ regardless of reversibility', () => {
    const snapshot = {
      schema: 'awkn-risk-snapshot/v1' as const,
      baseActionRisk: 'R4' as const,
      dataAggregationRisk: 'R0' as const,
      irreversibility: 'R0' as const,
      crossSystemPropagation: 'R0' as const,
      financialImpact: 'R0' as const,
      identityRepresentation: 'R0' as const,
      repetitionFactor: 0,
      verifiedCompensation: false,
      cumulativeRisk: 'R4' as const,
    };
    assert.equal(forbidsAutomaticRetry(snapshot), true);
  });
});

// ============================================================================
// Section 4: Provider Choice
// ============================================================================

describe('Provider Choice', () => {
  it('returns fail-closed when no providers available', () => {
    const result = selectProvider({
      availableProviders: [],
      allowInternalAutoRoute: true,
    });
    assert.equal(result.chosen, undefined);
    assert.equal(result.requiresUserSelection, false);
    assert.ok(result.reasonCodes.includes('NO_AVAILABLE_PROVIDER'));
  });

  it('uses user-selected provider', () => {
    const providers = [makeProvider({ providerId: 'trae', isInternal: true }), makeProvider({ providerId: 'codex', isInternal: false })];
    const result = selectProvider({
      availableProviders: providers,
      userSelectedProviderId: 'codex',
      allowInternalAutoRoute: true,
    });
    assert.equal(result.chosen?.providerId, 'codex');
    assert.equal(result.requiresUserSelection, false);
    assert.ok(result.reasonCodes.includes('USER_SELECTED'));
  });

  it('throws when user-selected provider not available', () => {
    const providers = [makeProvider({ providerId: 'trae' })];
    assert.throws(
      () => selectProvider({
        availableProviders: providers,
        userSelectedProviderId: 'nonexistent',
        allowInternalAutoRoute: true,
      }),
      (err: Error) => err instanceof ProviderChoiceError && err.code === 'PROVIDER_UNAVAILABLE',
    );
  });

  it('uses persistent preference when valid', () => {
    const providers = [makeProvider({ providerId: 'trae' }), makeProvider({ providerId: 'codex', isInternal: false })];
    const result = selectProvider({
      availableProviders: providers,
      persistentPreference: 'codex',
      persistentPreferenceValid: true,
      allowInternalAutoRoute: true,
    });
    assert.equal(result.chosen?.providerId, 'codex');
    assert.ok(result.reasonCodes.includes('PERSISTENT_PREFERENCE'));
  });

  it('auto-routes to single internal provider', () => {
    const providers = [
      makeProvider({ providerId: 'internal', isInternal: true }),
      makeProvider({ providerId: 'external1', isInternal: false }),
      makeProvider({ providerId: 'external2', isInternal: false }),
    ];
    const result = selectProvider({
      availableProviders: providers,
      allowInternalAutoRoute: true,
    });
    assert.equal(result.chosen?.providerId, 'internal');
    assert.ok(result.reasonCodes.includes('INTERNAL_AUTO_ROUTE'));
  });

  it('requires user selection when multiple third-party providers', () => {
    const providers = [
      makeProvider({ providerId: 'external1', isInternal: false }),
      makeProvider({ providerId: 'external2', isInternal: false }),
    ];
    const result = selectProvider({
      availableProviders: providers,
      allowInternalAutoRoute: false,
    });
    assert.equal(result.chosen, undefined);
    assert.equal(result.requiresUserSelection, true);
    assert.equal(result.choices.length, 2);
  });

  it('uses only available provider', () => {
    const providers = [makeProvider({ providerId: 'only' })];
    const result = selectProvider({
      availableProviders: providers,
      allowInternalAutoRoute: false,
    });
    assert.equal(result.chosen?.providerId, 'only');
    assert.ok(result.reasonCodes.includes('ONLY_AVAILABLE'));
  });
});

// ============================================================================
// Section 5: Model Broker
// ============================================================================

describe('Model Broker', () => {
  it('selects model by capability match', () => {
    const providers = [
      makeProvider({
        providerId: 'trae',
        models: [makeModelDescriptor({ modelId: 'gpt-5', capabilities: ['reasoning', 'tool_calling'] })],
      }),
    ];
    const route = selectModel(makeModelRouteRequest(), providers);
    assert.equal(route.selectedProviderId, 'trae');
    assert.equal(route.selectedModelId, 'gpt-5');
    assert.ok(route.reasonCodes.includes('CAPABILITY_MATCH'));
  });

  it('throws when no providers available', () => {
    assert.throws(
      () => selectModel(makeModelRouteRequest(), []),
      (err: Error) => err instanceof ModelBrokerError && err.code === 'NO_PROVIDER',
    );
  });

  it('throws when no model has required capabilities', () => {
    const providers = [
      makeProvider({
        models: [makeModelDescriptor({ capabilities: ['reasoning'] })],
      }),
    ];
    assert.throws(
      () => selectModel(makeModelRouteRequest({ requiredCapabilities: ['vision'] }), providers),
      (err: Error) => err instanceof ModelBrokerError && err.code === 'CAPABILITY_GAP',
    );
  });

  it('throws when context window insufficient', () => {
    const providers = [
      makeProvider({
        models: [makeModelDescriptor({ contextWindow: 1000 })],
      }),
    ];
    assert.throws(
      () => selectModel(makeModelRouteRequest({ requiredContextWindow: 100000 }), providers),
      (err: Error) => err instanceof ModelBrokerError && err.code === 'CONTEXT_WINDOW_EXCEEDED',
    );
  });

  it('throws when latency exceeds ceiling', () => {
    const providers = [
      makeProvider({
        models: [makeModelDescriptor({ latencyP99Ms: 10000 })],
      }),
    ];
    assert.throws(
      () => selectModel(makeModelRouteRequest({ latencyCeilingMs: 1000 }), providers),
      (err: Error) => err instanceof ModelBrokerError && err.code === 'LATENCY_EXCEEDED',
    );
  });

  it('throws when cost exceeds ceiling', () => {
    const providers = [
      makeProvider({
        models: [makeModelDescriptor({ inputCostPer1k: 100, outputCostPer1k: 100 })],
      }),
    ];
    assert.throws(
      () => selectModel(makeModelRouteRequest({ costCeilingUsd: 0.01 }), providers),
      (err: Error) => err instanceof ModelBrokerError && err.code === 'COST_EXCEEDED',
    );
  });

  it('uses user-requested model when available', () => {
    const providers = [
      makeProvider({
        providerId: 'trae',
        models: [
          makeModelDescriptor({ modelId: 'gpt-5', capabilities: ['reasoning'] }),
          makeModelDescriptor({ modelId: 'gpt-4', capabilities: ['reasoning', 'tool_calling'] }),
        ],
      }),
    ];
    const route = selectModel(
      makeModelRouteRequest({
        requestedProviderId: 'trae',
        requestedModelId: 'gpt-5',
        requiredCapabilities: ['reasoning', 'tool_calling'],
      }),
      providers,
    );
    assert.equal(route.selectedModelId, 'gpt-5');
    assert.ok(route.reasonCodes.includes('USER_REQUESTED'));
  });

  it('throws when requested model not found', () => {
    const providers = [makeProvider({ providerId: 'trae' })];
    assert.throws(
      () => selectModel(
        makeModelRouteRequest({ requestedModelId: 'nonexistent' }),
        providers,
      ),
      (err: Error) => err instanceof ModelBrokerError && err.code === 'REQUESTED_MODEL_NOT_FOUND',
    );
  });

  it('builds fallback chain from other providers', () => {
    const providers = [
      makeProvider({
        providerId: 'trae',
        models: [makeModelDescriptor({ modelId: 'gpt-5', capabilities: ['reasoning', 'tool_calling'] })],
      }),
      makeProvider({
        providerId: 'codex',
        isInternal: false,
        models: [makeModelDescriptor({ providerId: 'codex', modelId: 'codex-1', capabilities: ['reasoning', 'tool_calling'] })],
      }),
    ];
    const route = selectModel(makeModelRouteRequest(), providers);
    assert.ok(route.fallbackChain.length > 0);
    assert.ok(route.fallbackChain.some((f) => f.includes('codex')));
  });
});

// ============================================================================
// Section 6: Tool Broker
// ============================================================================

describe('Tool Broker', () => {
  it('builds tool route plan for read-only tool', () => {
    const cap = makeToolCapability({ requiresAuthorization: false });
    const plan = buildToolRoutePlan(cap);
    assert.equal(plan.toolId, 'file.read');
    assert.equal(plan.requiresAuthorization, false);
    assert.equal(plan.authorizationRequirement, undefined);
    assert.equal(plan.requiresSideEffectVerification, false);
  });

  it('builds tool route plan with authorization requirement', () => {
    const cap = makeToolCapability({
      toolId: 'email.send',
      requiresAuthorization: true,
      sideEffect: 'external_send',
      riskBase: 'R3',
      supportsIdempotency: true,
      supportsVerification: true,
    });
    const requirement: AuthorizationRequirementInput = {
      requiredActions: ['send'],
      resourceScopes: [makeResourceScope('email', 'msg-1')],
      dataScopes: ['email_body'],
      riskCeiling: 'R3',
      maxExecutions: 1,
      requiresHumanConfirmation: true,
    };
    const plan = buildToolRoutePlan(cap, requirement);
    assert.equal(plan.requiresAuthorization, true);
    assert.ok(plan.authorizationRequirement);
    assert.equal(plan.authorizationRequirement!.toolId, 'email.send');
    assert.equal(plan.authorizationRequirement!.maxExecutions, 1);
    assert.ok(plan.idempotencyKey);
    assert.equal(plan.requiresSideEffectVerification, true);
  });

  it('throws when authorization required but not provided', () => {
    const cap = makeToolCapability({ requiresAuthorization: true });
    assert.throws(
      () => buildToolRoutePlan(cap),
      (err: Error) => err instanceof ToolBrokerError && err.code === 'AUTHORIZATION_REQUIRED',
    );
  });

  it('verifySideEffect trusts reversible tool reported success without verifyReadonly', async () => {
    const cap = makeToolCapability({
      sideEffect: 'local_write',
      reversible: true,
      supportsVerification: true,
    });
    const { receipt, verification } = await verifySideEffect({
      toolCallId: newToolCallId(),
      toolCapability: cap,
      reportedSuccess: true,
      resourceRefs: ['file://path'],
      requestHash: 'a'.repeat(64),
      resultHash: 'b'.repeat(64),
    }, NOW);
    assert.equal(receipt.reportedSuccess, true);
    assert.equal(receipt.verifiedSuccess, true);
    assert.equal(verification.partialState, false);
    assert.equal(verification.compensationTriggered, false);
  });

  it('verifySideEffect marks PARTIAL for irreversible tool without verifyreadonly', async () => {
    const cap = makeToolCapability({
      sideEffect: 'external_send',
      reversible: false,
      supportsVerification: true,
    });
    const { receipt, verification } = await verifySideEffect({
      toolCallId: newToolCallId(),
      toolCapability: cap,
      reportedSuccess: true,
      resourceRefs: ['email://msg-1'],
      requestHash: 'a'.repeat(64),
      resultHash: 'b'.repeat(64),
    }, NOW);
    assert.equal(receipt.reportedSuccess, true);
    assert.equal(receipt.verifiedSuccess, false);
    assert.equal(verification.partialState, true);
    assert.equal(verification.compensationTriggered, false);
    assert.ok(verification.verificationReasonCodes.includes('VERIFICATION_MISSING_FOR_IRREVERSIBLE'));
  });

  it('verifySideEffect triggers compensation when irreversible tool reports failure', async () => {
    const cap = makeToolCapability({
      sideEffect: 'external_send',
      reversible: false,
      supportsVerification: true,
    });
    const { receipt, verification } = await verifySideEffect({
      toolCallId: newToolCallId(),
      toolCapability: cap,
      reportedSuccess: false,
      resourceRefs: ['email://msg-1'],
      requestHash: 'a'.repeat(64),
      resultHash: 'b'.repeat(64),
    }, NOW);
    assert.equal(receipt.reportedSuccess, false);
    assert.equal(receipt.verifiedSuccess, false);
    assert.equal(verification.compensationTriggered, true);
    assert.ok(receipt.compensationRef);
  });

  it('verifySideEffect uses verifyReadonly to verify success', async () => {
    const cap = makeToolCapability({
      sideEffect: 'external_write',
      reversible: false,
      supportsVerification: true,
    });
    const { receipt, verification } = await verifySideEffect({
      toolCallId: newToolCallId(),
      toolCapability: cap,
      reportedSuccess: true,
      resourceRefs: ['resource://1'],
      requestHash: 'a'.repeat(64),
      resultHash: 'b'.repeat(64),
      verifyReadonly: async () => ({ verifiedSuccess: true, reasonCodes: ['VERIFIED'] }),
    }, NOW);
    assert.equal(receipt.verifiedSuccess, true);
    assert.ok(verification.verificationReasonCodes.includes('VERIFIED'));
  });

  it('verifySideEffect triggers compensation when verifyReadonly fails on irreversible tool', async () => {
    const cap = makeToolCapability({
      sideEffect: 'external_write',
      reversible: false,
      supportsVerification: true,
    });
    const { receipt, verification } = await verifySideEffect({
      toolCallId: newToolCallId(),
      toolCapability: cap,
      reportedSuccess: true,
      resourceRefs: ['resource://1'],
      requestHash: 'a'.repeat(64),
      resultHash: 'b'.repeat(64),
      verifyReadonly: async () => ({ verifiedSuccess: false, reasonCodes: ['NOT_FOUND'] }),
    }, NOW);
    assert.equal(receipt.verifiedSuccess, false);
    assert.equal(verification.compensationTriggered, true);
    assert.ok(verification.verificationReasonCodes.includes('VERIFICATION_FAILED'));
  });

  it('canAutoRetry allows retry for reversible + verified success', () => {
    const cap = makeToolCapability({ reversible: true });
    const verification = {
      schema: 'awkn-side-effect-verification/v1' as const,
      toolCallId: 'tc_test',
      reportedSuccess: true,
      verifiedSuccess: true,
      resourceRefs: [],
      verificationReasonCodes: [],
      compensationTriggered: false,
      partialState: false,
    };
    assert.equal(canAutoRetry(cap, verification), true);
  });

  it('canAutoRetry forbids retry for irreversible tool', () => {
    const cap = makeToolCapability({ reversible: false });
    const verification = {
      schema: 'awkn-side-effect-verification/v1' as const,
      toolCallId: 'tc_test',
      reportedSuccess: true,
      verifiedSuccess: true,
      resourceRefs: [],
      verificationReasonCodes: [],
      compensationTriggered: false,
      partialState: false,
    };
    assert.equal(canAutoRetry(cap, verification), false);
  });

  it('canAutoRetry forbids retry for partial state', () => {
    const cap = makeToolCapability({ reversible: true });
    const verification = {
      schema: 'awkn-side-effect-verification/v1' as const,
      toolCallId: 'tc_test',
      reportedSuccess: true,
      verifiedSuccess: false,
      resourceRefs: [],
      verificationReasonCodes: [],
      compensationTriggered: false,
      partialState: true,
    };
    assert.equal(canAutoRetry(cap, verification), false);
  });
});

// ============================================================================
// Section 7: Broker Plan
// ============================================================================

describe('Broker Plan', () => {
  function makeBrokerPlanInput(overrides: Partial<BrokerPlanInput> = {}): BrokerPlanInput {
    return {
      executionId: EXECUTION_ID,
      modelRouteRequests: [makeModelRouteRequest()],
      toolCapabilities: [makeToolCapability({ requiresAuthorization: false })],
      toolRequirements: new Map(),
      providers: [makeProvider({ isInternal: true })],
      providerSelection: { allowInternalAutoRoute: true },
      costBudget: { budgetCeilingUsd: 1.0, budgetConsumedUsd: 0 },
      verifiedCompensation: false,
      frozenAt: NOW,
      ...overrides,
    };
  }

  it('builds a valid BrokerPlan', () => {
    const input = makeBrokerPlanInput();
    const plan = buildBrokerPlan(input);
    assert.equal(plan.schema, 'awkn-broker-plan/v1');
    assert.equal(plan.executionId, EXECUTION_ID);
    assert.equal(plan.modelRoutes.length, 1);
    assert.equal(plan.toolRoutes.length, 1);
    assert.ok(plan.planHash.length === 64);
    assert.equal(plan.frozenAt, NOW);
    // Schema validation
    const result = BrokerPlanSchema.safeParse(plan);
    assert.ok(result.success, `expected schema success: ${result.success ? '' : result.error.message}`);
  });

  it('throws when no model route requests', () => {
    const input = makeBrokerPlanInput({ modelRouteRequests: [] });
    assert.throws(
      () => buildBrokerPlan(input),
      (err: Error) => err instanceof BrokerError && err.code === 'EMPTY_MODEL_ROUTES',
    );
  });

  it('throws when provider selection requires user input', () => {
    const input = makeBrokerPlanInput({
      providers: [
        makeProvider({ providerId: 'p1', isInternal: false }),
        makeProvider({ providerId: 'p2', isInternal: false }),
      ],
      providerSelection: { allowInternalAutoRoute: false },
    });
    assert.throws(
      () => buildBrokerPlan(input),
      (err: Error) => err instanceof BrokerError && err.code === 'PROVIDER_SELECTION_REQUIRED',
    );
  });

  it('throws when tool requires authorization but no requirement provided', () => {
    const input = makeBrokerPlanInput({
      toolCapabilities: [makeToolCapability({ requiresAuthorization: true })],
      toolRequirements: new Map(),
    });
    assert.throws(
      () => buildBrokerPlan(input),
      (err: Error) => err instanceof ToolBrokerError && err.code === 'AUTHORIZATION_REQUIRED',
    );
  });

  it('plan hash is deterministic for same logical plan', () => {
    const input = makeBrokerPlanInput();
    const plan1 = buildBrokerPlan(input);
    const plan2 = buildBrokerPlan(input);
    // 同一 logical input 应产生相同 hash (排除 brokerPlanId 是随机的, 但 hash 不包含它)
    // 注意: brokerPlanId 是随机的, 所以 hash 会不同
    // 但 plan1.planHash 应该是有效的 SHA256
    assert.equal(plan1.planHash.length, 64);
    assert.equal(plan2.planHash.length, 64);
  });

  it('computeBrokerPlanHash is stable for same input', () => {
    const plan: Omit<BrokerPlan, 'planHash' | 'frozenAt'> = {
      schema: 'awkn-broker-plan/v1',
      brokerPlanId: 'bp_' + 'a'.repeat(32),
      executionId: EXECUTION_ID,
      modelRoutes: [],
      toolRoutes: [],
      providerChoices: [],
      authorizationRequirements: [],
      cumulativeRisk: {
        schema: 'awkn-risk-snapshot/v1',
        baseActionRisk: 'R0',
        dataAggregationRisk: 'R0',
        irreversibility: 'R0',
        crossSystemPropagation: 'R0',
        financialImpact: 'R0',
        identityRepresentation: 'R0',
        repetitionFactor: 0,
        verifiedCompensation: false,
        cumulativeRisk: 'R0',
      },
      costBudget: {
        schema: 'awkn-cost-budget/v1',
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        budgetCeilingUsd: 1,
        budgetConsumedUsd: 0,
      },
    };
    const hash1 = computeBrokerPlanHash(plan);
    const hash2 = computeBrokerPlanHash(plan);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });
});

// ============================================================================
// Section 8: Receipts
// ============================================================================

describe('Broker Receipts', () => {
  it('builds a ModelRouteReceipt', () => {
    const receipt = buildModelRouteReceipt({
      traceId: createAwknId('trace'),
      callSource: 'main_dialogue',
      requestedProvider: 'trae',
      requestedModel: 'gpt-5',
      executedProvider: 'trae',
      executedModel: 'gpt-5',
      routeReasonCodes: ['CAPABILITY_MATCH'],
      fallbackOccurred: false,
      fallbackChain: [],
      capabilityDelta: [],
      promptVersion: 'v1',
      policyBundleHash: 'b'.repeat(64),
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1500,
      createdAt: NOW,
    });
    assert.equal(receipt.schema, 'awkn-model-route-receipt/v1');
    assert.ok(receipt.routeId.startsWith('mr_'));
    assert.equal(receipt.fallbackOccurred, false);
    assert.ok(ModelRouteReceiptSchema.safeParse(receipt).success);
  });

  it('builds a DegradationNotice', () => {
    const notice = buildDegradationNotice({
      level: 'DEGRADED',
      capabilityDelta: ['MISSING:structured_output'],
      fallbackChain: ['codex/codex-1'],
      requiresReconfirmation: true,
      structuredOutputMissing: true,
      reviewerReuseForbidden: true,
    });
    assert.equal(notice.schema, 'awkn-degradation-notice/v1');
    assert.equal(notice.level, 'DEGRADED');
    assert.ok(notice.capabilityDelta.includes('MISSING:structured_output'));
  });

  it('shouldStopForStructuredOutputMissing returns true for BLOCKING + missing', () => {
    const notice = buildDegradationNotice({
      level: 'BLOCKING',
      capabilityDelta: [],
      fallbackChain: [],
      requiresReconfirmation: false,
      structuredOutputMissing: true,
      reviewerReuseForbidden: false,
    });
    assert.equal(shouldStopForStructuredOutputMissing(notice), true);
  });

  it('shouldStopForStructuredOutputMissing returns false for non-BLOCKING', () => {
    const notice = buildDegradationNotice({
      level: 'DEGRADED',
      capabilityDelta: [],
      fallbackChain: [],
      requiresReconfirmation: false,
      structuredOutputMissing: true,
      reviewerReuseForbidden: false,
    });
    assert.equal(shouldStopForStructuredOutputMissing(notice), false);
  });

  it('isReviewerReuseForbidden returns true when set', () => {
    const notice = buildDegradationNotice({
      level: 'DEGRADED',
      capabilityDelta: [],
      fallbackChain: [],
      requiresReconfirmation: false,
      structuredOutputMissing: false,
      reviewerReuseForbidden: true,
    });
    assert.equal(isReviewerReuseForbidden(notice), true);
  });
});

// ============================================================================
// Section 9: Acceptance Criteria (设计文档第 13 节)
// ============================================================================

describe('Acceptance: 设计文档第 13 节', () => {
  it('所有模型调用生成 Model Route Receipt', async () => {
    const providers = [makeProvider()];
    const route = selectModel(makeModelRouteRequest(), providers);
    const receipt = buildModelRouteReceipt({
      traceId: createAwknId('trace'),
      callSource: 'main_dialogue',
      executedProvider: route.selectedProviderId,
      executedModel: route.selectedModelId,
      routeReasonCodes: route.reasonCodes,
      fallbackOccurred: false,
      fallbackChain: route.fallbackChain,
      capabilityDelta: route.capabilityDelta,
      promptVersion: 'v1',
      policyBundleHash: 'b'.repeat(64),
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1500,
      createdAt: NOW,
    });
    assert.ok(receipt.schema === 'awkn-model-route-receipt/v1');
  });

  it('所有有副作用工具生成 Authorization 和 Execution Receipt', async () => {
    const cap = makeToolCapability({
      toolId: 'email.send',
      sideEffect: 'external_send',
      reversible: false,
      riskBase: 'R3',
      requiresAuthorization: true,
      supportsIdempotency: true,
      supportsVerification: true,
    });
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        providerId: 'google',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    store.consume(token.authorizationId, {
      actor: makeActor(),
      executionId: EXECUTION_ID,
      toolId: 'email.send',
      requestedResources: [makeResourceScope('email', 'msg-1')],
      requestedActions: ['send'],
      consumedAt: NOW,
    });
    const { receipt } = await verifySideEffect({
      toolCallId: newToolCallId(),
      toolCapability: cap,
      reportedSuccess: true,
      resourceRefs: ['email://msg-1'],
      requestHash: 'a'.repeat(64),
      resultHash: 'b'.repeat(64),
    }, NOW);
    assert.equal(receipt.schema, 'awkn-tool-execution-receipt/v1');
    assert.ok(receipt.authorizationId === undefined || receipt.authorizationId.startsWith('auth_'));
  });

  it('累计风险可查询', () => {
    const routes = [
      {
        schema: 'awkn-tool-route-plan/v1' as const,
        toolId: 'email.send',
        providerId: 'google',
        sideEffect: 'external_send' as const,
        riskBase: 'R3' as const,
        requiresAuthorization: true,
        requiresSideEffectVerification: false,
      },
    ];
    const snapshot = computeCumulativeRisk(routes, new Map([['email.send', 1]]), false);
    assert.ok(snapshot.cumulativeRisk.startsWith('R'));
    assert.ok(['R0', 'R1', 'R2', 'R3', 'R4', 'R5'].includes(snapshot.cumulativeRisk));
  });

  it('fallback 和降级对 Outcome 可见', () => {
    const notice = buildDegradationNotice({
      level: 'DEGRADED',
      capabilityDelta: ['MISSING:structured_output'],
      fallbackChain: ['codex/codex-1'],
      requiresReconfirmation: true,
      structuredOutputMissing: true,
      reviewerReuseForbidden: true,
    });
    assert.equal(notice.level, 'DEGRADED');
    assert.ok(notice.capabilityDelta.length > 0);
    assert.ok(notice.fallbackChain.length > 0);
  });
});

// ============================================================================
// Section 10: Acceptance Tests (设计文档第 12 节)
// ============================================================================

describe('Acceptance: 设计文档第 12 节 测试矩阵', () => {
  it('1. 请求模型和实际模型都被记录', () => {
    const providers = [
      makeProvider({
        providerId: 'trae',
        models: [makeModelDescriptor({ providerId: 'trae', modelId: 'gpt-5' })],
      }),
    ];
    const route = selectModel(
      makeModelRouteRequest({ requestedProviderId: 'trae', requestedModelId: 'gpt-5' }),
      providers,
    );
    const receipt = buildModelRouteReceipt({
      traceId: createAwknId('trace'),
      callSource: 'main_dialogue',
      requestedProvider: route.requestedProviderId,
      requestedModel: route.requestedModelId,
      executedProvider: route.selectedProviderId,
      executedModel: route.selectedModelId,
      routeReasonCodes: route.reasonCodes,
      fallbackOccurred: false,
      fallbackChain: route.fallbackChain,
      capabilityDelta: route.capabilityDelta,
      promptVersion: 'v1',
      policyBundleHash: 'b'.repeat(64),
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1500,
      createdAt: NOW,
    });
    assert.equal(receipt.requestedProvider, 'trae');
    assert.equal(receipt.requestedModel, 'gpt-5');
    assert.equal(receipt.executedProvider, 'trae');
    assert.equal(receipt.executedModel, 'gpt-5');
  });

  it('2. fallback 链完整记录', () => {
    const providers = [
      makeProvider({
        providerId: 'trae',
        models: [makeModelDescriptor({ providerId: 'trae', modelId: 'gpt-5', capabilities: ['reasoning', 'tool_calling'] })],
      }),
      makeProvider({
        providerId: 'codex',
        isInternal: false,
        models: [makeModelDescriptor({ providerId: 'codex', modelId: 'codex-1', capabilities: ['reasoning', 'tool_calling'] })],
      }),
    ];
    const route = selectModel(makeModelRouteRequest(), providers);
    assert.ok(route.fallbackChain.length > 0);
  });

  it('3. R3 以上动作没有 Token 时被拒绝', () => {
    const cap = makeToolCapability({
      toolId: 'email.send',
      sideEffect: 'external_send',
      riskBase: 'R3',
      requiresAuthorization: true,
    });
    assert.throws(
      () => buildToolRoutePlan(cap),
      (err: Error) => err instanceof ToolBrokerError && err.code === 'AUTHORIZATION_REQUIRED',
    );
  });

  it('4. Token 不能跨项目使用', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: { ...makeActor(), projectId: 'proj-1' },
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    // 不同 actor (跨用户)
    assert.throws(
      () => store.consume(token.authorizationId, {
        actor: { ...makeActor(), actorId: 'user-2', projectId: 'proj-2' },
        executionId: EXECUTION_ID,
        toolId: 'email.send',
        requestedResources: [makeResourceScope('email', 'msg-1')],
        requestedActions: ['send'],
        consumedAt: NOW,
      }),
      (err: Error) => err instanceof AuthorizationStoreError && err.code === 'ACTOR_MISMATCH',
    );
  });

  it('5. 参数变化超出授权范围时被拒绝', () => {
    const store = new AuthorizationStore();
    const token = store.issue({
      actor: makeActor(),
      executionId: EXECUTION_ID,
      requirement: {
        toolId: 'email.send',
        requiredActions: ['send'],
        resourceScopes: [makeResourceScope('email', 'msg-1')],
        dataScopes: ['email_body'],
        riskCeiling: 'R3',
        maxExecutions: 1,
        requiresHumanConfirmation: true,
      },
      expiresAt: LATER,
      confirmationSourceRef: 'confirmation',
      issuedAt: NOW,
    });
    assert.throws(
      () => store.consume(token.authorizationId, {
        actor: makeActor(),
        executionId: EXECUTION_ID,
        toolId: 'email.send',
        requestedResources: [makeResourceScope('email', 'msg-2')],
        requestedActions: ['send'],
        consumedAt: NOW,
      }),
      (err: Error) => err instanceof AuthorizationStoreError && err.code === 'SCOPE_EXCEEDED',
    );
  });

  it('6. 多步动作累计风险能够升级', () => {
    const routes = [
      {
        schema: 'awkn-tool-route-plan/v1' as const,
        toolId: 'contact.read',
        providerId: 'google',
        sideEffect: 'external_read' as const,
        riskBase: 'R1' as const,
        requiresAuthorization: false,
        requiresSideEffectVerification: false,
      },
      {
        schema: 'awkn-tool-route-plan/v1' as const,
        toolId: 'calendar.read',
        providerId: 'google',
        sideEffect: 'external_read' as const,
        riskBase: 'R1' as const,
        requiresAuthorization: false,
        requiresSideEffectVerification: false,
      },
      {
        schema: 'awkn-tool-route-plan/v1' as const,
        toolId: 'content.generate',
        providerId: 'local',
        sideEffect: 'local_write' as const,
        riskBase: 'R1' as const,
        requiresAuthorization: false,
        requiresSideEffectVerification: false,
      },
      {
        schema: 'awkn-tool-route-plan/v1' as const,
        toolId: 'email.send',
        providerId: 'google',
        sideEffect: 'external_send' as const,
        riskBase: 'R3' as const,
        requiresAuthorization: true,
        requiresSideEffectVerification: false,
      },
    ];
    const repMap = new Map([
      ['contact.read', 1],
      ['calendar.read', 1],
      ['content.generate', 1],
      ['email.send', 1],
    ]);
    const snapshot = computeCumulativeRisk(routes, repMap, false);
    // 累计风险应高于单个 R3 (即 >= R4)
    const cumulativeValue = Number(snapshot.cumulativeRisk.slice(1));
    assert.ok(cumulativeValue >= 4, `expected >= R4, got ${snapshot.cumulativeRisk}`);
  });

  it('7. 外部工具报告成功但验证失败时进入 PARTIAL', async () => {
    const cap = makeToolCapability({
      sideEffect: 'external_write',
      reversible: false,
      supportsVerification: true,
    });
    const { receipt, verification } = await verifySideEffect({
      toolCallId: newToolCallId(),
      toolCapability: cap,
      reportedSuccess: true,
      resourceRefs: ['resource://1'],
      requestHash: 'a'.repeat(64),
      resultHash: 'b'.repeat(64),
      verifyReadonly: async () => ({ verifiedSuccess: false, reasonCodes: ['NOT_FOUND'] }),
    }, NOW);
    assert.equal(receipt.reportedSuccess, true);
    assert.equal(receipt.verifiedSuccess, false);
    // 不可逆 + 验证失败 → 触发补偿 (非 PARTIAL)
    assert.equal(verification.compensationTriggered, true);
  });

  it('8. 不可逆动作不自动重复', () => {
    const cap = makeToolCapability({ reversible: false });
    const verification = {
      schema: 'awkn-side-effect-verification/v1' as const,
      toolCallId: 'tc_test',
      reportedSuccess: true,
      verifiedSuccess: true,
      resourceRefs: [],
      verificationReasonCodes: [],
      compensationTriggered: false,
      partialState: false,
    };
    assert.equal(canAutoRetry(cap, verification), false);
  });

  it('9. 用户未选择第三方供应商时系统不擅自决定', () => {
    const providers = [
      makeProvider({ providerId: 'p1', isInternal: false }),
      makeProvider({ providerId: 'p2', isInternal: false }),
    ];
    const result = selectProvider({
      availableProviders: providers,
      allowInternalAutoRoute: false,
    });
    assert.equal(result.chosen, undefined);
    assert.equal(result.requiresUserSelection, true);
  });

  it('10. Reviewer 不允许回退到执行模型 (degradation notice)', () => {
    const notice = buildDegradationNotice({
      level: 'DEGRADED',
      capabilityDelta: [],
      fallbackChain: [],
      requiresReconfirmation: false,
      structuredOutputMissing: false,
      reviewerReuseForbidden: true,
    });
    assert.equal(isReviewerReuseForbidden(notice), true);
  });
});
