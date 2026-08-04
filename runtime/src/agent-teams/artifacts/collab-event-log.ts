/**
 * AgentTeams — M4.2 collab-event-log（C4 协作事件记录）
 *
 * 影响层级 [M]：全链路协作事件 JSONL 追加日志，可回放。
 * 落点：<team-artifacts>/<mission>/collab-events.jsonl
 * 事件类型：team_started/worker_dispatched/worker_done/worker_failed/
 *           gate_waiting/gate_resumed/intervention/verdict/team_done/team_failed
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactStore } from './artifact-store.js';

export type CollabEventType =
  | 'team_started'
  | 'worker_dispatched'
  | 'worker_done'
  | 'worker_failed'
  | 'gate_waiting'
  | 'gate_resumed'
  | 'intervention'
  | 'verdict'
  | 'brainstorm_phase'
  | 'team_done'
  | 'team_failed';

export interface CollabEvent {
  /** ISO 时间戳 */
  at: string;
  runId: string;
  type: CollabEventType;
  workerId?: string;
  payload?: Record<string, unknown>;
}

export class CollabEventLog {
  constructor(private readonly store: ArtifactStore) {}

  private logPath(mission: string): string {
    const dir = this.store.missionDir(mission);
    mkdirSync(dir, { recursive: true });
    return join(dir, 'collab-events.jsonl');
  }

  /** 追加一条协作事件 */
  append(mission: string, event: Omit<CollabEvent, 'at'>): CollabEvent {
    const full: CollabEvent = { at: new Date().toISOString(), ...event };
    appendFileSync(this.logPath(mission), `${JSON.stringify(full)}\n`, 'utf-8');
    return full;
  }

  /** 回放：按序读取全部事件 */
  replay(mission: string): CollabEvent[] {
    const path = this.logPath(mission);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CollabEvent);
  }
}
