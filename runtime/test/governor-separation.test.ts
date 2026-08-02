/**
 * 职责隔离矩阵测试 — enforceSeparation 全组合验证
 *
 * 对应工程文档 7.1: test/governor.test.ts (separation 部分)
 * 覆盖:
 *   - 全部 12 个不相容对
 *   - 同 actorId 拒绝（伪造多智能体防护）
 *   - 同 sessionId 拒绝（伪造多智能体防护）
 *   - STRICT + 同 provider 拒绝（同模型自审防护）
 *   - RELAXED + 不同 actor + 不同 provider 允许
 *   - 不在矩阵中的角色组合允许
 *   - scope level 不匹配时不拦截
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enforceSeparation, type SeparationScope } from '../src/governor/separation-matrix.js';
import {
  INCOMPATIBLE_ROLES,
  type AgentInstance,
  type AgentRole,
  type ScopeLevel,
} from '../src/contracts/workflow.js';

// ─── 辅助：构造 AgentInstance ─────────────────────────────

function makeAgent(
  role: AgentRole,
  overrides: Partial<AgentInstance> = {},
): AgentInstance {
  return {
    schema: 'awkn-agent-instance/v1',
    instanceId: 'inst_' + Math.random().toString(36).slice(2, 10),
    actorId: overrides.actorId ?? 'actor-' + role.toLowerCase(),
    sessionId: overrides.sessionId ?? 'session-default',
    provider: overrides.provider ?? 'trae',
    profile: {
      schema: 'awkn-agent-profile/v1',
      role,
      capabilities: [role.toLowerCase()],
      independenceLevel: overrides.profile?.independenceLevel ?? 'RELAXED',
    },
    permissionSnapshot: overrides.permissionSnapshot ?? ['workflow:complete'],
    createdAt: overrides.createdAt ?? '2026-08-02T00:00:00.000Z',
    leaseExpiry: overrides.leaseExpiry ?? '2026-08-02T23:59:59.000Z',
  };
}

function makeScope(type: ScopeLevel, id = 'scope-1'): SeparationScope {
  return { type, id };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Governor Separation Matrix — enforceSeparation', () => {
  describe('不相容对覆盖', () => {
    it('矩阵包含 12 个不相容对', () => {
      assert.equal(INCOMPATIBLE_ROLES.length, 12);
    });

    // 遍历全部 12 个不相容对，验证同 actor 被拒绝
    for (const [priorRole, currentRole, scopeLevel] of INCOMPATIBLE_ROLES) {
      it(`${priorRole} → ${currentRole} (${scopeLevel}) 同 actor 被拒绝`, () => {
        const prior = makeAgent(priorRole, { actorId: 'actor-same' });
        const current = makeAgent(currentRole, { actorId: 'actor-same' });
        const result = enforceSeparation([prior], current, makeScope(scopeLevel));
        assert.equal(result.allowed, false);
        assert.ok(result.reason);
        assert.equal(result.conflictingActorId, 'actor-same');
        assert.equal(result.conflictingRole, priorRole);
      });

      it(`${priorRole} → ${currentRole} (${scopeLevel}) 反向同 actor 也被拒绝`, () => {
        // 矩阵是有序对，但分离约束是双向的
        const prior = makeAgent(currentRole, { actorId: 'actor-same' });
        const current = makeAgent(priorRole, { actorId: 'actor-same' });
        const result = enforceSeparation([prior], current, makeScope(scopeLevel));
        assert.equal(result.allowed, false);
      });
    }
  });

  describe('伪造多智能体防护', () => {
    it('同 actorId 不同 sessionId 仍被拒绝', () => {
      const prior = makeAgent('Engineer', { actorId: 'actor-x', sessionId: 'session-a' });
      const current = makeAgent('Test', { actorId: 'actor-x', sessionId: 'session-b' });
      const result = enforceSeparation([prior], current, makeScope('WORKPACKAGE'));
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes('actor-x'));
    });

    it('不同 actorId 但同 sessionId 被拒绝', () => {
      const prior = makeAgent('Engineer', { actorId: 'actor-a', sessionId: 'session-same' });
      const current = makeAgent('Test', { actorId: 'actor-b', sessionId: 'session-same' });
      const result = enforceSeparation([prior], current, makeScope('WORKPACKAGE'));
      assert.equal(result.allowed, false);
    });

    it('完全不同的 actor 和 session 允许（RELAXED 级别）', () => {
      const prior = makeAgent('Engineer', {
        actorId: 'actor-a',
        sessionId: 'session-a',
        provider: 'trae',
      });
      const current = makeAgent('Test', {
        actorId: 'actor-b',
        sessionId: 'session-b',
        provider: 'codex',
      });
      const result = enforceSeparation([prior], current, makeScope('WORKPACKAGE'));
      assert.equal(result.allowed, true);
    });
  });

  describe('STRICT 独立性要求', () => {
    it('STRICT + 同 provider 被拒绝（即使 actor 不同）', () => {
      const prior = makeAgent('Engineer', {
        actorId: 'actor-a',
        sessionId: 'session-a',
        provider: 'trae',
        profile: { schema: 'awkn-agent-profile/v1', role: 'Engineer', capabilities: ['engineer'], independenceLevel: 'STRICT' },
      });
      const current = makeAgent('Test', {
        actorId: 'actor-b',
        sessionId: 'session-b',
        provider: 'trae',
        profile: { schema: 'awkn-agent-profile/v1', role: 'Test', capabilities: ['test'], independenceLevel: 'RELAXED' },
      });
      const result = enforceSeparation([prior], current, makeScope('WORKPACKAGE'));
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes('STRICT'));
      assert.ok(result.reason.includes('provider'));
    });

    it('STRICT + 不同 provider 允许', () => {
      const prior = makeAgent('Engineer', {
        actorId: 'actor-a',
        sessionId: 'session-a',
        provider: 'trae',
        profile: { schema: 'awkn-agent-profile/v1', role: 'Engineer', capabilities: ['engineer'], independenceLevel: 'STRICT' },
      });
      const current = makeAgent('Test', {
        actorId: 'actor-b',
        sessionId: 'session-b',
        provider: 'codex',
        profile: { schema: 'awkn-agent-profile/v1', role: 'Test', capabilities: ['test'], independenceLevel: 'RELAXED' },
      });
      const result = enforceSeparation([prior], current, makeScope('WORKPACKAGE'));
      assert.equal(result.allowed, true);
    });

    it('current 为 STRICT + 同 provider 被拒绝', () => {
      const prior = makeAgent('Engineer', {
        actorId: 'actor-a',
        sessionId: 'session-a',
        provider: 'trae',
        profile: { schema: 'awkn-agent-profile/v1', role: 'Engineer', capabilities: ['engineer'], independenceLevel: 'RELAXED' },
      });
      const current = makeAgent('Test', {
        actorId: 'actor-b',
        sessionId: 'session-b',
        provider: 'trae',
        profile: { schema: 'awkn-agent-profile/v1', role: 'Test', capabilities: ['test'], independenceLevel: 'STRICT' },
      });
      const result = enforceSeparation([prior], current, makeScope('WORKPACKAGE'));
      assert.equal(result.allowed, false);
    });
  });

  describe('scope level 匹配', () => {
    it('不相容对在错误 scope level 下不拦截', () => {
      // Engineer/Test 不相容范围是 WORKPACKAGE，在 COMPONENT scope 下不拦截
      const prior = makeAgent('Engineer', { actorId: 'actor-same' });
      const current = makeAgent('Test', { actorId: 'actor-same' });
      const result = enforceSeparation([prior], current, makeScope('COMPONENT'));
      assert.equal(result.allowed, true);
    });

    it('Mission scope 下 Product/Review 不相容', () => {
      const prior = makeAgent('Product', { actorId: 'actor-same' });
      const current = makeAgent('Review', { actorId: 'actor-same' });
      const result = enforceSeparation([prior], current, makeScope('MISSION'));
      assert.equal(result.allowed, false);
    });

    it('Component scope 下 Architect/Review 不相容', () => {
      const prior = makeAgent('Architect', { actorId: 'actor-same' });
      const current = makeAgent('Review', { actorId: 'actor-same' });
      const result = enforceSeparation([prior], current, makeScope('COMPONENT'));
      assert.equal(result.allowed, false);
    });
  });

  describe('不在矩阵中的角色组合', () => {
    it('Product/Planner 允许同 actor（不在不相容矩阵中）', () => {
      const prior = makeAgent('Product', { actorId: 'actor-same' });
      const current = makeAgent('Planner', { actorId: 'actor-same' });
      const result = enforceSeparation([prior], current, makeScope('MISSION'));
      assert.equal(result.allowed, true);
    });

    it('Release/Deploy 允许同 actor（不在不相容矩阵中）', () => {
      const prior = makeAgent('Release', { actorId: 'actor-same' });
      const current = makeAgent('Deploy', { actorId: 'actor-same' });
      const result = enforceSeparation([prior], current, makeScope('RELEASE_TARGET'));
      assert.equal(result.allowed, true);
    });
  });

  describe('多前置实例', () => {
    it('遍历所有前置实例，任一冲突即拒绝', () => {
      const prior1 = makeAgent('Product', { actorId: 'actor-a', sessionId: 'session-a' });
      const prior2 = makeAgent('Engineer', { actorId: 'actor-b', sessionId: 'session-b' });
      const current = makeAgent('Test', { actorId: 'actor-b', sessionId: 'session-b' });
      // current 与 prior2 冲突（Engineer/Test + 同 session）
      const result = enforceSeparation([prior1, prior2], current, makeScope('WORKPACKAGE'));
      assert.equal(result.allowed, false);
      assert.equal(result.conflictingRole, 'Engineer');
    });

    it('空前置实例列表允许', () => {
      const current = makeAgent('Engineer');
      const result = enforceSeparation([], current, makeScope('WORKPACKAGE'));
      assert.equal(result.allowed, true);
    });
  });
});
