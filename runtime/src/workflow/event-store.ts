import { randomUUID } from 'node:crypto';
import { getMemoryService } from '../memory/service.js';
import { generateTraceId, recordCompletedSpan } from '../observability/trace.js';
import { queryAll, queryOne, queryRun, transaction } from '../store/db.js';

export type RunStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_tool'
  | 'waiting_approval'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded'
  | 'policy_blocked';

export type StepStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_tool'
  | 'waiting_approval'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'policy_blocked';

/** 事件流 schema 版本（P1-2 事件流版本化）：所有写入事件 payload 内嵌此版本 */
export const EVENT_STREAM_SCHEMA = 'awkn-event-stream/v1';
const EVENT_STREAM_SCHEMA_KEY = '_eventSchema';

const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  created: ['queued', 'running', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['waiting_tool', 'waiting_approval', 'retrying', 'succeeded', 'failed', 'cancelled', 'budget_exceeded', 'policy_blocked'],
  waiting_tool: ['running', 'failed', 'cancelled', 'policy_blocked'],
  waiting_approval: ['running', 'failed', 'cancelled', 'policy_blocked'],
  retrying: ['running', 'failed', 'cancelled', 'budget_exceeded'],
  succeeded: [],
  failed: [],
  cancelled: [],
  budget_exceeded: [],
  policy_blocked: [],
};

const STEP_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  created: ['queued', 'running', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['waiting_tool', 'waiting_approval', 'retrying', 'succeeded', 'failed', 'cancelled', 'policy_blocked'],
  waiting_tool: ['running', 'failed', 'cancelled', 'policy_blocked'],
  waiting_approval: ['running', 'failed', 'cancelled', 'policy_blocked'],
  retrying: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  policy_blocked: [],
};

const RUN_STATUSES = new Set<RunStatus>(Object.keys(RUN_TRANSITIONS) as RunStatus[]);
const STEP_STATUSES = new Set<StepStatus>(Object.keys(STEP_TRANSITIONS) as StepStatus[]);

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

export interface StepRecord {
  id: string;
  run_id: string;
  step_key: string;
  step_type: string;
  status: StepStatus;
  attempt: number;
  input_json: string;
  output_json: string | null;
  error_text: string | null;
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

export interface ReplayedRun {
  runId: string;
  status: RunStatus;
  steps: Record<string, { stepId: string; stepKey: string; status: StepStatus; attempt: number }>;
  eventCount: number;
}

function assertTransition<T extends string>(kind: string, current: T, next: T, table: Record<T, T[]>): void {
  if (current === next) return;
  if (!table[current].includes(next)) throw new Error(`invalid ${kind} transition ${current} -> ${next}`);
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
      this.insertEvent(id, 'run.created', { workflowName: input.workflowName, traceId, status: 'created' });
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

  /** 查询某 workflow 下仍处于活跃（未终止）状态的 run */
  findActiveRuns(workflowName: string): RunRecord[] {
    return queryAll<RunRecord>(
      `SELECT * FROM runs
       WHERE workflow_name = ? AND status IN ('created','queued','running','waiting_tool','waiting_approval','retrying')
       ORDER BY started_at`,
      [workflowName],
    );
  }

  /** 查询某 workflow 下活跃且 payload 中指定键等于给定值的 run（用于同 SHA 去重） */
  findActiveRunsByPayload(workflowName: string, payloadKey: string, payloadValue: string): RunRecord[] {
    return queryAll<RunRecord>(
      `SELECT * FROM runs
       WHERE workflow_name = ? AND status IN ('created','queued','running','waiting_tool','waiting_approval','retrying')
         AND json_extract(input_json, ?) = ?
       ORDER BY started_at`,
      [workflowName, `$.${payloadKey}`, payloadValue],
    );
  }

  transitionRun(id: string, status: RunStatus, output?: Record<string, unknown>): RunRecord {
    const existing = this.readRun(id);
    if (!existing) throw new Error(`run ${id} not found`);
    assertTransition('run', existing.status, status, RUN_TRANSITIONS);
    if (existing.status === status) return existing;

    const now = new Date().toISOString();
    const terminal = RUN_TRANSITIONS[status].length === 0;
    transaction(() => {
      queryRun(
        `UPDATE runs SET status = ?, output_json = COALESCE(?, output_json),
         finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END, updated_at = ? WHERE id = ?`,
        [status, output ? JSON.stringify(output) : null, terminal ? 1 : 0, now, now, id],
      );
      this.insertEvent(id, `run.${status}`, { ...(output ?? {}), status });
    });

    recordCompletedSpan({
      traceId: existing.trace_id,
      name: `workflow.run.${status}`,
      durationMs: 0,
      status: ['failed', 'budget_exceeded', 'policy_blocked'].includes(status) ? 'error' : 'ok',
      attributes: { 'workflow.name': existing.workflow_name, 'run.id': id, 'run.status': status },
    });

    if (terminal && process.env.AWKN_DISABLE_MEMORY !== '1') {
      try {
        void getMemoryService().recordRunTrajectory(id).catch(() => {
          // Memory persistence is fail-open for the workflow state transition.
        });
      } catch {
        // Memory persistence is fail-open for the workflow state transition.
      }
    }
    return this.readRun(id)!;
  }

  createStep(input: {
    runId: string;
    stepKey: string;
    stepType: string;
    payload?: Record<string, unknown>;
    attempt?: number;
  }): StepRecord {
    if (!this.readRun(input.runId)) throw new Error(`run ${input.runId} not found`);
    const attempt = input.attempt ?? 1;
    const existing = this.findStep(input.runId, input.stepKey, attempt);
    if (existing) return existing;

    const id = randomUUID();
    const now = new Date().toISOString();
    transaction(() => {
      queryRun(
        `INSERT INTO steps
         (id, run_id, step_key, step_type, status, attempt, input_json, started_at, updated_at)
         VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?)`,
        [id, input.runId, input.stepKey, input.stepType, attempt, JSON.stringify(input.payload ?? {}), now, now],
      );
      this.insertEvent(input.runId, 'step.created', {
        stepId: id,
        stepKey: input.stepKey,
        stepType: input.stepType,
        attempt,
        status: 'created',
      }, id);
    });
    return this.readStep(id)!;
  }

  readStep(id: string): StepRecord | null {
    return queryOne<StepRecord>('SELECT * FROM steps WHERE id = ?', [id]) ?? null;
  }

  findStep(runId: string, stepKey: string, attempt = 1): StepRecord | null {
    return queryOne<StepRecord>(
      'SELECT * FROM steps WHERE run_id = ? AND step_key = ? AND attempt = ?',
      [runId, stepKey, attempt],
    ) ?? null;
  }

  listSteps(runId: string): StepRecord[] {
    return queryAll<StepRecord>('SELECT * FROM steps WHERE run_id = ? ORDER BY started_at ASC, rowid ASC', [runId]);
  }

  transitionStep(id: string, status: StepStatus, output?: Record<string, unknown>, errorText?: string): StepRecord {
    const existing = this.readStep(id);
    if (!existing) throw new Error(`step ${id} not found`);
    assertTransition('step', existing.status, status, STEP_TRANSITIONS);
    if (existing.status === status) return existing;

    const run = this.readRun(existing.run_id);
    const now = new Date().toISOString();
    const terminal = STEP_TRANSITIONS[status].length === 0;
    transaction(() => {
      queryRun(
        `UPDATE steps SET status = ?, output_json = COALESCE(?, output_json),
         error_text = COALESCE(?, error_text),
         finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END, updated_at = ? WHERE id = ?`,
        [status, output ? JSON.stringify(output) : null, errorText ?? null, terminal ? 1 : 0, now, now, id],
      );
      this.insertEvent(existing.run_id, `step.${status}`, {
        stepId: id,
        stepKey: existing.step_key,
        attempt: existing.attempt,
        status,
        ...(output ?? {}),
        ...(errorText ? { error: errorText } : {}),
      }, id);
    });

    if (run) {
      recordCompletedSpan({
        traceId: run.trace_id,
        name: `workflow.step.${status}`,
        durationMs: 0,
        status: ['failed', 'policy_blocked'].includes(status) ? 'error' : 'ok',
        attributes: {
          'run.id': existing.run_id,
          'step.id': id,
          'step.key': existing.step_key,
          'step.type': existing.step_type,
          'step.status': status,
          'step.attempt': existing.attempt,
        },
      });
    }
    return this.readStep(id)!;
  }

  appendEvent(runId: string, eventType: string, payload: Record<string, unknown> = {}, stepId?: string): number {
    const eventId = this.insertEvent(runId, eventType, payload, stepId);
    this.projectDomainEvent(runId, eventType, payload);
    return eventId;
  }

  listEvents(runId: string): WorkflowEvent[] {
    return queryAll<WorkflowEvent>('SELECT * FROM events WHERE run_id = ? ORDER BY id ASC', [runId]);
  }

  replayRun(runId: string): ReplayedRun {
    const events = this.listEvents(runId);
    if (events.length === 0) throw new Error(`run ${runId} has no events`);
    let status: RunStatus = 'created';
    const steps: ReplayedRun['steps'] = {};

    for (const event of events) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(event.payload_json) as Record<string, unknown>; } catch { /* audit keeps malformed payload */ }
      if (event.event_type.startsWith('run.')) {
        const next = event.event_type.slice(4) as RunStatus;
        if (RUN_STATUSES.has(next)) status = next;
      }
      if (event.event_type === 'step.created') {
        const stepId = String(payload.stepId ?? event.step_id ?? '');
        if (stepId) {
          steps[stepId] = {
            stepId,
            stepKey: String(payload.stepKey ?? ''),
            status: 'created',
            attempt: Number(payload.attempt ?? 1),
          };
        }
      } else if (event.event_type.startsWith('step.')) {
        const next = event.event_type.slice(5) as StepStatus;
        const stepId = String(payload.stepId ?? event.step_id ?? '');
        if (stepId && STEP_STATUSES.has(next)) {
          const current = steps[stepId] ?? {
            stepId,
            stepKey: String(payload.stepKey ?? ''),
            status: 'created' as StepStatus,
            attempt: Number(payload.attempt ?? 1),
          };
          steps[stepId] = { ...current, status: next };
        }
      }
    }
    return { runId, status, steps, eventCount: events.length };
  }

  private insertEvent(runId: string, eventType: string, payload: Record<string, unknown>, stepId?: string): number {
    const versionedPayload = { ...payload, [EVENT_STREAM_SCHEMA_KEY]: EVENT_STREAM_SCHEMA };
    queryRun(
      'INSERT INTO events (run_id, step_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [runId, stepId ?? null, eventType, JSON.stringify(versionedPayload), new Date().toISOString()],
    );
    return queryOne<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0;
  }

  /** 校验事件 payload 的 schema 版本；缺版本或版本不兼容返回 false */
  static eventSchemaVersion(payload: Record<string, unknown>): string | null {
    const version = payload[EVENT_STREAM_SCHEMA_KEY];
    return typeof version === 'string' && version.length > 0 ? version : null;
  }

  private projectDomainEvent(runId: string, eventType: string, payload: Record<string, unknown>): void {
    const cycle = Number(payload.cycle);
    if (!Number.isInteger(cycle) || cycle <= 0) return;
    const stepKey = `l2-cycle:${cycle}`;

    if (eventType === 'l2.cycle.started') {
      const step = this.createStep({ runId, stepKey, stepType: 'l2_cycle', payload: { cycle }, attempt: 1 });
      if (['created', 'queued', 'retrying'].includes(step.status)) this.transitionStep(step.id, 'running');
      return;
    }

    if (eventType === 'l2.cycle.evaluated') {
      const step = this.findStep(runId, stepKey, 1)
        ?? this.createStep({ runId, stepKey, stepType: 'l2_cycle', payload: { cycle }, attempt: 1 });
      if (step.status === 'created') this.transitionStep(step.id, 'running');
      const current = this.readStep(step.id)!;
      if (!['running', 'retrying', 'waiting_tool', 'waiting_approval'].includes(current.status)) return;
      const results = Array.isArray(payload.results) ? payload.results : [];
      const passed = results.length > 0 && results.every((result) =>
        Boolean(result && typeof result === 'object' && (result as { passed?: unknown }).passed === true));
      this.transitionStep(
        current.id,
        passed ? 'succeeded' : 'failed',
        payload,
        passed ? undefined : 'one or more L2 gates failed',
      );
    }
  }
}

let instance: EventStore | null = null;
export function getEventStore(): EventStore {
  if (!instance) instance = new EventStore();
  return instance;
}
