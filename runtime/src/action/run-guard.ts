/**
 * awkn-local-action-runner — 运行守卫（技能吸收 P0-5）
 *
 * 旧运行取消、同 SHA 去重、并发锁：
 * - 同 workflow + 同 SHA 的旧活跃 run 被新 run 取代（取消）；
 * - 同 workflow 已存在其他活跃 run 时拒绝并发触发（busy）；
 * - 进程内互斥锁防止同一进程重复入口（cron + git hook 同时命中）。
 */

import type { EventStore } from '../workflow/event-store.js';

export type SlotDecision =
  | { readonly decision: 'proceed'; readonly cancelled: readonly string[] }
  | { readonly decision: 'busy'; readonly activeRunId: string };

const ACTIVE_RUN_STATUSES = new Set(['created', 'queued', 'running', 'waiting_tool', 'waiting_approval', 'retrying']);

/** 进程内锁：workflowName -> 进行中的 Promise */
const inFlight = new Map<string, Promise<unknown>>();

export function isActiveRunStatus(status: string): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

/**
 * 全局 pipeline 互斥（跨项目/跨进程，共享 db 锚点）。
 * 同一 db 同一时刻只允许一个 pipeline 真正执行；竞争失败方返回 false（busy）。
 * 锁名默认单锁 `pipeline-global`：互斥目标就是整库串行 pipeline。
 */
export function acquireGlobalPipelineLock(
  store: EventStore,
  owner: string,
  leaseMs?: number,
  lockName = 'pipeline-global',
): boolean {
  return store.acquireGlobalLock(lockName, owner, leaseMs).acquired;
}

export function releaseGlobalPipelineLock(store: EventStore, owner: string, lockName = 'pipeline-global'): void {
  store.releaseGlobalLock(lockName, owner);
}

/**
 * 请求一个 pipeline 运行槽位。
 * 1. 取消同 workflow + 同 SHA 的旧活跃 run（新运行取代旧运行）；
 * 2. 若同 workflow 仍有其他活跃 run → busy，拒绝新运行。
 */
export function acquirePipelineSlot(
  store: EventStore,
  workflowName: string,
  commitSha: string,
): SlotDecision {
  const superseded = store.findActiveRunsByPayload(workflowName, 'commitSha', commitSha);
  for (const run of superseded) {
    store.transitionRun(run.id, 'cancelled', { reason: 'superseded by a newer run on the same commit' });
  }
  const remaining = store.findActiveRuns(workflowName);
  if (remaining.length > 0) {
    return { decision: 'busy', activeRunId: remaining[0]!.id };
  }
  return { decision: 'proceed', cancelled: superseded.map((run) => run.id) };
}

/** 进程内互斥：同 workflow 串行执行；并发调用会排队而非并行 */
export function withPipelineMutex<T>(workflowName: string, task: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(workflowName) ?? Promise.resolve();
  const current = previous.then(task, task);
  const wrapped = current.finally(() => {
    if (inFlight.get(workflowName) === wrapped) inFlight.delete(workflowName);
  });
  inFlight.set(workflowName, wrapped);
  return current;
}
