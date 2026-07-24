import { randomUUID } from 'node:crypto';
import { queryAll, queryOne, queryRun } from '../store/db.js';

export interface ApprovalRow {
  id: string;
  run_id: string;
  step_id: string | null;
  tool_name: string;
  status: string;
  request_json: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

function requireRows(sql: string, params: unknown[]): ApprovalRow[] {
  return queryAll<ApprovalRow>(sql, params);
}

export class ApprovalStore {
  request(input: { runId: string; stepId?: string; toolName: string; args: Record<string, unknown> }): ApprovalRow {
    const existing = queryOne<ApprovalRow>(
      `SELECT * FROM approvals
       WHERE run_id = ? AND tool_name = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [input.runId, input.toolName],
    );
    if (existing) return existing;

    const id = randomUUID();
    queryRun(
      `INSERT INTO approvals
       (id, run_id, step_id, tool_name, status, request_json, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [id, input.runId, input.stepId ?? null, input.toolName, JSON.stringify(input.args), new Date().toISOString()],
    );
    return this.read(id)!;
  }

  list(status?: 'pending' | 'approved' | 'denied'): ApprovalRow[] {
    return status
      ? requireRows('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC', [status])
      : requireRows('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100', []);
  }

  read(id: string): ApprovalRow | null {
    return queryOne<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', [id]) ?? null;
  }

  decide(id: string, status: 'approved' | 'denied', decidedBy: string): ApprovalRow {
    queryRun(
      'UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?',
      [status, decidedBy, new Date().toISOString(), id],
    );
    const row = this.read(id);
    if (!row) throw new Error(`approval ${id} not found`);
    return row;
  }

  findApproved(runId: string, toolName: string): ApprovalRow | null {
    return queryOne<ApprovalRow>(
      `SELECT * FROM approvals
       WHERE run_id = ? AND tool_name = ? AND status = 'approved'
       ORDER BY decided_at DESC LIMIT 1`,
      [runId, toolName],
    ) ?? null;
  }

  isApproved(id: string, runId: string, toolName: string): boolean {
    const row = this.read(id);
    return row?.status === 'approved' && row.run_id === runId && row.tool_name === toolName;
  }
}

let instance: ApprovalStore | null = null;
export function getApprovalStore(): ApprovalStore {
  if (!instance) instance = new ApprovalStore();
  return instance;
}
