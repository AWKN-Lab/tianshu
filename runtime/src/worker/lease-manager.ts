/**
 * Lease 管理 — 心跳续约与过期回收
 *
 * Spiral 2: 租约状态权威存于进程内 Map；lease_id 与 lease_expires_at 同步写入
 * workflow_agent_instance 表（Migration v19）中匹配 actor_id 的行，供跨模块可见。
 *
 * 设计说明：workflow_agent_instance 表无 stage_run_id 列，且 authorization_envelope_id
 * 存在外键约束 + 多个 NOT NULL 列，无法独立 INSERT（需由 assignment 流程先持久化实例行）。
 * 因此：
 *   - stageRunId 与 lease state（active/expired/reclaimed/released）由内存索引维护；
 *   - createLease / renewLease 对已存在的实例行做 UPDATE 镜像（best-effort）；
 *   - isLeaseValid 额外读取 DB 的 lease_expires_at 做一致性校验。
 *
 * 对应契约: contracts/workflow-v2.ts — AgentInstanceV2.leaseId / leaseExpiresAt
 */
import { queryOne, queryRun } from '../store/db.js';
import { createAwknId } from '../contracts/ids.js';

export interface LeaseInfo {
  leaseId: string;
  stageRunId: string;
  actorId: string;
  providerRunId: string;
  expiresAt: string;
  state: 'active' | 'expired' | 'reclaimed' | 'released';
}

// 权威租约索引：leaseId → LeaseInfo（含 state 与 stageRunId）。
const leases = new Map<string, LeaseInfo>();
// stageRunId → 当前 leaseId，便于 getActiveLeaseByStageRun。
const stageRunIndex = new Map<string, string>();

function computeState(info: LeaseInfo): LeaseInfo['state'] {
  if (info.state === 'reclaimed' || info.state === 'released') return info.state;
  if (new Date(info.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

/** 将 lease_id / lease_expires_at 镜像到 workflow_agent_instance（best-effort）。 */
function mirrorToInstance(actorId: string, leaseId: string, expiresAt: string): void {
  queryRun(
    'UPDATE workflow_agent_instance SET lease_id = ?, lease_expires_at = ? WHERE actor_id = ?',
    [leaseId, expiresAt, actorId],
  );
}

/**
 * 为 (stageRunId, actorId) 创建租约。lease_id 与 lease_expires_at 同步写入
 * workflow_agent_instance 中匹配 actor_id 的行（若存在）。
 */
export function createLease(
  stageRunId: string,
  actorId: string,
  providerRunId: string,
  durationMs: number,
): LeaseInfo {
  const leaseId = createAwknId('lease');
  const expiresAt = new Date(Date.now() + durationMs).toISOString();
  const info: LeaseInfo = {
    leaseId,
    stageRunId,
    actorId,
    providerRunId,
    expiresAt,
    state: 'active',
  };
  leases.set(leaseId, info);
  stageRunIndex.set(stageRunId, leaseId);
  mirrorToInstance(actorId, leaseId, expiresAt);
  return info;
}

export function getLease(leaseId: string): LeaseInfo | undefined {
  const info = leases.get(leaseId);
  if (!info) return undefined;
  return { ...info, state: computeState(info) };
}

export function getActiveLeaseByStageRun(stageRunId: string): LeaseInfo | undefined {
  const leaseId = stageRunIndex.get(stageRunId);
  if (!leaseId) return undefined;
  const info = leases.get(leaseId);
  if (!info) return undefined;
  const state = computeState(info);
  if (state !== 'active') return undefined;
  return { ...info, state };
}

export function renewLease(leaseId: string, durationMs: number): LeaseInfo | undefined {
  const info = leases.get(leaseId);
  if (!info) return undefined;
  if (info.state === 'released' || info.state === 'reclaimed') return undefined;
  const expiresAt = new Date(Date.now() + durationMs).toISOString();
  const renewed: LeaseInfo = { ...info, expiresAt, state: 'active' };
  leases.set(leaseId, renewed);
  mirrorToInstance(info.actorId, leaseId, expiresAt);
  return renewed;
}

export function releaseLease(leaseId: string): boolean {
  const info = leases.get(leaseId);
  if (!info) return false;
  if (info.state === 'released') return false;
  leases.set(leaseId, { ...info, state: 'released' });
  stageRunIndex.delete(info.stageRunId);
  return true;
}

/** 回收所有已过期且仍标记为 active 的租约，返回被回收的 leaseId 列表。 */
export function reclaimExpiredLeases(): string[] {
  const reclaimed: string[] = [];
  const now = Date.now();
  for (const [leaseId, info] of leases) {
    if (info.state !== 'active') continue;
    if (new Date(info.expiresAt).getTime() <= now) {
      leases.set(leaseId, { ...info, state: 'reclaimed' });
      stageRunIndex.delete(info.stageRunId);
      reclaimed.push(leaseId);
    }
  }
  return reclaimed;
}

/**
 * 判断租约是否有效：内存中状态为 active 且未过期；若 DB 中存在镜像行，
 * 额外校验 DB 的 lease_expires_at 仍未过期（DB 一致性校验）。
 */
export function isLeaseValid(leaseId: string): boolean {
  const info = leases.get(leaseId);
  if (!info) return false;
  if (computeState(info) !== 'active') return false;
  const row = queryOne<{ lease_expires_at: string }>(
    'SELECT lease_expires_at FROM workflow_agent_instance WHERE lease_id = ?',
    [leaseId],
  );
  if (row && new Date(row.lease_expires_at).getTime() <= Date.now()) {
    return false;
  }
  return true;
}
