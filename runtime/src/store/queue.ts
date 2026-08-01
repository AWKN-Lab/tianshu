import { randomUUID } from 'node:crypto';
import { queryAll, queryOne, queryRun, transaction } from './db.js';

export interface QueueItem {
  id: string;
  queueName: string;
  idempotencyKey: string;
  status: 'pending' | 'in_progress' | 'done';
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  payloadJson: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  maxAttempts?: number;
  delayMs?: number;
}

export interface ClaimOptions {
  leaseMs?: number;
  batch?: number;
}

export function ensureQueueTable(): void {
  queryRun(
    `CREATE TABLE IF NOT EXISTS queue_work_items (
       id TEXT PRIMARY KEY,
       queue_name TEXT NOT NULL,
       idempotency_key TEXT NOT NULL UNIQUE,
       status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done')) DEFAULT 'pending',
       attempt INTEGER NOT NULL DEFAULT 0,
       max_attempts INTEGER NOT NULL DEFAULT 3,
       available_at TEXT NOT NULL,
       lease_owner TEXT,
       lease_expires_at TEXT,
       payload_json TEXT NOT NULL,
       last_error TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  queryRun(
    `CREATE INDEX IF NOT EXISTS idx_queue_status_available
       ON queue_work_items(status, queue_name, available_at)`,
  );
  queryRun(
    `CREATE INDEX IF NOT EXISTS idx_queue_lease
       ON queue_work_items(status, lease_expires_at)`,
  );
}

const QUEUE_ITEM_COLUMNS = `
  id, queue_name AS queueName, idempotency_key AS idempotencyKey,
  status, attempt, max_attempts AS maxAttempts, available_at AS availableAt,
  lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt,
  payload_json AS payloadJson, last_error AS lastError,
  created_at AS createdAt, updated_at AS updatedAt`;

function selectQueueItem(sql: string, params: unknown[] = []): QueueItem | undefined {
  return queryOne<QueueItem>(`SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_work_items ${sql}`, params);
}

function selectQueueItems(sql: string, params: unknown[] = []): QueueItem[] {
  return queryAll<QueueItem>(`SELECT ${QUEUE_ITEM_COLUMNS} FROM queue_work_items ${sql}`, params);
}

export function enqueue(queueName: string, payload: unknown, options: EnqueueOptions = {}): QueueItem {
  ensureQueueTable();
  const now = new Date();
  const idempotencyKey = options.idempotencyKey ?? `${queueName}:${randomUUID()}`;
  const id = randomUUID();
  transaction(() => {
    const existing = queryOne<{ id: string }>(
      'SELECT id FROM queue_work_items WHERE idempotency_key = ?',
      [idempotencyKey],
    );
    if (existing) return;
    queryRun(
      `INSERT INTO queue_work_items
         (id, queue_name, idempotency_key, status, attempt, max_attempts, available_at,
          payload_json, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
      [
        id,
        queueName,
        idempotencyKey,
        options.maxAttempts ?? 3,
        new Date(now.getTime() + (options.delayMs ?? 0)).toISOString(),
        JSON.stringify(payload),
        now.toISOString(),
        now.toISOString(),
      ],
    );
  });
  return selectQueueItem('WHERE idempotency_key = ?', [idempotencyKey])!;
}

export function claimDue(queueName: string, owner: string, options: ClaimOptions = {}): QueueItem[] {
  ensureQueueTable();
  const now = new Date();
  const leaseMs = options.leaseMs ?? 60_000;
  const batch = options.batch ?? 4;
  return transaction(() => {
    queryRun(
      `UPDATE queue_work_items SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      [now.toISOString(), now.toISOString()],
    );
    const items = selectQueueItems(
      `WHERE queue_name = ? AND status = 'pending' AND available_at <= ?
       ORDER BY available_at, created_at LIMIT ?`,
      [queueName, now.toISOString(), batch],
    );
    for (const item of items) {
      queryRun(
        `UPDATE queue_work_items
         SET status = 'in_progress', lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        [owner, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), item.id],
      );
    }
    return items;
  });
}

export function ack(itemId: string): boolean {
  ensureQueueTable();
  return transaction(() => {
    queryRun(`DELETE FROM queue_work_items WHERE id = ?`, [itemId]);
    return true;
  });
}

export function nack(itemId: string, error: unknown, options: { retryDelayMs?: number } = {}): void {
  ensureQueueTable();
  const now = new Date();
  transaction(() => {
    const item = selectQueueItem('WHERE id = ?', [itemId]);
    if (!item) return;
    const nextAttempt = item.attempt + 1;
    if (nextAttempt >= item.maxAttempts) {
      queryRun(
        `UPDATE queue_work_items
         SET status = 'done', last_error = ?, updated_at = ?
         WHERE id = ?`,
        [String(error).slice(0, 500), now.toISOString(), itemId],
      );
      return;
    }
    const backoff = options.retryDelayMs ?? Math.min(60_000, 1_000 * 2 ** item.attempt);
    queryRun(
      `UPDATE queue_work_items
       SET status = 'pending', attempt = ?, last_error = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
      [nextAttempt, String(error).slice(0, 500), new Date(now.getTime() + backoff).toISOString(), now.toISOString(), itemId],
    );
  });
}

export function queueStats(queueName: string): { pending: number; inProgress: number; done: number } {
  ensureQueueTable();
  const rows = queryAll<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM queue_work_items WHERE queue_name = ? GROUP BY status`,
    [queueName],
  );
  const stats = { pending: 0, inProgress: 0, done: 0 };
  for (const row of rows) {
    if (row.status === 'pending') stats.pending = row.count;
    if (row.status === 'in_progress') stats.inProgress = row.count;
    if (row.status === 'done') stats.done = row.count;
  }
  return stats;
}
