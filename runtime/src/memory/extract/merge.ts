import { queryRun } from '../../store/db.js';
import { normalizeDirPath, type MemoryPutInput } from '../types.js';
import type { MemoryOp, MemoryOpUpsert } from './types.js';

const MAX_CONTENT_CHARS = 4000;

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeOp(op: MemoryOp): MemoryOp {
  if (op.op === 'delete') return op;
  return {
    ...op,
    scopeId: op.scopeId.trim(),
    key: op.key.trim(),
    content: op.content.trim().slice(0, MAX_CONTENT_CHARS),
    importance: op.importance === undefined ? undefined : clamp(op.importance),
    dirPath: op.dirPath === undefined ? undefined : normalizeDirPath(op.dirPath),
  };
}

export function mergeOps(ops: MemoryOp[]): MemoryOp[] {
  const normalized = ops.map(normalizeOp);
  const merged: MemoryOp[] = [];
  const index = new Map<string, number>();
  for (const op of normalized) {
    if (op.op === 'upsert' && (!op.content || !op.key)) continue;
    const opKey = `${op.scopeId}:${op.key}`;
    const existing = index.get(opKey);
    if (existing !== undefined) {
      merged[existing] = op;
    } else {
      index.set(opKey, merged.length);
      merged.push(op);
    }
  }
  return merged;
}

export function opToPutInput(op: MemoryOpUpsert, projectId: string): MemoryPutInput {
  return {
    type: op.type,
    scopeId: op.scopeId === 'project' ? projectId : op.scopeId,
    key: op.key,
    content: op.content,
    importance: op.importance,
    dirPath: op.dirPath,
  };
}

export function applyDelete(op: { scopeId: string; key: string }, projectId: string): number {
  const scopeId = op.scopeId === 'project' ? projectId : op.scopeId;
  return queryRun(
    `UPDATE memory_entries SET status = 'superseded', updated_at = ?
     WHERE scope_id = ? AND memory_key = ? AND status = 'active'`,
    [new Date().toISOString(), scopeId, op.key],
  );
}
