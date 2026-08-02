import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AgentRoleSchema,
  AgentProfileSchema,
  AgentInstanceSchema,
  WorkItemStateSchema,
  ComponentSchema,
  ModuleSchema,
  WorkPackageSchema,
  AuthorizationEnvelopeSchema,
  WorkGraphSchema,
  INCOMPATIBLE_ROLES,
  COMPLETION_STATES,
  ABNORMAL_STATES,
} from '../../src/contracts/workflow.js';

const id = (prefix: string, digit: string): string => `${prefix}_${digit.repeat(32)}`;
const now = '2026-08-02T00:00:00.000Z';

function makeProfile(role: string) {
  return AgentProfileSchema.parse({
    schema: 'awkn-agent-profile/v1',
    role,
    capabilities: ['code'],
    permissions: ['read', 'write'],
    inputTypes: ['spec'],
    outputTypes: ['code'],
    independenceLevel: 'STRICT',
    maxConcurrentAssignments: 1,
  });
}

describe('Workflow Contracts — Agent 角色', () => {
  it('接受所有 12 个合法角色', () => {
    const roles = ['Product', 'Architect', 'Planner', 'Engineer', 'Test', 'Review', 'Git', 'Release', 'Deploy', 'Retrospective', 'Evolution', 'Recovery'];
    for (const role of roles) {
      assert.equal(AgentRoleSchema.safeParse(role).success, true);
    }
  });

  it('拒绝非法角色', () => {
    assert.equal(AgentRoleSchema.safeParse('Hacker').success, false);
    assert.equal(AgentRoleSchema.safeParse('').success, false);
  });

  it('AgentProfile 要求至少一个能力', () => {
    assert.throws(() => AgentProfileSchema.parse({
      schema: 'awkn-agent-profile/v1',
      role: 'Engineer',
      capabilities: [],
      permissions: ['read'],
      inputTypes: ['spec'],
      outputTypes: ['code'],
      independenceLevel: 'STRICT',
      maxConcurrentAssignments: 1,
    }));
  });
});

describe('Workflow Contracts — WorkItemState', () => {
  it('接受所有合法状态', () => {
    const states = ['DRAFT', 'READY', 'ASSIGNED', 'RUNNING', 'PRODUCED', 'TESTING', 'REVIEWING', 'ACCEPTED', 'INTEGRATED', 'CLOSED', 'BLOCKED', 'FAILED', 'RETRYING', 'ROLLED_BACK', 'QUARANTINED', 'CANCELLED'];
    for (const state of states) {
      assert.equal(WorkItemStateSchema.safeParse(state).success, true);
    }
  });

  it('COMPLETION_STATES 包含 ACCEPTED/INTEGRATED/CLOSED', () => {
    assert.equal(COMPLETION_STATES.has('ACCEPTED'), true);
    assert.equal(COMPLETION_STATES.has('INTEGRATED'), true);
    assert.equal(COMPLETION_STATES.has('CLOSED'), true);
    assert.equal(COMPLETION_STATES.has('DRAFT'), false);
  });

  it('ABNORMAL_STATES 包含 6 个异常状态', () => {
    assert.equal(ABNORMAL_STATES.size, 6);
    assert.equal(ABNORMAL_STATES.has('BLOCKED'), true);
    assert.equal(ABNORMAL_STATES.has('CANCELLED'), true);
  });
});

describe('Workflow Contracts — 分层模型', () => {
  it('Component schema 验证通过', () => {
    const component = ComponentSchema.parse({
      schema: 'awkn-component/v1',
      id: id('comp', 'a'),
      missionId: id('goal', 'b'),
      name: 'core-engine',
      status: 'DRAFT',
      acceptanceCriteria: ['all tests pass'],
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(component.name, 'core-engine');
  });

  it('Module schema 验证通过', () => {
    const mod = ModuleSchema.parse({
      schema: 'awkn-module/v1',
      id: id('mod', 'a'),
      componentId: id('comp', 'b'),
      name: 'governor',
      status: 'DRAFT',
      boundary: 'state transitions only',
      acceptanceCriteria: ['isolation enforced'],
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(mod.boundary, 'state transitions only');
  });

  it('WorkPackage schema 验证通过', () => {
    const wp = WorkPackageSchema.parse({
      schema: 'awkn-work-package/v1',
      id: id('wp', 'a'),
      moduleId: id('mod', 'b'),
      name: 'implement-governor',
      status: 'DRAFT',
      scope: 'src/governor/',
      acceptanceCriteria: ['governor test pass'],
      dependencies: [],
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(wp.scope, 'src/governor/');
  });

  it('WorkPackage 带依赖验证通过', () => {
    const wp = WorkPackageSchema.parse({
      schema: 'awkn-work-package/v1',
      id: id('wp', 'a'),
      moduleId: id('mod', 'b'),
      name: 'wp-with-deps',
      status: 'DRAFT',
      scope: 'src/test/',
      acceptanceCriteria: ['test pass'],
      dependencies: [id('wp', 'c'), id('wp', 'd')],
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(wp.dependencies.length, 2);
  });
});

describe('Workflow Contracts — Authorization Envelope', () => {
  it('默认所有外部动作为 false', () => {
    const env = AuthorizationEnvelopeSchema.parse({
      schema: 'awkn-authorization-envelope/v1',
      id: id('env', 'a'),
      missionId: id('goal', 'b'),
      userSignature: 'user-signature',
      scopeDirectories: ['/src'],
      scopeTools: [],
      createdAt: now,
    });
    assert.equal(env.allowGitCommit, false);
    assert.equal(env.allowGitPush, false);
    assert.equal(env.allowDeploy, false);
    assert.equal(env.status, 'ACTIVE');
  });

  it('可设置 git commit 授权但不包含 push', () => {
    const env = AuthorizationEnvelopeSchema.parse({
      schema: 'awkn-authorization-envelope/v1',
      id: id('env', 'a'),
      missionId: id('goal', 'b'),
      userSignature: 'sig',
      scopeDirectories: ['/src'],
      scopeTools: ['git'],
      allowGitCommit: true,
      createdAt: now,
    });
    assert.equal(env.allowGitCommit, true);
    assert.equal(env.allowGitPush, false);
  });
});

describe('Workflow Contracts — 职责隔离矩阵', () => {
  it('Engineer 不能兼任 Tester (AC-02/AC-03)', () => {
    const hasConflict = INCOMPATIBLE_ROLES.some(
      ([prior, subsequent]) => prior === 'Engineer' && subsequent === 'Test',
    );
    assert.equal(hasConflict, true);
  });

  it('Engineer 不能兼任 Reviewer', () => {
    const hasConflict = INCOMPATIBLE_ROLES.some(
      ([prior, subsequent]) => prior === 'Engineer' && subsequent === 'Review',
    );
    assert.equal(hasConflict, true);
  });

  it('Engineer 不能兼任 Git Integrator', () => {
    const hasConflict = INCOMPATIBLE_ROLES.some(
      ([prior, subsequent]) => prior === 'Engineer' && subsequent === 'Git',
    );
    assert.equal(hasConflict, true);
  });

  it('Engineer 不能兼任 Deploy', () => {
    const hasConflict = INCOMPATIBLE_ROLES.some(
      ([prior, subsequent]) => prior === 'Engineer' && subsequent === 'Deploy',
    );
    assert.equal(hasConflict, true);
  });

  it('Tester 不能兼任 Reviewer (同一门禁)', () => {
    const hasConflict = INCOMPATIBLE_ROLES.some(
      ([prior, subsequent]) => prior === 'Test' && subsequent === 'Review',
    );
    assert.equal(hasConflict, true);
  });

  it('矩阵覆盖 12 个不相容对', () => {
    assert.equal(INCOMPATIBLE_ROLES.length, 12);
  });
});

describe('Workflow Contracts — WorkGraph', () => {
  it('WorkGraph schema 验证通过', () => {
    const graph = WorkGraphSchema.parse({
      schema: 'awkn-work-graph/v1',
      missionId: id('goal', 'a'),
      nodes: [
        { id: 'wp1', type: 'workpackage', status: 'DRAFT', dependencies: [] },
        { id: 'wp2', type: 'workpackage', status: 'DRAFT', dependencies: ['wp1'] },
      ],
      edges: [{ from: 'wp1', to: 'wp2' }],
    });
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
  });
});
