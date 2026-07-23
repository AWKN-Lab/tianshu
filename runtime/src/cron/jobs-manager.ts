/**
 * Cron 任务管理器 — 封装 cron_jobs 表的 CRUD 操作
 *
 * 设计原因：
 * - cli.ts 不应直接写 SQL（违反分层）
 * - CronEngine 内部用 queryAll/queryRun 直接操作，但对外只暴露 start/stop/trigger
 * - 新增 add/list/remove 接口给 CLI 用，独立于 CronEngine 调度
 *
 * 使用：getCronJobsManager().add({...}) / list() / remove(id)
 */

import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { queryAll, queryRun } from '../store/db.js';
import type { CronJobRow } from '../store/schema.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('CronJobsManager');

export type CronActionType = 'http' | 'tool' | 'script' | 'evolve';

export interface CreateCronJobInput {
  /** 任务名（人类可读） */
  name: string;
  /** cron 表达式（5/6 段，标准 cron-parser 格式） */
  cronExpr: string;
  /** action 类型 */
  actionType: CronActionType;
  /** action 载荷（JSON 字符串或对象） */
  actionPayload: Record<string, unknown> | string;
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** 显式指定 ID（不传则生成 UUID） */
  id?: string;
}

export interface CronJob extends CronJobRow {
  /** actionPayload 解析后的对象 */
  parsedPayload: Record<string, unknown>;
}

/**
 * 校验 cron 表达式是否合法
 * @returns null 表示合法，否则返回错误信息
 */
export function validateCronExpr(expr: string): string | null {
  // 空字符串或纯空白 cron-parser 会当合法处理，业务上不允许
  if (!expr?.trim()) return 'cron 表达式不能为空';
  try {
    CronExpressionParser.parse(expr);
    return null;
  } catch (e) {
    return `无效 cron 表达式: ${String((e as Error).message)}`;
  }
}

/** 计算下次执行时间（ISO 字符串），无效表达式返回 null */
export function computeNextRun(cronExpr: string): string | null {
  try {
    return CronExpressionParser.parse(cronExpr).next().toISOString();
  } catch {
    return null;
  }
}

export class CronJobsManager {
  /**
   * 新增 cron 任务
   * @throws 当 cron 表达式无效或参数缺失时抛错
   */
  add(input: CreateCronJobInput): CronJob {
    if (!input.name?.trim()) throw new Error('name 不能为空');
    if (!input.cronExpr?.trim()) throw new Error('cronExpr 不能为空');
    if (!input.actionType) throw new Error('actionType 不能为空');

    const validationError = validateCronExpr(input.cronExpr);
    if (validationError) throw new Error(validationError);

    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const payloadStr =
      typeof input.actionPayload === 'string'
        ? input.actionPayload
        : JSON.stringify(input.actionPayload ?? {});
    const isEnabled = input.enabled !== false;
    const enabled = isEnabled ? 1 : 0;
    // 禁用任务不计算 next_run_at（保持 null），避免调度器误触发
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

  /** 列出所有 cron 任务（按 created_at 倒序） */
  list(filter?: { enabledOnly?: boolean }): CronJob[] {
    const sql = filter?.enabledOnly
      ? 'SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY created_at DESC'
      : 'SELECT * FROM cron_jobs ORDER BY created_at DESC';
    const rows = queryAll<CronJobRow>(sql);
    return rows.map((r) => ({ ...r, parsedPayload: this.parsePayload(r.action_payload) }));
  }

  /** 读取单个任务 */
  read(id: string): CronJob | null {
    const rows = queryAll<CronJobRow>('SELECT * FROM cron_jobs WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    const r = rows[0];
    return { ...r, parsedPayload: this.parsePayload(r.action_payload) };
  }

  /** 删除任务（硬删除，连同相关日志一起删） */
  remove(id: string): { deleted: boolean; logsRemoved: number } {
    const existing = this.read(id);
    if (!existing) {
      return { deleted: false, logsRemoved: 0 };
    }
    // 先删日志（外键约束）
    const logsResult = queryRun('DELETE FROM cron_run_log WHERE job_id = ?', [id]);
    // 再删任务
    const jobResult = queryRun('DELETE FROM cron_jobs WHERE id = ?', [id]);
    logger.info(`Removed cron job: id=${id}, job deleted=${jobResult}, logs removed=${logsResult}`);
    return {
      deleted: jobResult > 0,
      logsRemoved: logsResult,
    };
  }

  /** 启用/禁用任务（不删除） */
  setEnabled(id: string, enabled: boolean): CronJob | null {
    const now = new Date().toISOString();
    const val = enabled ? 1 : 0;
    const nextRun = enabled ? computeNextRun(this.read(id)?.cron_expr ?? '') : null;
    queryRun(
      'UPDATE cron_jobs SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      [val, nextRun, now, id],
    );
    return this.read(id);
  }

  private parsePayload(s: string): Record<string, unknown> {
    try {
      return JSON.parse(s || '{}') as Record<string, unknown>;
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
