/**
 * 模式检测器 — M3 自进化机制核心
 *
 * 职责：
 * - 从 corrections-ledger 查询最近错误
 * - 检测重复模式：相同 fingerprint 出现 ≥3 次 → 自动触发经验沉淀
 * - 检测同类 source 频繁出错（≥5 次/小时）
 * - 检测同一 goal 内反复踩坑（同 fingerprint ≥2 次 in same goal）
 *
 * 输出：DetectedPattern 列表，experience-writer 据此生成 EXP-DRV-*.md 文件
 *
 * 设计原则：
 * - 阈值与 LoopMonitor.maxConsecutiveFailures=3 对齐（避免阈值不一致）
 * - 同一 fingerprint 只生成一次经验文件（resolve 后不再触发）
 * - 时间窗口默认 24h（避免历史噪声干扰）
 */

import { getCorrectionsLedger } from './corrections-ledger.js';
import type { CorrectionRow } from '../store/schema.js';

// ─── 类型 ─────────────────────────────────────────────────────────

export type PatternKind =
  | 'repeated_fingerprint'   // 同指纹重复 N 次
  | 'source_burst'            // 同 source 1 小时内 ≥K 次
  | 'goal_repeat';            // 同 goal 内同指纹 ≥2 次

export interface DetectedPattern {
  kind: PatternKind;
  source: string;
  fingerprint: string;
  count: number;
  firstTs: string;
  lastTs: string;
  latestError: string;
  sampleIds: string[];
  goalId?: string;
  /** 推荐的经验 ID（EXP-DRV-YYYYMMDD-NNN） */
  suggestedExperienceId: string;
}

export interface PatternDetectorConfig {
  /** 同指纹重复次数阈值（默认 3，与 LoopMonitor.maxConsecutiveFailures 对齐） */
  repeatedFingerprintThreshold: number;
  /** source 突发阈值（每小时次数，默认 5） */
  sourceBurstThreshold: number;
  /** 同 goal 内同指纹重复阈值（默认 2） */
  goalRepeatThreshold: number;
  /** 回看时间窗口（小时，默认 24） */
  sinceHours: number;
}

export const DEFAULT_PATTERN_CONFIG: PatternDetectorConfig = {
  repeatedFingerprintThreshold: 3,
  sourceBurstThreshold: 5,
  goalRepeatThreshold: 2,
  sinceHours: 24,
};

// ─── 检测器 ──────────────────────────────────────────────────────

export class PatternDetector {
  private config: PatternDetectorConfig;

  constructor(config: Partial<PatternDetectorConfig> = {}) {
    this.config = { ...DEFAULT_PATTERN_CONFIG, ...config };
  }

  /** 全量检测：返回所有命中的 pattern */
  detect(): DetectedPattern[] {
    return [
      ...this.detectRepeatedFingerprints(),
      ...this.detectSourceBursts(),
      ...this.detectGoalRepeats(),
    ];
  }

  /**
   * 模式 1：相同 fingerprint 重复 ≥ N 次（最近 sinceHours 小时）
   * - 这是核心模式：同一错误反复出现 → 应沉淀经验
   * - 已 resolved 的不参与（避免重复触发）
   */
  detectRepeatedFingerprints(): DetectedPattern[] {
    const stats = getCorrectionsLedger().countByFingerprint(this.config.sinceHours);
    const threshold = this.config.repeatedFingerprintThreshold;

    return stats
      .filter((s) => s.count >= threshold)
      .map((s) => {
        const samples = getCorrectionsLedger()
          .list({ fingerprint: s.fingerprint, limit: 5 })
          .map((c) => c.id);
        return {
          kind: 'repeated_fingerprint' as const,
          source: s.source,
          fingerprint: s.fingerprint,
          count: s.count,
          firstTs: s.firstTs,
          lastTs: s.lastTs,
          latestError: s.latestError,
          sampleIds: samples,
          suggestedExperienceId: generateExperienceId(),
        };
      });
  }

  /**
   * 模式 2：同一 source 1 小时内 ≥ K 次（突发，不论指纹是否相同）
   * - 表示该 gate/source 反复出错，可能根因在 prompt 或外部依赖
   */
  detectSourceBursts(): DetectedPattern[] {
    const since1h = 1; // 固定 1 小时窗口
    const recent = getCorrectionsLedger().list({
      sinceHours: since1h,
      status: 'open',
      limit: 1000,
    });

    const bySource = new Map<string, CorrectionRow[]>();
    for (const c of recent) {
      const arr = bySource.get(c.source) ?? [];
      arr.push(c);
      bySource.set(c.source, arr);
    }

    const threshold = this.config.sourceBurstThreshold;
    const patterns: DetectedPattern[] = [];
    for (const [source, rows] of bySource) {
      if (rows.length < threshold) continue;
      // 用最近一条作为代表
      const latest = rows[0];
      const fingerprint = rows[0].fingerprint;
      patterns.push({
        kind: 'source_burst',
        source,
        fingerprint,
        count: rows.length,
        firstTs: rows[rows.length - 1].ts,
        lastTs: latest.ts,
        latestError: latest.error_text,
        sampleIds: rows.slice(0, 5).map((r) => r.id),
        suggestedExperienceId: generateExperienceId(),
      });
    }
    return patterns;
  }

  /**
   * 模式 3：同一 goal 内同 fingerprint ≥ 2 次
   * - 同一目标内反复踩同样的坑 → 经验必须沉淀
   * - 即使总数 < 3 也触发（goal 内重复更严重）
   */
  detectGoalRepeats(): DetectedPattern[] {
    const recent = getCorrectionsLedger().list({
      sinceHours: this.config.sinceHours,
      status: 'open',
      limit: 1000,
    });

    // 按 (goal_id, fingerprint) 分组
    const groups = new Map<string, CorrectionRow[]>();
    for (const c of recent) {
      if (!c.goal_id) continue;
      const key = `${c.goal_id}|${c.fingerprint}`;
      const arr = groups.get(key) ?? [];
      arr.push(c);
      groups.set(key, arr);
    }

    const threshold = this.config.goalRepeatThreshold;
    const patterns: DetectedPattern[] = [];
    for (const [, rows] of groups) {
      if (rows.length < threshold) continue;
      const latest = rows[0];
      patterns.push({
        kind: 'goal_repeat',
        source: latest.source,
        fingerprint: latest.fingerprint,
        count: rows.length,
        firstTs: rows[rows.length - 1].ts,
        lastTs: latest.ts,
        latestError: latest.error_text,
        sampleIds: rows.slice(0, 5).map((r) => r.id),
        goalId: latest.goal_id ?? undefined,
        suggestedExperienceId: generateExperienceId(),
      });
    }
    return patterns;
  }
}

// ─── 辅助 ────────────────────────────────────────────────────────

/** 生成经验 ID：EXP-DRV-YYYYMMDD-NNN */
export function generateExperienceId(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  // NNN 用 100-999 随机数（同日多经验时靠文件存在性 +1 兜底，见 experience-writer）
  const seq = String(Math.floor(100 + Math.random() * 900));
  return `EXP-DRV-${yyyy}${mm}${dd}-${seq}`;
}

// ─── 单例 ────────────────────────────────────────────────────────

let instance: PatternDetector | null = null;

export function getPatternDetector(): PatternDetector {
  if (!instance) {
    instance = new PatternDetector();
  }
  return instance;
}
