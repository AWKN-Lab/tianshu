import type Database from 'better-sqlite3';
import type { CaptureMemoryEventInput } from './backend.js';
import { AwknMemoryOsBackend } from './awkn-memory-os-backend.js';
import { getDb } from '../store/db.js';

interface AuthorityOutboxRow {
  id: number;
  event_type: string;
  aggregate_id: string;
  idempotency_key: string;
  payload_json: string;
  status: string;
  attempts: number;
}

interface RunRow {
  id: string;
  goal_id: string | null;
  trace_id: string;
  workflow_name: string;
  status: string;
  output_json: string | null;
}

interface StepRow {
  step_key: string;
  step_type: string;
  status: string;
  attempt: number;
  error_text: string | null;
}

export interface RunOutcomeTransport {
  capture(input: CaptureMemoryEventInput): Promise<Record<string, unknown>>;
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export class MemoryAuthorityOutboxProcessor {
  constructor(
    private readonly db: Database.Database = getDb(),
    private readonly transport: RunOutcomeTransport = new AwknMemoryOsBackend(),
  ) {}

  async flush(limit = 20): Promise<{ delivered: number; failed: number; pending: number }> {
    const rows = this.db.prepare(
      `SELECT * FROM memory_authority_outbox
       WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).all(limit) as AuthorityOutboxRow[];
    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        if (row.event_type !== 'run.terminal') throw new Error(`unsupported authority event: ${row.event_type}`);
        await this.deliverRun(row);
        this.db.prepare(
          `UPDATE memory_authority_outbox
           SET status = 'delivered', attempts = attempts + 1, last_error = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(new Date().toISOString(), row.id);
        delivered++;
      } catch (error) {
        this.db.prepare(
          `UPDATE memory_authority_outbox
           SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
        ).run(error instanceof Error ? error.message : String(error), new Date().toISOString(), row.id);
        failed++;
      }
    }
    const pending = (this.db.prepare(
      `SELECT COUNT(*) AS count FROM memory_authority_outbox WHERE status = 'pending'`,
    ).get() as { count: number }).count;
    return { delivered, failed, pending };
  }

  private async deliverRun(row: AuthorityOutboxRow): Promise<void> {
    const run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(row.aggregate_id) as RunRow | undefined;
    if (!run) throw new Error(`run ${row.aggregate_id} not found`);
    const steps = this.db.prepare(
      `SELECT step_key, step_type, status, attempt, error_text
       FROM steps WHERE run_id = ? ORDER BY started_at ASC, rowid ASC`,
    ).all(run.id) as StepRow[];
    const projectId = process.env.AWKN_PROJECT_ID ?? process.env.npm_package_name ?? 'default-project';
    const sessionId = process.env.AWKN_MEMORY_SESSION_ID ?? run.id;
    await this.transport.capture({
      projectId,
      sessionId,
      traceId: run.trace_id,
      idempotencyKey: row.idempotency_key,
      eventType: 'run.terminal',
      payload: {
        runId: run.id,
        workflowName: run.workflow_name,
        goalId: run.goal_id,
        status: run.status,
        output: parseObject(run.output_json),
        trigger: parseObject(row.payload_json),
        steps: steps.map((step) => ({
          key: step.step_key,
          type: step.step_type,
          status: step.status,
          attempt: step.attempt,
          ...(step.error_text ? { error: step.error_text } : {}),
        })),
      },
    });
  }
}
