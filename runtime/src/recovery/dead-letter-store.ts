/**
 * Dead Letter Store — 死信队列 SQLite CRUD
 *
 * Spiral 3: 管理 workflow_dead_letter 表（Migration v19 创建）。
 * 提供死信记录的创建、查询、清理功能。
 *
 * 对应表: workflow_dead_letter (Migration v19)
 * 遵循模式: src/worker/profile-registry.ts
 */
import { createAwknId } from '../contracts/ids.js';
import { queryAll, queryOne, queryRun } from '../store/db.js';

// ─── Row 类型 ─────────────────────────────────────────────

export interface DeadLetterRecord {
  readonly id: string;
  readonly stageRunId: string;
  readonly missionId: string;
  readonly reason: string;
  readonly errorText?: string;
  readonly attempts: number;
  readonly payload: unknown;
  readonly createdAt: string;
}

interface DeadLetterRow {
  readonly id: string;
  readonly stage_run_id: string;
  readonly mission_id: string;
  readonly reason: string;
  readonly error_text: string | null;
  readonly attempts: number;
  readonly payload_json: string;
  readonly created_at: string;
}

// ─── 转换函数 ─────────────────────────────────────────────

function rowToRecord(row: DeadLetterRow): DeadLetterRecord {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    stageRunId: row.stage_run_id,
    missionId: row.mission_id,
    reason: row.reason,
    ...(row.error_text !== null ? { errorText: row.error_text } : {}),
    attempts: row.attempts,
    payload,
    createdAt: row.created_at,
  };
}

// ─── CRUD ─────────────────────────────────────────────────

/**
 * 记录一条死信。
 *
 * @returns 创建的死信记录 ID。
 */
export function recordDeadLetter(input: {
  stageRunId: string;
  missionId: string;
  reason: string;
  errorText?: string;
  attempts: number;
  payload: unknown;
}): string {
  const id = createAwknId('deadLetter');
  const now = new Date().toISOString();
  queryRun(
    `INSERT INTO workflow_dead_letter
       (id, stage_run_id, mission_id, reason, error_text, attempts, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.stageRunId,
      input.missionId,
      input.reason,
      input.errorText ?? null,
      input.attempts,
      JSON.stringify(input.payload),
      now,
    ],
  );
  return id;
}

/** 按 missionId 查询所有死信。 */
export function getDeadLettersByMission(missionId: string): DeadLetterRecord[] {
  return queryAll<DeadLetterRow>(
    'SELECT * FROM workflow_dead_letter WHERE mission_id = ? ORDER BY created_at',
    [missionId],
  ).map(rowToRecord);
}

/** 按 ID 查询单条死信。 */
export function getDeadLetter(id: string): DeadLetterRecord | undefined {
  const row = queryOne<DeadLetterRow>(
    'SELECT * FROM workflow_dead_letter WHERE id = ?',
    [id],
  );
  return row ? rowToRecord(row) : undefined;
}

/**
 * 清理死信。
 *
 * @param missionId 可选；提供时仅清理该 mission 的死信，否则清理全部。
 * @returns 删除的行数。
 */
export function purgeDeadLetters(missionId?: string): number {
  if (missionId !== undefined) {
    return queryRun(
      'DELETE FROM workflow_dead_letter WHERE mission_id = ?',
      [missionId],
    );
  }
  return queryRun('DELETE FROM workflow_dead_letter', []);
}
