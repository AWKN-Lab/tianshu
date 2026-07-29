/**
 * 错误台账 — M3 自进化机制核心
 *
 * 职责：
 * - 记录每次循环失败/异常（gate FAIL / loop_monitor 触发 / 手动）
 * - 归一化指纹（fingerprint）便于 pattern-detector 重复检测
 * - 提供查询接口（按 source / goal / status / 时间窗口）
 *
 * 设计原则（与 EXP-DRV-20260723-001 E73 一致）：
 * - 失败必须留证据，禁止"消失在内存里"
 * - fingerprint 用 source + normalized(error_text) 哈希，避免堆栈细节差异
 *
 * 数据流：
 *   gate FAIL → recordCorrection({ source: 'reviewGate', ... })
 *   loop-monitor 3-strike → recordCorrection({ source: 'loop_monitor', ... })
 *   pattern-detector 定期扫 → listByFingerprint / listBySource
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { queryAll, queryOne, queryRun } from '../store/db.js';
import type { CorrectionRow } from '../store/schema.js';

// ─── 类型 ─────────────────────────────────────────────────────────

export type CorrectionSource =
  | 'typecheckGate'
  | 'testGate'
  | 'lintGate'
  | 'reviewGate'
  | 'securityGate'
  | 'verificationGate'
  | 'budgetGate'
  | 'cicdTesterGate'
  | 'loop_monitor'
  | 'manual';

export type CorrectionSeverity = 'info' | 'warn' | 'error' | 'fatal';
export type CorrectionStatus = 'open' | 'resolved' | 'ignored';

export interface RecordCorrectionInput {
  goalId?: string;
  source: CorrectionSource | string;
  severity?: CorrectionSeverity;
  errorText: string;
  /** Optional stable upstream fingerprint (for example a ReviewFinding fingerprint). */
  fingerprint?: string;
  context?: Record<string, unknown>;
}

export interface ListFilter {
  source?: string;
  goalId?: string;
  status?: CorrectionStatus | string;
  fingerprint?: string;
  /** 只看最近 N 小时 */
  sinceHours?: number;
  limit?: number;
}

// ─── 归一化 + 指纹 ────────────────────────────────────────────────

/**
 * 归一化错误文本：去空白、去时间戳、去路径前缀、转小写
 * 目的：让"file not found: /tmp/x.ts" 和 "File not found: /tmp/y.ts" 命中同一指纹
 */
export function normalizeErrorText(text: string): string {
  if (!text) return '';
  return text
    // 去 ANSI 颜色码
    .replace(/\x1b\[[0-9;]*m/g, '')
    // 去绝对路径前缀（保留 basename）
    .replace(/(?:file:\/\/)?[A-Z]:[\\\/][^\s:]+/gi, (m) => {
      const parts = m.split(/[\\\/]/);
      return parts[parts.length - 1] || m;
    })
    .replace(/(?:\/[\w.\-]+\/)+([\w.\-]+)/g, '$1')
    // 去时间戳 2026-07-23T12:34:56.789Z
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<ts>')
    // 去纯数字 ID / UUID
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{10,13}\b/g, '<num>')
    // 折叠空白
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 计算 fingerprint：sha256(source + '|' + normalized_error)[:16] */
export function computeFingerprint(source: string, errorText: string): string {
  const normalized = normalizeErrorText(errorText);
  const key = `${source}|${normalized}`;
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

// ─── Manager ──────────────────────────────────────────────────────

export class CorrectionsLedger {
  /** 记录一条错误 */
  record(input: RecordCorrectionInput): CorrectionRow {
    if (!input.errorText?.trim()) {
      throw new Error('errorText 不能为空');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const severity = input.severity ?? 'error';
    if (input.fingerprint !== undefined && !/^[0-9a-f]{16}(?:[0-9a-f]{48})?$/.test(input.fingerprint)) {
      throw new Error('fingerprint 必须是 16 或 64 位小写十六进制');
    }
    const fingerprint = input.fingerprint ?? computeFingerprint(input.source, input.errorText);
    const contextJson = JSON.stringify(input.context ?? {});

    queryRun(
      `INSERT INTO corrections_ledger
       (id, ts, goal_id, source, severity, error_text, fingerprint, context_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [
        id,
        now,
        input.goalId ?? null,
        input.source,
        severity,
        input.errorText,
        fingerprint,
        contextJson,
        now,
        now,
      ],
    );

    return this.read(id)!;
  }

  /** 读单条 */
  read(id: string): CorrectionRow | null {
    return queryOne<CorrectionRow>(
      'SELECT * FROM corrections_ledger WHERE id = ?',
      [id],
    ) ?? null;
  }

  /** 列表查询 */
  list(filter: ListFilter = {}): CorrectionRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.source) {
      conditions.push('source = ?');
      params.push(filter.source);
    }
    if (filter.goalId) {
      conditions.push('goal_id = ?');
      params.push(filter.goalId);
    }
    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.fingerprint) {
      conditions.push('fingerprint = ?');
      params.push(filter.fingerprint);
    }
    if (filter.sinceHours && filter.sinceHours > 0) {
      const since = new Date(Date.now() - filter.sinceHours * 3600 * 1000).toISOString();
      conditions.push('ts >= ?');
      params.push(since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const sql = `SELECT * FROM corrections_ledger ${where} ORDER BY ts DESC LIMIT ${Number(limit)}`;
    return queryAll<CorrectionRow>(sql, params);
  }

  /** 按 fingerprint 聚合计数 */
  countByFingerprint(sinceHours?: number): Array<{
    fingerprint: string;
    source: string;
    count: number;
    firstTs: string;
    lastTs: string;
    latestError: string;
  }> {
    const conditions: string[] = ["status = 'open'"];
    const params: unknown[] = [];
    if (sinceHours && sinceHours > 0) {
      const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
      conditions.push('ts >= ?');
      params.push(since);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const sql = `
      SELECT
        fingerprint,
        source,
        COUNT(*) as count,
        MIN(ts) as firstTs,
        MAX(ts) as lastTs,
        (SELECT error_text FROM corrections_ledger c2
         WHERE c2.fingerprint = corrections_ledger.fingerprint
         ORDER BY ts DESC LIMIT 1) as latestError
      FROM corrections_ledger
      ${where}
      GROUP BY fingerprint, source
      ORDER BY count DESC
    `;
    return queryAll<{
      fingerprint: string;
      source: string;
      count: number;
      firstTs: string;
      lastTs: string;
      latestError: string;
    }>(sql, params);
  }

  /** 标记为已解决 */
  resolve(id: string, resolution: string, experienceId?: string): CorrectionRow | null {
    const now = new Date().toISOString();
    queryRun(
      `UPDATE corrections_ledger
       SET status = 'resolved', resolution = ?, experience_id = ?, updated_at = ?
       WHERE id = ?`,
      [resolution, experienceId ?? null, now, id],
    );
    return this.read(id);
  }

  /** 忽略（误报或不再相关） */
  ignore(id: string, reason: string): CorrectionRow | null {
    const now = new Date().toISOString();
    queryRun(
      `UPDATE corrections_ledger
       SET status = 'ignored', resolution = ?, updated_at = ?
       WHERE id = ?`,
      [reason, now, id],
    );
    return this.read(id);
  }

  /** 批量关闭某个 fingerprint 下的所有 open 记录 */
  resolveByFingerprint(fingerprint: string, resolution: string, experienceId?: string): number {
    const now = new Date().toISOString();
    return queryRun(
      `UPDATE corrections_ledger
       SET status = 'resolved', resolution = ?, experience_id = ?, updated_at = ?
       WHERE fingerprint = ? AND status = 'open'`,
      [resolution, experienceId ?? null, now, fingerprint],
    );
  }

  /** 统计：按 source 分组 */
  statsBySource(sinceHours?: number): Array<{
    source: string;
    total: number;
    open: number;
    resolved: number;
  }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (sinceHours && sinceHours > 0) {
      const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
      conditions.push('ts >= ?');
      params.push(since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT
        source,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved
      FROM corrections_ledger
      ${where}
      GROUP BY source
      ORDER BY total DESC
    `;
    return queryAll<{
      source: string;
      total: number;
      open: number;
      resolved: number;
    }>(sql, params);
  }
}

// ─── 单例 ────────────────────────────────────────────────────────

let instance: CorrectionsLedger | null = null;

export function getCorrectionsLedger(): CorrectionsLedger {
  if (!instance) {
    instance = new CorrectionsLedger();
  }
  return instance;
}
