/**
 * Cron 任务管理器 — 封装 cron_jobs 表的 CRUD 操作
 */
import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { queryAll, queryRun } from '../store/db.js';
import type { CronJobRow } from '../store/schema.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('CronJobsManager');
export type CronActionType = 'http' | 'tool' | 'script' | 'evolve';

export interface CreateCronJobInput {
  name: string;
  cronExpr: string;
  actionType: CronActionType;
  actionPayload: Record<string, unknown> | string;
  enabled?: boolean;
  id?: string;
}

export interface CronJob extends CronJobRow {
  parsedPayload: Record<string, unknown>;
}

export function validateCronExpr(expr: string): string | null {
  if (!expr?.trim()) return 'cron 表达式不能为空';
  try {
    CronExpressionParser.parse(expr);
    return null;
  } catch (e) {
    return `无效 cron 表达式: ${String((e as Error).message)}`;
  }
}

export function computeNextRun(cronExpr: string): string | null {
  try {
    return CronExpressionParser.parse(cronExpr).next().toISOString();
  } catch {
    return null;
  }
}

export class CronJobsManager {
  add(input: CreateCronJobInput): CronJob {
    if (!input.name?.trim()) throw new Error('name 不能为空');
    if (!input.cronExpr?.trim()) throw new Error('cronExpr 不能为空');
    if (!input.actionType) throw new Error('actionType 不能为空');

    const validationError = validateCronExpr(input.cronExpr);
    if (validationError) throw new Error(validationError);

    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const payloadStr = typeof input.actionPayload === 'string'
      ? input.actionPayload
      : JSON.stringify(input.actionPayload ?? {});
    const isEnabled = input.enabled !== false;
    const enabled = isEnabled ? 1 : 0;
    const nextRun = isEnabled ? computeNextRun(input.cronExpr) : null;

    queryRun(
      `INSERT INTO cron_jobs
         (id, name, cron_expr, action_type, action_payload, enabled, next_run_at, run_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [id, input.name, input.cronExpr, input.actionType, payloadStr, enabled, nextRun, now, now],
    );

    logger.info(`Added cron job: id=${id}, name=${input.name}, cron=${input.cronExpr}, next=${nextRun}`);
    return this.read(id)!;
  }

  /** created_at 可能在同一毫秒重复，rowid 作为稳定的插入顺序次级键。 */
  list(filter?: { enabledOnly?: boolean }): CronJob[] {
    const sql = filter?.enabledOnly
      ? 'SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY created_at DESC, rowid DESC'
      : 'SELECT * FROM cron_jobs ORDER BY created_at DESC, rowid DESC';
    const rows = queryAll<CronJobRow>(sql);
    return rows.map((row) => ({ ...row, parsedPayload: this.parsePayload(row.action_payload) }));
  }

  read(id: string): CronJob | null {
    const rows = queryAll<CronJobRow>('SELECT * FROM cron_jobs WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return { ...row, parsedPayload: this.parsePayload(row.action_payload) };
  }

  remove(id: string): { deleted: boolean; logsRemoved: number } {
    const existing = this.read(id);
    if (!existing) return { deleted: false, logsRemoved: 0 };
    const logsResult = queryRun('DELETE FROM cron_run_log WHERE job_id = ?', [id]);
    const jobResult = queryRun('DELETE FROM cron_jobs WHERE id = ?', [id]);
    logger.info(`Removed cron job: id=${id}, job deleted=${jobResult}, logs removed=${logsResult}`);
    return { deleted: jobResult > 0, logsRemoved: logsResult };
  }

  setEnabled(id: string, enabled: boolean): CronJob | null {
    const now = new Date().toISOString();
    const value = enabled ? 1 : 0;
    const nextRun = enabled ? computeNextRun(this.read(id)?.cron_expr ?? '') : null;
    queryRun(
      'UPDATE cron_jobs SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      [value, nextRun, now, id],
    );
    return this.read(id);
  }

  private parsePayload(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

let instance: CronJobsManager | null = null;
export function getCronJobsManager(): CronJobsManager {
  if (!instance) instance = new CronJobsManager();
  return instance;
}
