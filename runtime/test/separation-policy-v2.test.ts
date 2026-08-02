/**
 * Separation Policy v2 测试 — 20 不相容对 + 10 步判定
 *
 * 纯策略函数测试：不访问 DB。
 *
 * 覆盖:
 *   - INCOMPATIBLE_PAIRS_V2 (20 pairs)
 *   - isIncompatiblePairV2 双向检查
 *   - enforceSeparationV2 10 步判定 (step 1/4/5/6/9/10 失败 + 全通过)
 *   - 全部 20 个不相容对逐一验证 (same actorId → rejected)
 *   - CANARY profile 允许
 *
 * 对应源码: src/governor/separation-policy-v2.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enforceSeparationV2,
  isIncompatiblePairV2,
  type SeparationCheckParams,
} from '../src/governor/separation-policy-v2.js';
import {
  INCOMPATIBLE_PAIRS_V2,
  ROLE_TO_DEFAULT_SPECIALTY,
  type AgentInstanceV2,
  type AgentProfileV2,
  type WorkflowStageType,
} from '../src/contracts/workflow-v2.js';
import type { AgentRole } from '../src/contracts/workflow.js';

// ─── 共享常量 ─────────────────────────────────────────────

const SHA256_HEX = 'a'.repeat(64);
const SHA256_HEX_B = 'b'.repeat(64);
const ENV_ID = `env_${'a'.repeat(32)}`;
const NOW = '2026-08-02T00:00:00.000Z';
const FUTURE = '2026-12-31T23:59:59.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

// ─── 辅助：构造 AgentProfileV2 / AgentInstanceV2 ─────────

function makeProfileV2(
  role: AgentRole,
  specialty: WorkflowStageType,
  overrides?: Partial<AgentProfileV2>,
): AgentProfileV2 {
  return {
    schema: 'awkn-agent-profile/v2',
    profileId: 'prof_test',
    version: '1.0.0',
    role,
    specialty,
    capabilities: [role.toLowerCase()],
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
    ...overrides,
  };
}

function makeInstanceV2(
  profileId: string,
  actorId: string,
  overrides?: Partial<AgentInstanceV2>,
): AgentInstanceV2 {
  return {
    schema: 'awkn-agent-instance/v2',
    actorId,
    profileId,
    providerId: 'trae',
    modelId: 'gpt-4',
    sessionId: 'session-' + actorId,
    workerProviderId: 'wpv-1',
    providerRunId: 'prun-' + actorId,
    workspaceId: 'ws-1',
    permissionSnapshotHash: SHA256_HEX,
    authorizationEnvelopeId: ENV_ID,
    leaseId: 'lease-' + actorId,
    leaseExpiresAt: FUTURE,
    createdAt: NOW,
    ...overrides,
  };
}

function makeParams(
  currentProfile: AgentProfileV2,
  currentInstance: AgentInstanceV2,
  overrides?: Partial<SeparationCheckParams>,
): SeparationCheckParams {
  return {
    currentProfile,
    currentInstance,
    priorInstances: [],
    priorProfiles: [],
    authorizationEnvelopeId: ENV_ID,
    workspacePolicy: 'read_write',
    frozenInputHash: SHA256_HEX,
    stageFrozenHash: SHA256_HEX,
    availableBudget: 1000,
    availableConcurrency: 1,
    ...overrides,
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Separation Policy v2 — INCOMPATIBLE_PAIRS_V2', () => {
  it('矩阵包含正好 20 个不相容对', () => {
    assert.equal(INCOMPATIBLE_PAIRS_V2.length, 20);
  });
});

describe('Separation Policy v2 — isIncompatiblePairV2', () => {
  it('Engineer ↔ Test 双向检查', () => {
    assert.equal(isIncompatiblePairV2('Engineer', 'Test'), true);
    assert.equal(isIncompatiblePairV2('Test', 'Engineer'), true);
  });

  it('Product ↔ Architect 为兼容对 (返回 false)', () => {
    assert.equal(isIncompatiblePairV2('Product', 'Architect'), false);
    assert.equal(isIncompatiblePairV2('Architect', 'Product'), false);
  });

  it('Product ↔ Planner 为不相容对 (双向)', () => {
    assert.equal(isIncompatiblePairV2('Product', 'Planner'), true);
    assert.equal(isIncompatiblePairV2('Planner', 'Product'), true);
  });

  it('Release ↔ Deploy 为不相容对 (双向)', () => {
    assert.equal(isIncompatiblePairV2('Release', 'Deploy'), true);
    assert.equal(isIncompatiblePairV2('Deploy', 'Release'), true);
  });
});

describe('Separation Policy v2 — enforceSeparationV2 10 步判定', () => {
  describe('Step 1: Profile 状态校验', () => {
    it('DRAFT profile 被拒绝', () => {
      const profile = makeProfileV2('Engineer', 'IMPLEMENT', { status: 'DRAFT' });
      const instance = makeInstanceV2(profile.profileId, 'actor-1');
      const result = enforceSeparationV2(makeParams(profile, instance));
      assert.equal(result.allowed, false);
      assert.equal(result.step, 1);
      assert.ok(result.reason?.includes('DRAFT'));
    });

    it('CANARY profile 允许', () => {
      const profile = makeProfileV2('Engineer', 'IMPLEMENT', { status: 'CANARY' });
      const instance = makeInstanceV2(profile.profileId, 'actor-1');
      const result = enforceSeparationV2(makeParams(profile, instance));
      assert.equal(result.allowed, true);
    });

    it('RETIRED profile 被拒绝', () => {
      const profile = makeProfileV2('Engineer', 'IMPLEMENT', { status: 'RETIRED' });
      const instance = makeInstanceV2(profile.profileId, 'actor-1');
      const result = enforceSeparationV2(makeParams(profile, instance));
      assert.equal(result.allowed, false);
      assert.equal(result.step, 1);
    });

    it('SHADOW profile 被拒绝', () => {
      const profile = makeProfileV2('Engineer', 'IMPLEMENT', { status: 'SHADOW' });
      const instance = makeInstanceV2(profile.profileId, 'actor-1');
      const result = enforceSeparationV2(makeParams(profile, instance));
      assert.equal(result.allowed, false);
      assert.equal(result.step, 1);
    });
  });

  describe('Step 4: 不相容对 + 同 actor/session', () => {
    it('同 actorId + Engineer↔Test 不相容对 → 拒绝', () => {
      const priorProfile = makeProfileV2('Engineer', 'IMPLEMENT');
      const priorInstance = makeInstanceV2(priorProfile.profileId, 'actor-same', {
        sessionId: 'session-prior',
      });
      const currentProfile = makeProfileV2('Test', 'TEST');
      const currentInstance = makeInstanceV2(currentProfile.profileId, 'actor-same', {
        sessionId: 'session-current',
      });
      const result = enforceSeparationV2(makeParams(currentProfile, currentInstance, {
        priorInstances: [priorInstance],
        priorProfiles: [priorProfile],
      }));
      assert.equal(result.allowed, false);
      assert.equal(result.step, 4);
      assert.equal(result.conflictingActorId, 'actor-same');
      assert.equal(result.conflictingRole, 'Engineer');
    });
  });

  describe('Step 5: session 共享', () => {
    it('同 sessionId (不同 actorId, 兼容角色) → 拒绝', () => {
      const priorProfile = makeProfileV2('Product', 'PRODUCT_AUTHOR');
      const priorInstance = makeInstanceV2(priorProfile.profileId, 'actor-a', {
        sessionId: 'session-shared',
      });
      const currentProfile = makeProfileV2('Architect', 'ARCHITECTURE_AUTHOR');
      const currentInstance = makeInstanceV2(currentProfile.profileId, 'actor-b', {
        sessionId: 'session-shared',
      });
      // Product ↔ Architect 不是不相容对，step 4 通过
      // 但 sessionId 相同，step 5 拒绝
      const result = enforceSeparationV2(makeParams(currentProfile, currentInstance, {
        priorInstances: [priorInstance],
        priorProfiles: [priorProfile],
      }));
      assert.equal(result.allowed, false);
      assert.equal(result.step, 5);
    });
  });

  describe('Step 6: Provider 多样性', () => {
    it('DIFFERENT_FROM_UPSTREAM + 同 provider → 拒绝', () => {
      const priorProfile = makeProfileV2('Product', 'PRODUCT_AUTHOR');
      const priorInstance = makeInstanceV2(priorProfile.profileId, 'actor-a', {
        sessionId: 'session-a',
        providerId: 'trae',
      });
      const currentProfile = makeProfileV2('Architect', 'ARCHITECTURE_AUTHOR', {
        providerPolicy: 'DIFFERENT_FROM_UPSTREAM',
      });
      const currentInstance = makeInstanceV2(currentProfile.profileId, 'actor-b', {
        sessionId: 'session-b',
        providerId: 'trae', // 同 provider
      });
      // Product ↔ Architect 不相容? No → step 4 通过
      // 不同 session → step 5 通过
      // DIFFERENT_FROM_UPSTREAM + 同 provider → step 6 拒绝
      const result = enforceSeparationV2(makeParams(currentProfile, currentInstance, {
        priorInstances: [priorInstance],
        priorProfiles: [priorProfile],
      }));
      assert.equal(result.allowed, false);
      assert.equal(result.step, 6);
    });

    it('DIFFERENT_FROM_UPSTREAM + 不同 provider → 允许', () => {
      const priorProfile = makeProfileV2('Product', 'PRODUCT_AUTHOR');
      const priorInstance = makeInstanceV2(priorProfile.profileId, 'actor-a', {
        sessionId: 'session-a',
        providerId: 'trae',
      });
      const currentProfile = makeProfileV2('Architect', 'ARCHITECTURE_AUTHOR', {
        providerPolicy: 'DIFFERENT_FROM_UPSTREAM',
      });
      const currentInstance = makeInstanceV2(currentProfile.profileId, 'actor-b', {
        sessionId: 'session-b',
        providerId: 'codex',
      });
      const result = enforceSeparationV2(makeParams(currentProfile, currentInstance, {
        priorInstances: [priorInstance],
        priorProfiles: [priorProfile],
      }));
      assert.equal(result.allowed, true);
    });
  });

  describe('Step 9: Frozen target 一致性', () => {
    it('frozenInputHash ≠ stageFrozenHash → 拒绝', () => {
      const profile = makeProfileV2('Engineer', 'IMPLEMENT');
      const instance = makeInstanceV2(profile.profileId, 'actor-1');
      const result = enforceSeparationV2(makeParams(profile, instance, {
        frozenInputHash: SHA256_HEX,
        stageFrozenHash: SHA256_HEX_B,
      }));
      assert.equal(result.allowed, false);
      assert.equal(result.step, 9);
      assert.ok(result.reason?.includes('does not match'));
    });
  });

  describe('Step 10: Lease / budget / concurrency', () => {
    it('过期 lease → 拒绝', () => {
      const profile = makeProfileV2('Engineer', 'IMPLEMENT');
      const instance = makeInstanceV2(profile.profileId, 'actor-1', {
        leaseExpiresAt: PAST,
      });
      const result = enforceSeparationV2(makeParams(profile, instance));
      assert.equal(result.allowed, false);
      assert.equal(result.step, 10);
      assert.ok(result.reason?.includes('expired'));
    });

    it('budget <= 0 → 拒绝', () => {
      const profile = makeProfileV2('Engineer', 'IMPLEMENT');
      const instance = makeInstanceV2(profile.profileId, 'actor-1');
      const result = enforceSeparationV2(makeParams(profile, instance, {
        availableBudget: 0,
      }));
      assert.equal(result.allowed, false);
      assert.equal(result.step, 10);
    });

    it('concurrency <= 0 → 拒绝', () => {
      const profile = makeProfileV2('Engineer', 'IMPLEMENT');
      const instance = makeInstanceV2(profile.profileId, 'actor-1');
      const result = enforceSeparationV2(makeParams(profile, instance, {
        availableConcurrency: 0,
      }));
      assert.equal(result.allowed, false);
      assert.equal(result.step, 10);
    });
  });

  describe('全步骤通过', () => {
    it('不同 actor / session / provider + ACTIVE profile → 允许', () => {
      const priorProfile = makeProfileV2('Engineer', 'IMPLEMENT');
      const priorInstance = makeInstanceV2(priorProfile.profileId, 'actor-a', {
        sessionId: 'session-a',
        providerId: 'trae',
      });
      const currentProfile = makeProfileV2('Test', 'TEST');
      const currentInstance = makeInstanceV2(currentProfile.profileId, 'actor-b', {
        sessionId: 'session-b',
        providerId: 'codex',
      });
      const result = enforceSeparationV2(makeParams(currentProfile, currentInstance, {
        priorInstances: [priorInstance],
        priorProfiles: [priorProfile],
      }));
      assert.equal(result.allowed, true);
    });

    it('无前置实例 → 允许', () => {
      const profile = makeProfileV2('Engineer', 'IMPLEMENT');
      const instance = makeInstanceV2(profile.profileId, 'actor-1');
      const result = enforceSeparationV2(makeParams(profile, instance));
      assert.equal(result.allowed, true);
    });
  });
});

describe('Separation Policy v2 — 全部 20 个不相容对逐一验证', () => {
  for (const [priorRole, currentRole] of INCOMPATIBLE_PAIRS_V2) {
    it(`${priorRole} → ${currentRole} 同 actorId 被拒绝`, () => {
      const priorSpecialty = ROLE_TO_DEFAULT_SPECIALTY[priorRole];
      const currentSpecialty = ROLE_TO_DEFAULT_SPECIALTY[currentRole];
      const priorProfile = makeProfileV2(priorRole, priorSpecialty);
      const priorInstance = makeInstanceV2(priorProfile.profileId, 'actor-same', {
        sessionId: 'session-prior',
      });
      const currentProfile = makeProfileV2(currentRole, currentSpecialty);
      const currentInstance = makeInstanceV2(currentProfile.profileId, 'actor-same', {
        sessionId: 'session-current',
      });
      const result = enforceSeparationV2(makeParams(currentProfile, currentInstance, {
        priorInstances: [priorInstance],
        priorProfiles: [priorProfile],
      }));
      assert.equal(result.allowed, false, `${priorRole}→${currentRole} should be rejected`);
      assert.equal(result.step, 4);
      assert.equal(result.conflictingRole, priorRole);
    });

    it(`${priorRole} → ${currentRole} 不同 actorId + 不同 session → 允许`, () => {
      const priorSpecialty = ROLE_TO_DEFAULT_SPECIALTY[priorRole];
      const currentSpecialty = ROLE_TO_DEFAULT_SPECIALTY[currentRole];
      const priorProfile = makeProfileV2(priorRole, priorSpecialty);
      const priorInstance = makeInstanceV2(priorProfile.profileId, 'actor-prior', {
        sessionId: 'session-prior',
        providerId: 'trae',
      });
      const currentProfile = makeProfileV2(currentRole, currentSpecialty);
      const currentInstance = makeInstanceV2(currentProfile.profileId, 'actor-current', {
        sessionId: 'session-current',
        providerId: 'codex',
      });
      const result = enforceSeparationV2(makeParams(currentProfile, currentInstance, {
        priorInstances: [priorInstance],
        priorProfiles: [priorProfile],
      }));
      assert.equal(result.allowed, true, `${priorRole}→${currentRole} with different actors should be allowed`);
    });
  }
});
