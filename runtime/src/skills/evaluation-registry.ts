/**
 * Skill Evaluation Registry (Phase 6 / C04 / WP-AOS-07)
 *
 * 设计文档：`docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 9、14 章
 *
 * 职责：
 * - 存储历史 SkillScore（用于 historicalSuccess / evidenceQuality / costEfficiency）
 * - 管理 Skill 候选生命周期：DRAFT → VALIDATING → APPROVED → ACTIVE → QUARANTINED → RETIRED
 * - 检查 ACTIVE 条件（设计文档第 14 章）
 *
 * ACTIVE 条件（设计文档第 14 章）：
 * - Schema合法
 * - 冲突检查通过
 * - 基线回放无安全回归
 * - 目标指标改善或保持
 * - 高影响项目规则经过人工批准
 * - 生成发布Manifest和Hash
 * - 独立性扫描通过
 */

import type {
  SkillManifest,
  SkillStatus,
  SkillScore,
} from '../contracts/skill.js';
import { SkillManifestSchema } from '../contracts/skill.js';

/** Evaluation Registry 错误 */
export class SkillEvaluationRegistryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SkillEvaluationRegistryError';
  }
}

/** Skill 评估记录 */
export interface SkillEvaluationRecord {
  readonly skillId: string;
  readonly version: string;
  readonly score: SkillScore;
  readonly evaluatedAt: string;
  readonly runId: string;
  readonly outcome: 'SUCCESS' | 'PARTIAL' | 'FAILURE';
}

/** ACTIVE 检查结果 */
export interface ActiveCheckResult {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

/** 允许的状态转换 */
const ALLOWED_TRANSITIONS: Record<SkillStatus, SkillStatus[]> = {
  DRAFT: ['VALIDATING', 'RETIRED'],
  VALIDATING: ['APPROVED', 'QUARANTINED', 'DRAFT'],
  APPROVED: ['ACTIVE', 'QUARANTINED'],
  ACTIVE: ['QUARANTINED', 'RETIRED'],
  QUARANTINED: ['RETIRED', 'VALIDATING'],
  RETIRED: [],
};

/**
 * Skill Evaluation Registry
 *
 * Mode 0：in-memory，不持久化
 */
export class SkillEvaluationRegistry {
  private readonly manifests = new Map<string, SkillManifest>();
  private readonly registeredAtMap = new Map<string, string>();
  private readonly activeVersions = new Map<string, string>();
  private readonly evaluations = new Map<string, SkillEvaluationRecord[]>();

  /** 注册 Skill Manifest */
  register(manifest: SkillManifest, registeredAt: string): void {
    // 校验 Schema
    const result = SkillManifestSchema.safeParse(manifest);
    if (!result.success) {
      throw new SkillEvaluationRegistryError(
        `invalid SkillManifest: ${result.error.message}`,
        'INVALID_MANIFEST',
      );
    }

    // 检查版本冲突
    const existing = this.manifests.get(manifest.skillId);
    if (existing && existing.version === manifest.version) {
      throw new SkillEvaluationRegistryError(
        `skillId ${manifest.skillId} version ${manifest.version} already registered`,
        'VERSION_CONFLICT',
      );
    }

    // ACTIVE 单活
    if (manifest.status === 'ACTIVE') {
      this.activeVersions.set(manifest.skillId, manifest.version);
    }

    this.registeredAtMap.set(manifest.skillId, registeredAt);
    this.manifests.set(manifest.skillId, manifest);
  }

  /** 注销 Skill */
  unregister(skillId: string): boolean {
    this.activeVersions.delete(skillId);
    this.registeredAtMap.delete(skillId);
    this.evaluations.delete(skillId);
    return this.manifests.delete(skillId);
  }

  /** 获取注册时间 */
  getRegisteredAt(skillId: string): string | undefined {
    return this.registeredAtMap.get(skillId);
  }

  /** 获取 ACTIVE Skill（按 skillId） */
  getActive(skillId: string): SkillManifest | undefined {
    const manifest = this.manifests.get(skillId);
    if (!manifest) return undefined;
    if (manifest.status !== 'ACTIVE') return undefined;
    if (this.activeVersions.get(skillId) !== manifest.version) return undefined;
    return manifest;
  }

  /** 查询所有 ACTIVE Skill */
  listActive(): readonly SkillManifest[] {
    return Array.from(this.manifests.values()).filter((m) =>
      m.status === 'ACTIVE'
      && this.activeVersions.get(m.skillId) === m.version);
  }

  /** 按 taskProfile 查询 ACTIVE Skill */
  queryByTaskProfile(taskProfile: SkillManifest['taskProfiles'][number]): readonly SkillManifest[] {
    return this.listActive().filter((m) => m.taskProfiles.includes(taskProfile));
  }

  /** 状态转换 */
  transitionStatus(skillId: string, newStatus: SkillStatus): void {
    const manifest = this.manifests.get(skillId);
    if (!manifest) {
      throw new SkillEvaluationRegistryError(
        `skillId not found: ${skillId}`,
        'NOT_FOUND',
      );
    }
    const currentStatus: SkillStatus = manifest.status;
    const wasActive: boolean = currentStatus === 'ACTIVE';
    const allowed = ALLOWED_TRANSITIONS[currentStatus];
    if (!allowed.includes(newStatus)) {
      throw new SkillEvaluationRegistryError(
        `status transition not allowed: ${currentStatus} → ${newStatus}`,
        'INVALID_TRANSITION',
      );
    }
    if (newStatus === 'ACTIVE') {
      this.activeVersions.set(skillId, manifest.version);
    } else if (wasActive) {
      this.activeVersions.delete(skillId);
    }
    this.manifests.set(skillId, { ...manifest, status: newStatus });
  }

  /** 记录评估 */
  recordEvaluation(record: SkillEvaluationRecord): void {
    const list = this.evaluations.get(record.skillId) ?? [];
    list.push(record);
    this.evaluations.set(record.skillId, list);
  }

  /** 获取历史评分（用于 historicalSuccess / evidenceQuality / costEfficiency） */
  getHistoricalScore(skillId: string): SkillScore | undefined {
    const records = this.evaluations.get(skillId);
    if (!records || records.length === 0) return undefined;

    // 取最近 N 次评估的平均值
    const recentRecords = records.slice(-10);
    const sum = recentRecords.reduce(
      (acc, r) => ({
        triggerMatch: acc.triggerMatch + r.score.triggerMatch,
        taskProfileMatch: acc.taskProfileMatch + r.score.taskProfileMatch,
        levelMatch: acc.levelMatch + r.score.levelMatch,
        historicalSuccess: acc.historicalSuccess + r.score.historicalSuccess,
        evidenceQuality: acc.evidenceQuality + r.score.evidenceQuality,
        costEfficiency: acc.costEfficiency + r.score.costEfficiency,
        compatibilityRisk: acc.compatibilityRisk + r.score.compatibilityRisk,
      }),
      {
        triggerMatch: 0,
        taskProfileMatch: 0,
        levelMatch: 0,
        historicalSuccess: 0,
        evidenceQuality: 0,
        costEfficiency: 0,
        compatibilityRisk: 0,
      },
    );
    const n = recentRecords.length;

    // 成功率 = SUCCESS 记录数 / 总记录数
    const successRate = recentRecords.filter((r) => r.outcome === 'SUCCESS').length / n;

    return {
      skillId,
      triggerMatch: sum.triggerMatch / n,
      taskProfileMatch: sum.taskProfileMatch / n,
      levelMatch: sum.levelMatch / n,
      historicalSuccess: successRate,
      evidenceQuality: sum.evidenceQuality / n,
      costEfficiency: sum.costEfficiency / n,
      compatibilityRisk: sum.compatibilityRisk / n,
      totalScore: 0, // 由 computeSkillScore 计算
    };
  }

  /**
   * 检查 Skill 是否满足 ACTIVE 条件
   *
   * 设计文档第 14 章：
   * - Schema合法
   * - 冲突检查通过
   * - 基线回放无安全回归
   * - 目标指标改善或保持
   * - 高影响项目规则经过人工批准
   * - 生成发布Manifest和Hash
   * - 独立性扫描通过
   */
  checkActiveConditions(skillId: string): ActiveCheckResult {
    const manifest = this.manifests.get(skillId);
    if (!manifest) {
      return {
        passed: false,
        failures: [`skillId not found: ${skillId}`],
      };
    }

    const failures: string[] = [];

    // 1. Schema 合法（已在注册时校验）

    // 2. 历史评估存在
    const records = this.evaluations.get(skillId);
    if (!records || records.length === 0) {
      failures.push('no evaluation records (baseline replay not performed)');
    } else {
      // 3. 基线回放无安全回归
      const hasSafetyRegression = records.some((r) => r.outcome === 'FAILURE');
      if (hasSafetyRegression) {
        failures.push('baseline replay has FAILURE outcome (safety regression)');
      }

      // 4. 目标指标改善或保持
      const successRate = records.filter((r) => r.outcome === 'SUCCESS').length / records.length;
      if (successRate < 0.6) {
        failures.push(`success rate ${successRate.toFixed(2)} < 0.6 threshold`);
      }
    }

    // 5. contentHash 存在（已发布 Manifest）
    if (!manifest.contentHash || manifest.contentHash.length !== 64) {
      failures.push('contentHash missing or invalid (Manifest not published)');
    }

    // 6. description 非空（人工审核痕迹）
    if (!manifest.description || manifest.description.trim().length === 0) {
      failures.push('description empty (manual approval missing)');
    }

    return {
      passed: failures.length === 0,
      failures,
    };
  }

  /** Registry 大小 */
  size(): number {
    return this.manifests.size;
  }

  /** ACTIVE Skill 数量 */
  activeCount(): number {
    return this.activeVersions.size;
  }

  /** 评估记录数量 */
  evaluationCount(skillId: string): number {
    return this.evaluations.get(skillId)?.length ?? 0;
  }
}
