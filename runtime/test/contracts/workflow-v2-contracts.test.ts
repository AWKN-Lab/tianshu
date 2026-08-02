/**
 * 工作流 v2 契约测试 — Schema 验证
 *
 * 覆盖: WorkflowStageTypeSchema (17 types)、StageRunStateSchema (10 states)、
 *       AgentProfileV2Schema、AgentInstanceV2Schema、WorkflowStageRunSchema、
 *       StageGraphSchema、Worker Spawn/Result schemas、INCOMPATIBLE_PAIRS_V2 (20 pairs)、
 *       ROLE_TO_DEFAULT_SPECIALTY (12 roles)、ProfileStatusSchema (6 statuses)、
 *       ProviderPolicySchema (3 values)、MemoryPolicySchema (3 values)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WorkflowStageTypeSchema,
  StageRunStateSchema,
  STAGE_COMPLETION_STATES,
  STAGE_TERMINAL_STATES,
  ProfileStatusSchema,
  ProviderPolicySchema,
  MemoryPolicySchema,
  AgentProfileV2Schema,
  AgentInstanceV2Schema,
  WorkflowStageRunSchema,
  StageGraphSchema,
  WorkerSpawnRequestSchema,
  WorkerSpawnReceiptSchema,
  WorkerResultEnvelopeSchema,
  INCOMPATIBLE_PAIRS_V2,
  ROLE_TO_DEFAULT_SPECIALTY,
} from '../../src/contracts/workflow-v2.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const GOAL_ID = `goal_${'a'.repeat(32)}`;
const ENV_ID = `env_${'a'.repeat(32)}`;
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';

// ─── describe: WorkflowStageTypeSchema ───────────────────

describe('Workflow v2 Contracts — WorkflowStageTypeSchema (17 types)', () => {
  const expectedTypes = [
    'PRODUCT_AUTHOR',
    'REQUIREMENTS_REVIEW',
    'ARCHITECTURE_AUTHOR',
    'ARCHITECTURE_REVIEW',
    'PLAN_AUTHOR',
    'PLAN_REVIEW',
    'IMPLEMENT',
    'TEST',
    'CODE_REVIEW',
    'SECURITY_REVIEW',
    'GIT_INTEGRATE',
    'RELEASE_BUILD',
    'DEPLOY',
    'HEALTH_VERIFY',
    'RETROSPECTIVE',
    'EVOLUTION_VALIDATE',
    'RECOVERY',
  ];

  it('接受全部 17 个合法 stage type', () => {
    assert.equal(expectedTypes.length, 17);
    for (const t of expectedTypes) {
      assert.equal(WorkflowStageTypeSchema.safeParse(t).success, true, `should accept ${t}`);
    }
  });

  it('拒绝非法 stage type', () => {
    assert.equal(WorkflowStageTypeSchema.safeParse('INVALID').success, false);
    assert.equal(WorkflowStageTypeSchema.safeParse('').success, false);
  });
});

// ─── describe: StageRunStateSchema ───────────────────────

describe('Workflow v2 Contracts — StageRunStateSchema (10 states)', () => {
  const expectedStates = [
    'READY',
    'ASSIGNED',
    'RUNNING',
    'PRODUCED',
    'PASSED',
    'FAILED',
    'BLOCKED',
    'RETRYING',
    'ROLLED_BACK',
    'QUARANTINED',
  ];

  it('接受全部 10 个合法 state', () => {
    assert.equal(expectedStates.length, 10);
    for (const s of expectedStates) {
      assert.equal(StageRunStateSchema.safeParse(s).success, true, `should accept ${s}`);
    }
  });

  it('拒绝非法 state', () => {
    assert.equal(StageRunStateSchema.safeParse('DONE').success, false);
  });
});

// ─── describe: STAGE_COMPLETION_STATES / STAGE_TERMINAL_STATES ──

describe('Workflow v2 Contracts — State Sets', () => {
  it('STAGE_COMPLETION_STATES 仅包含 PASSED', () => {
    assert.equal(STAGE_COMPLETION_STATES.size, 1);
    assert.equal(STAGE_COMPLETION_STATES.has('PASSED'), true);
    assert.equal(STAGE_COMPLETION_STATES.has('FAILED'), false);
  });

  it('STAGE_TERMINAL_STATES 包含 PASSED/FAILED/ROLLED_BACK/QUARANTINED', () => {
    assert.equal(STAGE_TERMINAL_STATES.size, 4);
    assert.equal(STAGE_TERMINAL_STATES.has('PASSED'), true);
    assert.equal(STAGE_TERMINAL_STATES.has('FAILED'), true);
    assert.equal(STAGE_TERMINAL_STATES.has('ROLLED_BACK'), true);
    assert.equal(STAGE_TERMINAL_STATES.has('QUARANTINED'), true);
    assert.equal(STAGE_TERMINAL_STATES.has('READY'), false);
    assert.equal(STAGE_TERMINAL_STATES.has('RUNNING'), false);
  });
});

// ─── describe: AgentProfileV2Schema ──────────────────────

describe('Workflow v2 Contracts — AgentProfileV2Schema', () => {
  const validProfile = {
    schema: 'awkn-agent-profile/v2',
    profileId: 'prof_test1',
    version: '1.0.0',
    role: 'Engineer',
    specialty: 'IMPLEMENT',
    capabilities: ['code'],
    inputTypes: ['spec'],
    outputTypes: ['code'],
    toolPolicyRef: 'tool-policy-v1',
    independenceGroup: 'group-a',
    providerPolicy: 'ANY_APPROVED',
    maxConcurrentAssignments: 1,
    maxAttempts: 3,
    timeoutMs: 60000,
    memoryPolicy: 'SCOPED_READ_NO_WRITE',
    status: 'ACTIVE',
    sourceHash: SHA256_HEX,
  };

  it('接受合法 profile', () => {
    const parsed = AgentProfileV2Schema.parse(validProfile);
    assert.equal(parsed.role, 'Engineer');
    assert.equal(parsed.specialty, 'IMPLEMENT');
    assert.equal(parsed.status, 'ACTIVE');
  });

  it('拒绝缺失必填字段', () => {
    assert.throws(() => AgentProfileV2Schema.parse({
      ...validProfile,
      role: undefined,
    }));
    assert.throws(() => AgentProfileV2Schema.parse({
      ...validProfile,
      sourceHash: undefined,
    }));
    assert.throws(() => AgentProfileV2Schema.parse({
      ...validProfile,
      specialty: undefined,
    }));
  });

  it('拒绝未知字段 (.strict())', () => {
    assert.throws(() => AgentProfileV2Schema.parse({
      ...validProfile,
      extraField: 'should-fail',
    }));
  });

  it('拒绝非法 sourceHash (非 64 位 hex)', () => {
    assert.throws(() => AgentProfileV2Schema.parse({
      ...validProfile,
      sourceHash: 'short',
    }));
  });
});

// ─── describe: AgentInstanceV2Schema ─────────────────────

describe('Workflow v2 Contracts — AgentInstanceV2Schema', () => {
  const validInstance = {
    schema: 'awkn-agent-instance/v2',
    actorId: 'actor-1',
    profileId: 'prof_test1',
    providerId: 'trae',
    modelId: 'gpt-4',
    sessionId: 'session-1',
    workerProviderId: 'wpv-1',
    providerRunId: 'prun-1',
    workspaceId: 'ws-1',
    permissionSnapshotHash: SHA256_HEX,
    authorizationEnvelopeId: ENV_ID,
    leaseId: 'lease-1',
    leaseExpiresAt: FUTURE,
    createdAt: NOW,
  };

  it('接受合法 instance', () => {
    const parsed = AgentInstanceV2Schema.parse(validInstance);
    assert.equal(parsed.actorId, 'actor-1');
    assert.equal(parsed.providerId, 'trae');
  });

  it('拒绝缺失必填字段', () => {
    assert.throws(() => AgentInstanceV2Schema.parse({
      ...validInstance,
      actorId: undefined,
    }));
    assert.throws(() => AgentInstanceV2Schema.parse({
      ...validInstance,
      sessionId: undefined,
    }));
    assert.throws(() => AgentInstanceV2Schema.parse({
      ...validInstance,
      authorizationEnvelopeId: undefined,
    }));
  });

  it('拒绝非法 authorizationEnvelopeId (非 env_ 前缀)', () => {
    assert.throws(() => AgentInstanceV2Schema.parse({
      ...validInstance,
      authorizationEnvelopeId: 'wrong_abc',
    }));
  });

  it('拒绝未知字段 (.strict())', () => {
    assert.throws(() => AgentInstanceV2Schema.parse({
      ...validInstance,
      extraField: 'no',
    }));
  });
});

// ─── describe: WorkflowStageRunSchema ────────────────────

describe('Workflow v2 Contracts — WorkflowStageRunSchema', () => {
  const validStageRun = {
    schema: 'awkn-workflow-stage-run/v1',
    stageRunId: 'srun_test1',
    missionId: GOAL_ID,
    workItemType: 'workpackage',
    workItemId: 'wp_test1',
    stageType: 'IMPLEMENT',
    state: 'READY',
    requiredProfileId: 'prof_test1',
    frozenInputHash: SHA256_HEX,
    authorizationEnvelopeId: ENV_ID,
    inputReceiptIds: ['rcpt_1'],
    attempt: 0,
    idempotencyKey: 'idem-1',
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('接受合法 stage run', () => {
    const parsed = WorkflowStageRunSchema.parse(validStageRun);
    assert.equal(parsed.stageType, 'IMPLEMENT');
    assert.equal(parsed.state, 'READY');
    assert.equal(parsed.attempt, 0);
  });

  it('拒绝未知字段 (.strict())', () => {
    assert.throws(() => WorkflowStageRunSchema.parse({
      ...validStageRun,
      extraField: 'bad',
    }));
  });

  it('接受可选字段 actorId / frozenSourceSha / outputReceiptId / leaseExpiresAt', () => {
    const parsed = WorkflowStageRunSchema.parse({
      ...validStageRun,
      actorId: 'actor-1',
      frozenSourceSha: 'abc123',
      outputReceiptId: 'rcpt_out',
      leaseExpiresAt: FUTURE,
    });
    assert.equal(parsed.actorId, 'actor-1');
    assert.equal(parsed.frozenSourceSha, 'abc123');
  });
});

// ─── describe: StageGraphSchema ──────────────────────────

describe('Workflow v2 Contracts — StageGraphSchema', () => {
  const validGraph = {
    schema: 'awkn-stage-graph/v1',
    missionId: GOAL_ID,
    nodes: [
      {
        stageType: 'IMPLEMENT',
        workItemType: 'workpackage',
        workItemId: 'wp_1',
        requiredProfileId: 'prof_1',
        optional: false,
      },
      {
        stageType: 'TEST',
        workItemType: 'workpackage',
        workItemId: 'wp_1',
        requiredProfileId: 'prof_2',
        optional: false,
      },
    ],
    edges: [
      { from: 'IMPLEMENT', to: 'TEST', condition: 'on_pass' },
    ],
    createdAt: NOW,
  };

  it('接受合法 graph (含 nodes 和 edges)', () => {
    const parsed = StageGraphSchema.parse(validGraph);
    assert.equal(parsed.nodes.length, 2);
    assert.equal(parsed.edges.length, 1);
    assert.equal(parsed.edges[0].from, 'IMPLEMENT');
    assert.equal(parsed.edges[0].to, 'TEST');
  });

  it('拒绝空 nodes 数组 (min(1))', () => {
    assert.throws(() => StageGraphSchema.parse({
      ...validGraph,
      nodes: [],
    }));
  });

  it('拒绝未知字段 (.strict())', () => {
    assert.throws(() => StageGraphSchema.parse({
      ...validGraph,
      extraField: 'no',
    }));
  });

  it('edge condition 默认值为 on_pass', () => {
    const parsed = StageGraphSchema.parse({
      ...validGraph,
      edges: [{ from: 'IMPLEMENT', to: 'TEST' }],
    });
    assert.equal(parsed.edges[0].condition, 'on_pass');
  });
});

// ─── describe: Worker Schemas ────────────────────────────

describe('Workflow v2 Contracts — Worker Schemas', () => {
  it('WorkerSpawnRequestSchema 验证通过', () => {
    const parsed = WorkerSpawnRequestSchema.parse({
      schema: 'awkn-worker-spawn-request/v1',
      stageRunId: 'srun_1',
      profileId: 'prof_1',
      frozenInputHash: SHA256_HEX,
      workspaceId: 'ws-1',
      toolPolicyRef: 'tool-policy-v1',
      authorizationEnvelopeId: ENV_ID,
      idempotencyKey: 'idem-1',
    });
    assert.equal(parsed.stageRunId, 'srun_1');
  });

  it('WorkerSpawnRequestSchema 拒绝未知字段', () => {
    assert.throws(() => WorkerSpawnRequestSchema.parse({
      schema: 'awkn-worker-spawn-request/v1',
      stageRunId: 'srun_1',
      profileId: 'prof_1',
      frozenInputHash: SHA256_HEX,
      workspaceId: 'ws-1',
      toolPolicyRef: 'tool-policy-v1',
      authorizationEnvelopeId: ENV_ID,
      idempotencyKey: 'idem-1',
      extra: 'no',
    }));
  });

  it('WorkerSpawnReceiptSchema 验证通过', () => {
    const parsed = WorkerSpawnReceiptSchema.parse({
      schema: 'awkn-worker-spawn-receipt/v1',
      providerRunId: 'prun-1',
      providerId: 'wpv-1',
      actorId: 'actor-1',
      sessionId: 'session-1',
      spawnedAt: NOW,
    });
    assert.equal(parsed.providerRunId, 'prun-1');
  });

  it('WorkerSpawnReceiptSchema 拒绝缺失字段', () => {
    assert.throws(() => WorkerSpawnReceiptSchema.parse({
      schema: 'awkn-worker-spawn-receipt/v1',
      providerRunId: 'prun-1',
      // missing providerId
      actorId: 'actor-1',
      sessionId: 'session-1',
      spawnedAt: NOW,
    }));
  });

  it('WorkerResultEnvelopeSchema 验证通过 (SUCCESS)', () => {
    const parsed = WorkerResultEnvelopeSchema.parse({
      schema: 'awkn-worker-result/v1',
      providerRunId: 'prun-1',
      actorId: 'actor-1',
      conclusion: 'SUCCESS',
      outputReceiptId: 'rcpt_1',
      evidenceRefs: ['ev-1'],
      completedAt: NOW,
    });
    assert.equal(parsed.conclusion, 'SUCCESS');
  });

  it('WorkerResultEnvelopeSchema 验证通过 (FAILURE / PARTIAL)', () => {
    for (const conclusion of ['FAILURE', 'PARTIAL'] as const) {
      const parsed = WorkerResultEnvelopeSchema.parse({
        schema: 'awkn-worker-result/v1',
        providerRunId: 'prun-1',
        actorId: 'actor-1',
        conclusion,
        outputReceiptId: 'rcpt_1',
        evidenceRefs: ['ev-1'],
        completedAt: NOW,
      });
      assert.equal(parsed.conclusion, conclusion);
    }
  });

  it('WorkerResultEnvelopeSchema 拒绝非法 conclusion', () => {
    assert.throws(() => WorkerResultEnvelopeSchema.parse({
      schema: 'awkn-worker-result/v1',
      providerRunId: 'prun-1',
      actorId: 'actor-1',
      conclusion: 'INVALID',
      outputReceiptId: 'rcpt_1',
      evidenceRefs: ['ev-1'],
      completedAt: NOW,
    }));
  });
});

// ─── describe: INCOMPATIBLE_PAIRS_V2 ─────────────────────

describe('Workflow v2 Contracts — INCOMPATIBLE_PAIRS_V2', () => {
  it('矩阵包含正好 20 个不相容对', () => {
    assert.equal(INCOMPATIBLE_PAIRS_V2.length, 20);
  });

  it('每个对是 [AgentRole, AgentRole] 元组', () => {
    for (const [a, b] of INCOMPATIBLE_PAIRS_V2) {
      assert.equal(typeof a, 'string');
      assert.equal(typeof b, 'string');
      assert.notEqual(a, b, 'pair elements must differ');
    }
  });
});

// ─── describe: ROLE_TO_DEFAULT_SPECIALTY ─────────────────

describe('Workflow v2 Contracts — ROLE_TO_DEFAULT_SPECIALTY (12 roles)', () => {
  const expectedRoles = [
    'Product',
    'Architect',
    'Planner',
    'Engineer',
    'Test',
    'Review',
    'Git',
    'Release',
    'Deploy',
    'Retrospective',
    'Evolution',
    'Recovery',
  ];

  it('映射全部 12 个角色', () => {
    assert.equal(Object.keys(ROLE_TO_DEFAULT_SPECIALTY).length, 12);
    for (const role of expectedRoles) {
      assert.ok(ROLE_TO_DEFAULT_SPECIALTY[role], `role ${role} should be mapped`);
      assert.equal(
        WorkflowStageTypeSchema.safeParse(ROLE_TO_DEFAULT_SPECIALTY[role]).success,
        true,
        `specialty for ${role} should be valid WorkflowStageType`,
      );
    }
  });

  it('Engineer → IMPLEMENT, Test → TEST, Review → CODE_REVIEW', () => {
    assert.equal(ROLE_TO_DEFAULT_SPECIALTY.Engineer, 'IMPLEMENT');
    assert.equal(ROLE_TO_DEFAULT_SPECIALTY.Test, 'TEST');
    assert.equal(ROLE_TO_DEFAULT_SPECIALTY.Review, 'CODE_REVIEW');
  });
});

// ─── describe: ProfileStatusSchema ───────────────────────

describe('Workflow v2 Contracts — ProfileStatusSchema (6 statuses)', () => {
  const expectedStatuses = ['DRAFT', 'SHADOW', 'CANARY', 'ACTIVE', 'QUARANTINED', 'RETIRED'];

  it('接受全部 6 个合法 status', () => {
    assert.equal(expectedStatuses.length, 6);
    for (const s of expectedStatuses) {
      assert.equal(ProfileStatusSchema.safeParse(s).success, true, `should accept ${s}`);
    }
  });

  it('拒绝非法 status', () => {
    assert.equal(ProfileStatusSchema.safeParse('LIVE').success, false);
    assert.equal(ProfileStatusSchema.safeParse('PUBLISHED').success, false);
  });
});

// ─── describe: ProviderPolicySchema ──────────────────────

describe('Workflow v2 Contracts — ProviderPolicySchema (3 values)', () => {
  const expected = ['ANY_APPROVED', 'DIFFERENT_FROM_UPSTREAM', 'PINNED'];

  it('接受全部 3 个合法值', () => {
    assert.equal(expected.length, 3);
    for (const v of expected) {
      assert.equal(ProviderPolicySchema.safeParse(v).success, true, `should accept ${v}`);
    }
  });

  it('拒绝非法值', () => {
    assert.equal(ProviderPolicySchema.safeParse('STRICT').success, false);
    assert.equal(ProviderPolicySchema.safeParse('RELAXED').success, false);
  });
});

// ─── describe: MemoryPolicySchema ────────────────────────

describe('Workflow v2 Contracts — MemoryPolicySchema (3 values)', () => {
  const expected = ['SCOPED_READ_NO_WRITE', 'CANDIDATE_WRITE_ONLY', 'NO_MEMORY'];

  it('接受全部 3 个合法值', () => {
    assert.equal(expected.length, 3);
    for (const v of expected) {
      assert.equal(MemoryPolicySchema.safeParse(v).success, true, `should accept ${v}`);
    }
  });

  it('拒绝非法值', () => {
    assert.equal(MemoryPolicySchema.safeParse('FULL_ACCESS').success, false);
  });
});
