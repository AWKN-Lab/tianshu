/**
 * LoopStateManager — L1 循环检查点持久化（断点恢复）
 *
 * 用途：AgentLoop.runL1 每轮后保存 checkpoint，进程崩溃后可 resumeL1 从断点继续
 *
 * 存储：loop_state 表的 react_state 字段存复合 JSON 快照（含 messages + reactState + turn + tokens）
 *   — 避免改 schema（loop_state 是 dead schema，从未被使用，可直接复用 react_state 字段存复合数据）
 *
 * 生命周期：
 *   saveCheckpoint → 每轮后调用（goalId 存在时）
 *   loadCheckpoint → resumeL1 时调用
 *   clearCheckpoint → 循环正常结束后调用（标记完成，不再 resume）
 */

import { queryOne, queryRun, queryAll } from '../store/db.js';
import { createLogger } from './logger.js';
import type { ReActState } from './react-loop.js';
import type { ChatMessage } from '../llm/types.js';

const logger = createLogger('LoopStateManager');

/** L1 循环快照（可完整恢复 L1 状态的最小数据集） */
export interface LoopSnapshot {
  /** ReAct 状态（turn/step/observations/reflections/...） */
  reactState: ReActState;
  /** 对话历史（恢复 LLM 上下文必需） */
  messages: ChatMessage[];
  /** 当前轮数 */
  turn: number;
  /** 累计 token */
  totalTokens: number;
  /** 最终文本（循环结束时） */
  finalText: string;
  /** 是否已终止 */
  terminated: boolean;
  terminationReason?: string;
}

/** loop_state 表行（持久化形态） */
interface LoopStateRow {
  id: string;
  goal_id: string | null;
  turn: number;
  step: string;
  react_state: string; // JSON: LoopSnapshot
  observations: string;
  reflections: string;
  total_observations: number;
  total_errors: number;
  consecutive_errors: number;
  created_at: string;
  updated_at: string;
}

export class LoopStateManager {
  /**
   * 保存（或更新）checkpoint
   * @param id checkpoint ID（用 reactState.conversationId）
   * @param goalId 关联的 goal ID（L2 上下文，可为 null）
   * @param snapshot 循环快照
   */
  saveCheckpoint(id: string, goalId: string | null, snapshot: LoopSnapshot): void {
    const now = new Date().toISOString();
    const snapshotJson = JSON.stringify(snapshot);
    const rs = snapshot.reactState;

    // upsert：存在则更新，不存在则插入
    const existing = queryOne<LoopStateRow>(
      'SELECT id FROM loop_state WHERE id = ?',
      [id],
    );

    if (existing) {
      queryRun(
        `UPDATE loop_state
         SET goal_id = ?, turn = ?, step = ?, react_state = ?,
             observations = ?, reflections = ?,
             total_observations = ?, total_errors = ?, consecutive_errors = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          goalId,
          snapshot.turn,
          rs.step,
          snapshotJson,
          JSON.stringify(rs.observations),
          JSON.stringify(rs.reflections),
          rs.totalObservations,
          rs.totalErrors,
          rs.consecutiveErrors,
          now,
          id,
        ],
      );
    } else {
      queryRun(
        `INSERT INTO loop_state
         (id, goal_id, turn, step, react_state, observations, reflections,
          total_observations, total_errors, consecutive_errors, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          goalId,
          snapshot.turn,
          rs.step,
          snapshotJson,
          JSON.stringify(rs.observations),
          JSON.stringify(rs.reflections),
          rs.totalObservations,
          rs.totalErrors,
          rs.consecutiveErrors,
          now,
          now,
        ],
      );
    }
    logger.debug(`Checkpoint saved: id=${id}, turn=${snapshot.turn}, goal=${goalId ?? 'none'}`);
  }

  /**
   * 加载 checkpoint
   * @returns 快照，不存在返回 null
   */
  loadCheckpoint(id: string): LoopSnapshot | null {
    const row = queryOne<LoopStateRow>(
      'SELECT * FROM loop_state WHERE id = ?',
      [id],
    );
    if (!row) return null;

    try {
      const snapshot = JSON.parse(row.react_state) as LoopSnapshot;
      logger.debug(`Checkpoint loaded: id=${id}, turn=${snapshot.turn}`);
      return snapshot;
    } catch (err) {
      logger.error(`Failed to parse checkpoint ${id}: ${String(err)}`);
      return null;
    }
  }

  /**
   * 加载某 goal 的最新未终止 checkpoint（用于 resume）
   *
   * 修复（2026-07-23）：原版用 LIMIT 1 只查最新一行，若该行 terminated 就直接返回 null，
   *   导致同 goal 的多个 checkpoint 中只要最新一个被 clearCheckpoint 标记 terminated，
   *   loadLatestForGoal 就找不到更早的未终止 checkpoint → L2 无法 resume。
   * 现改为查所有行按 updated_at DESC 排序，迭代返回第一个未 terminated 的。
   *
   * @returns 最新未终止 checkpoint 快照 + id，无则 null
   */
  loadLatestForGoal(goalId: string): { id: string; snapshot: LoopSnapshot } | null {
    const rows = queryAll<LoopStateRow>(
      'SELECT * FROM loop_state WHERE goal_id = ? ORDER BY updated_at DESC',
      [goalId],
    );
    if (rows.length === 0) return null;

    for (const row of rows) {
      try {
        const snapshot = JSON.parse(row.react_state) as LoopSnapshot;
        // 已终止的 checkpoint 不需要 resume（循环已结束），跳过找下一个
        if (snapshot.terminated) {
          logger.debug(`Checkpoint ${row.id} is terminated, skip`);
          continue;
        }
        return { id: row.id, snapshot };
      } catch (err) {
        logger.error(`Failed to parse checkpoint ${row.id} for goal ${goalId}: ${String(err)}`);
        // 损坏的行跳过，继续找下一个
      }
    }
    return null;
  }

  /**
   * 清除 checkpoint（循环正常结束后调用）
   * 保留记录用于审计，但标记 terminated（不再 resume）
   */
  clearCheckpoint(id: string, terminated: boolean, reason?: string): void {
    // 加载现有快照，标记 terminated 后回写
    const row = queryOne<LoopStateRow>(
      'SELECT react_state FROM loop_state WHERE id = ?',
      [id],
    );
    if (!row) return;

    try {
      const snapshot = JSON.parse(row.react_state) as LoopSnapshot;
      snapshot.terminated = terminated;
      snapshot.terminationReason = reason;
      queryRun(
        'UPDATE loop_state SET react_state = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(snapshot), new Date().toISOString(), id],
      );
      logger.debug(`Checkpoint cleared: id=${id}, terminated=${terminated}`);
    } catch {
      // 解析失败说明数据已损坏，直接删除
      queryRun('DELETE FROM loop_state WHERE id = ?', [id]);
    }
  }

  /** 列出所有未完成的 checkpoint（可 resume 的） */
  listResumable(goalId?: string): Array<{ id: string; goalId: string | null; turn: number; updatedAt: string }> {
    const rows = goalId
      ? queryAll<LoopStateRow>(
          'SELECT * FROM loop_state WHERE goal_id = ? ORDER BY updated_at DESC',
          [goalId],
        )
      : queryAll<LoopStateRow>(
          'SELECT * FROM loop_state ORDER BY updated_at DESC LIMIT 20',
          [],
        );

    const resumable: Array<{ id: string; goalId: string | null; turn: number; updatedAt: string }> = [];
    for (const row of rows) {
      try {
        const snapshot = JSON.parse(row.react_state) as LoopSnapshot;
        if (!snapshot.terminated) {
          resumable.push({
            id: row.id,
            goalId: row.goal_id,
            turn: row.turn,
            updatedAt: row.updated_at,
          });
        }
      } catch {
        // 损坏的 checkpoint 跳过
      }
    }
    return resumable;
  }
}

let instance: LoopStateManager | null = null;

export function getLoopStateManager(): LoopStateManager {
  if (!instance) instance = new LoopStateManager();
  return instance;
}

export function resetLoopStateManager(): void {
  instance = null;
}
