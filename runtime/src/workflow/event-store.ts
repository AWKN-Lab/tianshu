import { randomUUID } from 'node:crypto';
import { generateTraceId, recordCompletedSpan } from '../observability/trace.js';
import { queryAll, queryOne, queryRun, transaction } from '../store/db.js';

export type RunStatus = 'created' | 'queued' | 'running' | 'waiting_tool' | 'waiting_approval' | 'retrying' | 'succeeded' | 'failed' | 'cancelled' | 'budget_exceeded' | 'policy_blocked';

export interface RunRecord {
  id: string;
  goal_id: string | null;
  trace_id: string;
  workflow_name: string;
  status: RunStatus;
  input_json: string;
  output_json: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

export interface WorkflowEvent {
  id: number;
  run_id: string;
  step_id: string | null;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export class EventStore {
  createRun(input: { goalId?: string; workflowName: string; payload?: Record<string, unknown>; traceId?: string }): RunRecord {
    const id = randomUUID();
    const traceId = input.traceId ?? generateTraceId();
    const now = new Date().toISOString();
    transaction(() => {
      queryRun(
        `INSERT INTO runs (id, goal_id, trace_id, workflow_name, status, input_json, started_at, updated_at)
         VALUES (?, ?, ?, ?, 'created', ?, ?, ?)`,
        [id, input.goalId ?? null, traceId, input.workflowName, JSON.stringify(input.payload ?? {}), now, now],
      );
      this.appendEvent(id, 'run.created', { workflowName: input.workflowName, traceId });
    });
    recordCompletedSpan({
      traceId,
      name: 'workflow.run.created',
      durationMs: 0,
      status: 'ok',
      attributes: { 'workflow.name': input.workflowName, 'run.id': id },
    });
    return this.readRun(id)!;
  }

  readRun(id: string): RunRecord | null {
    return queryOne<RunRecord>('SELECT * FROM runs WHERE id = ?', [id]) ?? null;
  }

  transitionRun(id: string, status: RunStatus, output?: Record<string, unknown>): RunRecord {
    const existing = this.readRun(id);
    if (!existing) throw new Error(`run ${id} not found`);
    const now = new Date().toISOString();
    const terminal = ['succeeded', 'failed', 'cancelled', 'budget_exceeded', 'policy_blocked'].includes(status);
    transaction(() => {
      queryRun(
        `UPDATE runs SET status = ?, output_json = COALESCE(?, output_json),
         finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END, updated_at = ? WHERE id = ?`,
        [status, output ? JSON.stringify(output) : null, terminal ? 1 : 0, now, now, id],
      );
      this.appendEvent(id, `run.${status}`, output ?? {});
    });
    recordCompletedSpan({
      traceId: existing.trace_id,
      name: `workflow.run.${status}`,
      durationMs: 0,
      status: ['failed', 'budget_exceeded', 'policy_blocked'].includes(status) ? 'error' : 'ok',
      attributes: { 'workflow.name': existing.workflow_name, 'run.id': id, 'run.status': status },
    });
    return this.readRun(id)!;
  }

  appendEvent(runId: string, eventType: string, payload: Record<string, unknown> = {}, stepId?: string): number {
    queryRun(
      'INSERT INTO events (run_id, step_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [runId, stepId ?? null, eventType, JSON.stringify(payload), new Date().toISOString()],
    );
    return queryOne<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
  }

  listEvents(runId: string): WorkflowEvent[] {
    return queryAll<WorkflowEvent>('SELECT * FROM events WHERE run_id = ? ORDER BY id ASC', [runId]);
  }
}

let instance: EventStore | null = null;
export function getEventStore(): EventStore {
  if (!instance) instance = new EventStore();
  return instance;
}
