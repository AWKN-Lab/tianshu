import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from '../core/logger.js';
import { getDb } from '../store/db.js';
import { executeCronAction, type CronActionSnapshot } from './action-executor.js';
import { CronWorkStore, type CronWorkItem } from './work-store.js';

const logger = createLogger('CronWorker');
export type WorkExecutor = (snapshot: CronActionSnapshot, idempotencyKey: string) => Promise<string>;

export class CronWorker {
  readonly workerId: string;
  private readonly store: CronWorkStore;

  constructor(
    private readonly db: Database.Database = getDb(),
    private readonly executor: WorkExecutor = executeCronAction,
    workerId = `worker-${randomUUID()}`,
    private readonly leaseMs = 30_000,
  ) {
    this.workerId = workerId;
    this.store = new CronWorkStore(this.db);
  }

  async pollOnce(): Promise<boolean> {
    const item = this.store.claimNext(this.workerId, this.leaseMs);
    if (!item) return false;
    await this.execute(item);
    return true;
  }

  async processById(id: string): Promise<{ ok: boolean; error?: string }> {
    const item = this.store.claimById(id, this.workerId, this.leaseMs);
    if (!item) {
      const existing = this.store.get(id);
      return existing?.status === 'succeeded'
        ? { ok: true }
        : { ok: false, error: `work ${id} is unavailable (${existing?.status ?? 'missing'})` };
    }
    return this.execute(item);
  }

  private async execute(item: CronWorkItem): Promise<{ ok: boolean; error?: string }> {
    const heartbeat = setInterval(() => {
      if (!this.store.heartbeat(item.id, this.workerId, this.leaseMs)) {
        logger.warn(`Lease heartbeat rejected for ${item.id}`);
      }
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));

    const logId = this.insertLog(item.job_id);
    try {
      const snapshot = JSON.parse(item.payload_json) as CronActionSnapshot;
      const result = await this.executor(snapshot, item.idempotency_key);
      if (!this.store.complete(item.id, this.workerId)) throw new Error(`lost lease while completing ${item.id}`);
      this.finishLog(logId, 'success', result, undefined);
      this.markJobSuccess(item.job_id);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const updated = this.store.fail(item.id, this.workerId, message);
      this.finishLog(logId, updated.status === 'dead' ? 'dead' : 'retry', undefined, message);
      this.markJobAttempt(item.job_id, updated.status === 'dead' ? 'failed' : 'retry');
      return { ok: false, error: message };
    } finally {
      clearInterval(heartbeat);
    }
  }

  private insertLog(jobId: string): number {
    const result = this.db.prepare(
      'INSERT INTO cron_run_log (job_id, status, started_at) VALUES (?, ?, ?)',
    ).run(jobId, 'running', new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  private finishLog(id: number, status: string, result?: string, error?: string): void {
    this.db.prepare(
      'UPDATE cron_run_log SET status = ?, finished_at = ?, result_text = ?, error_text = ? WHERE id = ?',
    ).run(status, new Date().toISOString(), result ?? null, error ?? null, id);
  }

  private markJobSuccess(jobId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE cron_jobs SET last_run_at = ?, run_count = run_count + 1, last_attempt_at = ?, updated_at = ? WHERE id = ?',
    ).run(now, now, now, jobId);
  }

  /** 失败/重试路径也更新 last_attempt_at，并累计 failed_count（dead 记为失败） */
  private markJobAttempt(jobId: string, outcome: 'failed' | 'retry'): void {
    const now = new Date().toISOString();
    if (outcome === 'failed') {
      this.db.prepare(
        'UPDATE cron_jobs SET failed_count = failed_count + 1, last_attempt_at = ?, updated_at = ? WHERE id = ?',
      ).run(now, now, jobId);
    } else {
      this.db.prepare(
        'UPDATE cron_jobs SET last_attempt_at = ?, updated_at = ? WHERE id = ?',
      ).run(now, now, jobId);
    }
  }
}
