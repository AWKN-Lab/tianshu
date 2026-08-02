/**
 * awkn-engine — Review 指纹缓存（技能吸收 P1-4）
 *
 * 按 diff fingerprint + 规则包哈希缓存审核结果：
 * - 同一 diff 内容 + 同一规则包 → 直接复用上次 receipt，不重复调用 LLM；
 * - fingerprint 或规则包变化 → 缓存自动失效（新的键）；
 * - 缓存仅作为结果来源，receipt 本身仍是权威结构。
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ReviewReceipt } from '../../contracts/public.js';

export interface ReviewCacheEntry {
  id: string;
  diff_fingerprint: string;
  rule_bundle_hash: string;
  verdict: string;
  receipt_json: string;
  cached_at: string;
  hit_count: number;
  updated_at: string;
}

export interface ReviewCacheHit {
  readonly entry: ReviewCacheEntry;
  readonly receipt: ReviewReceipt;
}

export class ReviewCache {
  constructor(private readonly db: Database.Database) {}

  /** 按 fingerprint + ruleBundleHash 精确查找；命中则自增 hit_count */
  lookup(diffFingerprint: string, ruleBundleHash: string): ReviewCacheHit | null {
    const row = this.db.prepare(
      `SELECT * FROM review_cache WHERE diff_fingerprint = ? AND rule_bundle_hash = ?`,
    ).get(diffFingerprint, ruleBundleHash) as ReviewCacheEntry | undefined;
    if (!row) return null;
    this.db.prepare(
      `UPDATE review_cache SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), row.id);
    let receipt: ReviewReceipt;
    try {
      receipt = JSON.parse(row.receipt_json) as ReviewReceipt;
    } catch {
      return null;
    }
    return { entry: { ...row, hit_count: row.hit_count + 1 }, receipt };
  }

  /**
   * 写入缓存（幂等：同键覆盖）。
   * 只缓存 PASS 结果；非 PASS 不写入（返回 null），避免 FAIL/PARTIAL 掩盖后续修复。
   */
  store(diffFingerprint: string, ruleBundleHash: string, receipt: ReviewReceipt): ReviewCacheEntry | null {
    if (receipt.payload.verdict.status !== 'PASS') return null;
    const now = new Date().toISOString();
    const existing = this.db.prepare(
      `SELECT id FROM review_cache WHERE diff_fingerprint = ? AND rule_bundle_hash = ?`,
    ).get(diffFingerprint, ruleBundleHash) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    this.db.prepare(
      `INSERT INTO review_cache
       (id, diff_fingerprint, rule_bundle_hash, verdict, receipt_json, cached_at, hit_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         diff_fingerprint = excluded.diff_fingerprint,
         rule_bundle_hash = excluded.rule_bundle_hash,
         verdict = excluded.verdict,
         receipt_json = excluded.receipt_json,
         updated_at = excluded.updated_at`,
    ).run(id, diffFingerprint, ruleBundleHash, receipt.payload.verdict.status, JSON.stringify(receipt), now, 0, now);
    return this.db.prepare('SELECT * FROM review_cache WHERE id = ?').get(id) as ReviewCacheEntry;
  }

  /** 统计缓存条目数与命中数 */
  stats(): { entries: number; hits: number } {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS entries, COALESCE(SUM(hit_count), 0) AS hits FROM review_cache',
    ).get() as { entries: number; hits: number };
    return { entries: row.entries, hits: row.hits };
  }
}
