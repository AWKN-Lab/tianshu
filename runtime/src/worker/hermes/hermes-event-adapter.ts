/**
 * Hermes Event Adapter — Hermes 事件格式 → AWKN 事件格式适配
 *
 * Spiral 5: Hermes 的任务状态、heartbeat、dead-letter 等事件格式
 * 与 AWKN 的 StageRun 状态、WorkerHeartbeatReceipt 不同，需要适配。
 *
 * 适配规则：
 * - Hermes pending/running → AWKN ASSIGNED/RUNNING
 * - Hermes completed → AWKN PASSED
 * - Hermes failed → AWKN FAILED
 * - Hermes reclaimed → AWKN ROLLED_BACK
 * - Hermes dead_lettered → AWKN QUARANTINED
 */

import type { HermesTaskState } from './hermes-cli-port.js';

/**
 * Hermes 事件到 AWKN 的映射记录。
 */
export interface HermesEventMapping {
  readonly providerRunId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly spawnedAt: string;
  readonly request: unknown;
}

/**
 * AWKN StageRun 状态（从 workflow-v2.ts 的 StageRunStateSchema 子集）。
 */
export type AwknStageRunState =
  | 'READY'
  | 'ASSIGNED'
  | 'RUNNING'
  | 'PRODUCED'
  | 'PASSED'
  | 'FAILED'
  | 'BLOCKED'
  | 'RETRYING'
  | 'ROLLED_BACK'
  | 'QUARANTINED';

/**
 * Hermes 事件适配器。
 */
export class HermesEventAdapter {
  /**
   * 将 Hermes 任务状态映射为 AWKN StageRun 状态。
   */
  mapHermesStateToAwknState(hermesState: HermesTaskState): string {
    const mapping: Record<HermesTaskState, AwknStageRunState> = {
      pending: 'ASSIGNED',
      running: 'RUNNING',
      completed: 'PASSED',
      failed: 'FAILED',
      reclaimed: 'ROLLED_BACK',
      dead_lettered: 'QUARANTINED',
    };
    return mapping[hermesState] ?? 'BLOCKED';
  }

  /**
   * 将 Hermes heartbeat alive 状态映射为 AWKN heartbeat status。
   */
  mapHermesHeartbeatToAwknStatus(alive: boolean): 'alive' | 'stale' {
    return alive ? 'alive' : 'stale';
  }

  /**
   * 将 Hermes dead-letter 原因映射为 AWKN QUARANTINED 原因描述。
   */
  mapDeadLetterReasonToQuarantineReason(reason: string): string {
    return `hermes-dead-letter: ${reason}`;
  }

  /**
   * 将 Hermes 结论映射为 AWKN WorkerResultEnvelope conclusion。
   */
  mapHermesConclusionToAwknConclusion(
    hermesConclusion: 'SUCCESS' | 'FAILURE' | 'PARTIAL',
    hasDeadLetter: boolean,
  ): 'SUCCESS' | 'FAILURE' | 'PARTIAL' {
    if (hasDeadLetter) return 'FAILURE';
    return hermesConclusion;
  }
}
