/**
 * StageRun → Worker 分配服务
 *
 * Spiral 2: 基于 Profile + Provider 匹配 StageRun，经 Separation Policy v2 校验后
 * 调用 WorkerProviderPort.spawn()。匹配到第一个可行分配即返回。
 *
 * 匹配顺序：
 *   1. requiredProfileId 优先（精确匹配指定 Profile 的最新版本，需 ACTIVE/CANARY
 *      且 specialty 与 stageType 一致）；否则按 stageType 作为 specialty 收集活跃 Profile。
 *   2. 对每个 Profile，查询支持该 specialty 的 Provider（findProvidersForSpecialty）。
 *   3. 对每个 Provider，构造 AgentInstanceV2 并执行 enforceSeparationV2。
 *   4. 校验通过后调用 provider.spawn()，返回首个成功分配。
 *
 * 对应契约: contracts/workflow-v2.ts
 */
import type {
  AgentInstanceV2,
  AgentProfileV2,
  WorkflowStageRun,
  WorkerSpawnReceipt,
  WorkerSpawnRequest,
} from '../contracts/workflow-v2.js';
import { getProfile, getProfilesBySpecialty } from './profile-registry.js';
import { findProvidersForSpecialty } from './provider-registry.js';
import { enforceSeparationV2 } from '../governor/separation-policy-v2.js';
import { createAwknId } from '../contracts/ids.js';
import { stableHash } from '../contracts/canonical-json.js';

export interface AssignmentResult {
  assigned: boolean;
  reason?: string;
  profile?: AgentProfileV2;
  providerId?: string;
  spawnReceipt?: WorkerSpawnReceipt;
}

// 默认租约时长：15 分钟。
const DEFAULT_LEASE_DURATION_MS = 15 * 60 * 1000;
// 分离判定 step 10 要求 availableBudget / availableConcurrency > 0。
const DEFAULT_AVAILABLE_BUDGET = 1;
const DEFAULT_AVAILABLE_CONCURRENCY = 1;
const DEFAULT_MODEL_ID = 'local-default';
const DEFAULT_WORKSPACE_ID = 'default-workspace';

const ACTIVE_PROFILE_STATUSES = new Set<AgentProfileV2['status']>(['ACTIVE', 'CANARY']);

/**
 * 收集匹配 stageRun 的候选 Profile。
 * requiredProfileId 优先；否则按 stageType（即 specialty）收集所有活跃 Profile。
 */
function collectCandidateProfiles(stageRun: WorkflowStageRun): AgentProfileV2[] {
  const required = getProfile(stageRun.requiredProfileId);
  if (
    required &&
    ACTIVE_PROFILE_STATUSES.has(required.status) &&
    required.specialty === stageRun.stageType
  ) {
    return [required];
  }
  return getProfilesBySpecialty(stageRun.stageType).filter((profile) =>
    ACTIVE_PROFILE_STATUSES.has(profile.status),
  );
}

/**
 * 构造用于分离判定的 AgentInstanceV2。
 *
 * 注意：actorId / sessionId / providerRunId 为预生成占位值（spawn 前无法从 Provider
 * 取得真实值）。Spiral 2 为 stub 模式，分离判定中 actor/session 冲突检查（step 4/5）
 * 因此对新鲜实例恒为通过；provider 多样性（step 6）等其它步骤仍有效。
 * enforce 模式下将由 Provider 在 spawn 前确定真实 actorId。
 */
function buildInstance(
  profile: AgentProfileV2,
  stageRun: WorkflowStageRun,
  providerId: string,
  leaseExpiresAt: string,
): AgentInstanceV2 {
  const permissionSnapshotHash = stableHash('awkn-permission-snapshot/v1', {
    toolPolicyRef: profile.toolPolicyRef,
    authorizationEnvelopeId: stageRun.authorizationEnvelopeId,
  });
  return {
    schema: 'awkn-agent-instance/v2',
    actorId: createAwknId('run'),
    profileId: profile.profileId,
    providerId,
    modelId: DEFAULT_MODEL_ID,
    sessionId: createAwknId('cycle'),
    workerProviderId: providerId,
    providerRunId: createAwknId('run'),
    workspaceId: DEFAULT_WORKSPACE_ID,
    permissionSnapshotHash,
    authorizationEnvelopeId: stageRun.authorizationEnvelopeId,
    leaseId: createAwknId('lease'),
    leaseExpiresAt,
    createdAt: new Date().toISOString(),
  };
}

function buildSpawnRequest(
  profile: AgentProfileV2,
  stageRun: WorkflowStageRun,
): WorkerSpawnRequest {
  return {
    schema: 'awkn-worker-spawn-request/v1',
    stageRunId: stageRun.stageRunId,
    profileId: profile.profileId,
    frozenInputHash: stageRun.frozenInputHash,
    workspaceId: DEFAULT_WORKSPACE_ID,
    toolPolicyRef: profile.toolPolicyRef,
    authorizationEnvelopeId: stageRun.authorizationEnvelopeId,
    idempotencyKey: stageRun.idempotencyKey,
  };
}

/**
 * 尝试为 StageRun 分配 Worker。返回首个成功分配；全部不满足时返回
 * { assigned: false, reason }。
 */
export async function attemptAssignment(
  stageRun: WorkflowStageRun,
  priorInstances: AgentInstanceV2[],
  priorProfiles: AgentProfileV2[],
  authorizationEnvelopeId: string,
): Promise<AssignmentResult> {
  const candidates = collectCandidateProfiles(stageRun);
  if (candidates.length === 0) {
    return {
      assigned: false,
      reason: `no active profile matching stageType ${stageRun.stageType} (requiredProfileId=${stageRun.requiredProfileId})`,
    };
  }

  const leaseExpiresAt = new Date(Date.now() + DEFAULT_LEASE_DURATION_MS).toISOString();
  let lastReason = 'no provider/separation combination satisfied for stageRun';

  for (const profile of candidates) {
    const providers = await findProvidersForSpecialty(profile.specialty);
    if (providers.length === 0) {
      lastReason = `no provider supports specialty ${profile.specialty}`;
      continue;
    }

    for (const provider of providers) {
      const instance = buildInstance(profile, stageRun, provider.providerId, leaseExpiresAt);
      const separation = enforceSeparationV2({
        currentProfile: profile,
        currentInstance: instance,
        priorInstances,
        priorProfiles,
        authorizationEnvelopeId,
        workspacePolicy: 'read_write',
        frozenInputHash: stageRun.frozenInputHash,
        stageFrozenHash: stageRun.frozenInputHash,
        availableBudget: DEFAULT_AVAILABLE_BUDGET,
        availableConcurrency: DEFAULT_AVAILABLE_CONCURRENCY,
      });
      if (!separation.allowed) {
        lastReason = `separation denied: ${separation.reason ?? 'unknown'} (step ${separation.step ?? '?'})`;
        continue;
      }

      try {
        const spawnReceipt = await provider.spawn(buildSpawnRequest(profile, stageRun));
        return {
          assigned: true,
          profile,
          providerId: provider.providerId,
          spawnReceipt,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastReason = `provider ${provider.providerId} spawn failed: ${message}`;
        // 继续尝试下一个 Provider。
      }
    }
  }

  return { assigned: false, reason: lastReason };
}
