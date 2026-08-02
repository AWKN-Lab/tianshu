import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../store/db.js';
import { isTransientError } from '../core/retry-policy.js';

export type WorkStatus = 'queued' | 'leased' | 'retry' | 'succeeded' | 'dead';

export interface CronWorkItem {
  id: string;
  job_id: string;
  idempotency_key: string;
  status: WorkStatus;
  attempt: number;
  max_attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  payload_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class CronWorkStore {
  constructor(private readonly db: Database.Database = getDb()) {}

  enqueue(input: { jobId: string; idempotencyKey: string; payload: Record<string, unknown>; maxAttempts?: number; availableAt?: string }): CronWorkItem {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(
      `INSERT OR IGNORE INTO cron_work_items
       (id, job_id, idempotency_key, status, attempt, max_attempts, available_at,
        payload_json, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.jobId,
      input.idempotencyKey,
      input.maxAttempts ?? 3,
      input.availableAt ?? now,
      JSON.stringify(input.payload),
      now,
      now,
    );
    const item = this.getByIdempotencyKey(input.idempotencyKey);
    if (!item) throw new Error(`failed to enqueue work ${input.idempotencyKey}`);
    return item;
  }

  get(id: string): CronWorkItem | null {
    return (this.db.prepare('SELECT * FROM cron_work_items WHERE id = ?').get(id) as CronWorkItem | undefined) ?? null;
  }

  getByIdempotencyKey(key: string): CronWorkItem | null {
    return (this.db.prepare('SELECT * FROM cron_work_items WHERE idempotency_key = ?').get(key) as CronWorkItem | undefined) ?? null;
  }

  recoverExpired(now = new Date()): number {
    const iso = now.toISOString();
    return this.db.prepare(
      `UPDATE cron_work_items
       SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL,
           available_at = ?, updated_at = ?, last_error = COALESCE(last_error, 'lease expired')
       WHERE status = 'leased' AND lease_expires_at <= ?`,
    ).run(iso, iso, iso).changes;
  }

  claimNext(workerId: string, leaseMs: number, now = new Date()): CronWorkItem | null {
    const claim = this.db.transaction(() => {
      this.recoverExpired(now);
      const iso = now.toISOString();
      const candidate = this.db.prepare(
        `SELECT * FROM cron_work_items
         WHERE status IN ('queued', 'retry') AND available_at <= ?
         ORDER BY available_at ASC, created_at ASC LIMIT 1`,
      ).get(iso) as CronWorkItem | undefined;
      if (!candidate) return null;
      const leaseExpires = new Date(now.getTime() + leaseMs).toISOString();
      const changes = this.db.prepare(
        `UPDATE cron_work_items
         SET status = 'leased', attempt = attempt + 1, lease_owner = ?,
             lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'retry')`,
      ).run(workerId, leaseExpires, iso, candidate.id).changes;
      return changes === 1 ? this.get(candidate.id) : null;
    });
    return claim();
  }

  claimById(id: string, workerId: string, leaseMs: number, now = new Date()): CronWorkItem | null {
    const claim = this.db.transaction(() => {
      this.recoverExpired(now);
      const iso = now.toISOString();
      const leaseExpires = new Date(now.getTime() + leaseMs).toISOString();
      const changes = this.db.prepare(
        `UPDATE cron_work_items
         SET status = 'leased', attempt = attempt + 1, lease_owner = ?,
             lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'retry') AND available_at <= ?`,
      ).run(workerId, leaseExpires, iso, id, iso).changes;
      return changes === 1 ? this.get(id) : null;
    });
    return claim();
  }

  heartbeat(id: string, workerId: string, leaseMs: number, now = new Date()): boolean {
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    return this.db.prepare(
      `UPDATE cron_work_items SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
    ).run(expires, now.toISOString(), id, workerId).changes === 1;
  }

  complete(id: string, workerId: string): boolean {
    const now = new Date().toISOString();
    return this.db.prepare(
      `UPDATE cron_work_items
       SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
    ).run(now, id, workerId).changes === 1;
  }

  fail(id: string, workerId: string, error: string, baseDelayMs = 1000): CronWorkItem {
    const transition = this.db.transaction(() => {
      const item = this.get(id);
      if (!item || item.status !== 'leased' || item.lease_owner !== workerId) {
        throw new Error(`work ${id} is not leased by ${workerId}`);
      }
      const now = new Date();
      // P1-3 瞬态重试：非瞬态错误（语法/权限/客户端错误）不浪费重试，直接 dead
      if (!isTransientError(error) || item.attempt >= item.max_attempts) {
        this.db.prepare(
          `UPDATE cron_work_items
           SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL,
               last_error = ?, updated_at = ? WHERE id = ?`,
        ).run(error, now.toISOString(), id);
        this.db.prepare(
          `INSERT OR IGNORE INTO cron_dead_letters
           (id, work_item_id, job_id, idempotency_key, payload_json, error_text, attempts, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), id, item.job_id, item.idempotency_key, item.payload_json, error, item.attempt, now.toISOString());
      } else {
        const delay = Math.min(baseDelayMs * (2 ** Math.max(0, item.attempt - 1)), 60 * 60 * 1000);
        this.db.prepare(
          `UPDATE cron_work_items
           SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL,
               available_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        ).run(new Date(now.getTime() + delay).toISOString(), error, now.toISOString(), id);
      }
      return this.get(id)!;
    });
    return transition();
  }

  countDeadLetters(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM cron_dead_letters').get() as { count: number };
    return row.count;
  }
}
