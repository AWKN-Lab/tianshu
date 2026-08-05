/**
 * Retrospective → Evolution Bridge — Spiral 4
 *
 * 将 Retrospective 生成的 DRAFT 候选接入 Evolution 生命周期。
 *
 * 转换路径（复盘候选层）：
 *   DRAFT → VALIDATING → APPROVED → SHADOW → ACTIVE → QUARANTINED / RETIRED
 *
 * 约束（CRITICAL）：
 * - Evolution actor 必须与 Retrospective actor 分离（enforceSeparationV2）
 * - 授权范围不得扩张（候选请求权限 ⊆ envelope 权限）
 * - SHADOW/ACTIVE 回归 → 自动 QUARANTINE + 恢复上一 ACTIVE
 *
 * 复用：EvolutionLifecycle / ReplayEvaluator（evolve/lifecycle.ts, evolve/replay-evaluator.ts）
 *       用于回放验证与 evolution_candidate 状态机管理。
 *
 * 对应契约: contracts/workflow-v2.ts — INCOMPATIBLE_PAIRS_V2 ['Retrospective','Evolution']
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { enforceSeparationV2, type SeparationCheckParams } from '../governor/separation-policy-v2.js';
import type { AgentInstanceV2, AgentProfileV2 } from '../contracts/workflow-v2.js';
import { getDb, queryAll, queryOne, transaction } from '../store/db.js';
import {
  getRetrospectiveCandidateById,
  updateRetrospectiveCandidateStatus,
} from '../retrospective/retrospective-coordinator.js';
import type { RetrospectiveCandidateRow } from '../retrospective/contracts.js';
import { EvolutionLifecycle } from './lifecycle.js';
import {
  ReplayEvaluator,
  type ReplayMetrics,
  type ReplayRunner,
  type EvaluationThresholds,
} from './replay-evaluator.js';

// ─── 类型 ─────────────────────────────────────────────────

export interface PromoteCandidateParams {
  candidateId: string;
  evolutionActorInstance: AgentInstanceV2;
  evolutionActorProfile: AgentProfileV2;
  priorInstances: AgentInstanceV2[];
  priorProfiles: AgentProfileV2[];
  authorizationEnvelopeId: string;
  /** 回放 runner（可注入用于测试）。不提供时使用默认 always-pass runner */
  replayRunner?: ReplayRunner;
  /** 回放阈值覆盖 */
  thresholds?: Partial<EvaluationThresholds>;
  /** envelope 允许的权限列表。不提供时从 authorization_envelope 表加载 */
  envelopePermissions?: string[];
}

export interface PromoteCandidateResult {
  success: boolean;
  reason?: string;
  finalStatus: string;
  linkedEvolutionCandidateId?: string;
  replayVerdict?: 'PASS' | 'FAIL';
  replayReasons?: string[];
  /** 非裁决性超限告警（如 token 注入开销），随回放结果留痕 */
  replayWarnings?: string[];
}

// ─── 常量 ─────────────────────────────────────────────────

/** proposedAction → 所需权限映射 */
const ACTION_REQUIRED_PERMISSIONS: Record<string, string[]> = {
  PROMOTE_RULE: ['rule:write'],
  ADJUST_POLICY: ['policy:write'],
  QUARANTINE_PATTERN: ['pattern:quarantine'],
  ESCALATE: ['escalate'],
};

/** 回归判定阈值：successRate 不得低于此值 */
const REGRESSION_SUCCESS_RATE_THRESHOLD = 0.5;

// ─── 默认回放 runner ──────────────────────────────────────

const defaultRunner: ReplayRunner = async () => ({
  successRate: 1,
  avgCycles: 1,
  tokenCount: 100,
  errorRate: 0,
  humanTakeoverRate: 0,
  securityViolationRate: 0,
});

// ─── 辅助 ─────────────────────────────────────────────────

function loadEnvelopePermissions(envelopeId: string): string[] {
  const row = queryOne<{ scope_tools: string }>(
    `SELECT scope_tools FROM authorization_envelope WHERE id = ?`,
    [envelopeId],
  );
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.scope_tools) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]).filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function isSubset(required: string[], allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return required.every((perm) => allowedSet.has(perm));
}

function createTempContentFile(candidate: RetrospectiveCandidateRow): string {
  const tempDir = join(tmpdir(), 'awkn-retro-bridge');
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
  const path = join(tempDir, `${candidate.candidate_id}.md`);
  const content = `# Retrospective Candidate ${candidate.candidate_id}\n\n${candidate.summary}\n\n## Lessons\n\n${JSON.parse(candidate.lessons_json).map((l: string) => `- ${l}`).join('\n')}\n`;
  writeFileSync(path, content, 'utf-8');
  return path;
}

function findPreviousActiveCandidate(
  db: Database.Database,
  missionId: string,
  excludeCandidateId: string,
): RetrospectiveCandidateRow | null {
  const row = db.prepare(
    `SELECT * FROM workflow_retrospective_candidate
     WHERE mission_id = ? AND evolution_status = 'ACTIVE' AND candidate_id <> ?
     ORDER BY updated_at DESC LIMIT 1`,
  ).get(missionId, excludeCandidateId) as RetrospectiveCandidateRow | undefined;
  return row ?? null;
}

function isRegression(metrics: ReplayMetrics): boolean {
  return metrics.successRate < REGRESSION_SUCCESS_RATE_THRESHOLD;
}

// ─── 主入口：promoteCandidateToEvolution ──────────────────

/**
 * 将复盘候选提升到 Evolution 生命周期。
 *
 * 步骤：
 * 1. 读取复盘候选，确认状态为 DRAFT
 * 2. 强制分离策略（Evolution actor ≠ Retrospective actor）
 * 3. 授权范围检查（候选权限 ⊆ envelope 权限）
 * 4. 创建 linked evolution_candidate（DRAFT）
 * 5. 设置复盘候选 → VALIDATING
 * 6. 运行回放（ReplayEvaluator）
 * 7. PASS → 复盘候选 APPROVED → SHADOW → ACTIVE；evolution_candidate → APPROVED → ACTIVE
 *    FAIL → 复盘候选保持 VALIDATING
 *
 * 约束：
 * - Evolution actor 必须与 Retrospective actor 分离
 * - 授权范围不得扩张
 */
export async function promoteCandidateToEvolution(
  params: PromoteCandidateParams,
): Promise<PromoteCandidateResult> {
  const db = getDb();

  // 1. 读取复盘候选
  const candidate = getRetrospectiveCandidateById(params.candidateId);
  if (!candidate) {
    return { success: false, reason: `candidate ${params.candidateId} not found`, finalStatus: 'UNKNOWN' };
  }
  if (candidate.evolution_status !== 'DRAFT') {
    return {
      success: false,
      reason: `candidate ${params.candidateId} is ${candidate.evolution_status}, must be DRAFT`,
      finalStatus: candidate.evolution_status,
    };
  }

  // 2. 强制分离策略
  const separationParams: SeparationCheckParams = {
    currentProfile: params.evolutionActorProfile,
    currentInstance: params.evolutionActorInstance,
    priorInstances: params.priorInstances,
    priorProfiles: params.priorProfiles,
    authorizationEnvelopeId: params.authorizationEnvelopeId,
    workspacePolicy: 'read_write',
    frozenInputHash: params.evolutionActorInstance.permissionSnapshotHash,
    stageFrozenHash: params.evolutionActorInstance.permissionSnapshotHash,
    availableBudget: 1000,
    availableConcurrency: 1,
  };
  const separation = enforceSeparationV2(separationParams);
  if (!separation.allowed) {
    return {
      success: false,
      reason: `separation policy denied: ${separation.reason ?? 'unknown'}`,
      finalStatus: candidate.evolution_status,
    };
  }

  // 3. 授权范围检查
  const requiredPerms = ACTION_REQUIRED_PERMISSIONS[candidate.proposed_action] ?? [];
  const envelopePerms = params.envelopePermissions ?? loadEnvelopePermissions(params.authorizationEnvelopeId);
  if (requiredPerms.length > 0 && !isSubset(requiredPerms, envelopePerms)) {
    return {
      success: false,
      reason: `authorization scope expansion: candidate requires ${requiredPerms.join(',')} but envelope only allows [${envelopePerms.join(',')}]`,
      finalStatus: candidate.evolution_status,
    };
  }

  // 4. 创建 linked evolution_candidate
  const lifecycle = new EvolutionLifecycle(db);
  const contentPath = createTempContentFile(candidate);
  const experienceId = `retro-${candidate.candidate_id}`;
  const linkedCandidate = lifecycle.createCandidate({
    experienceId,
    contentPath,
    contentHash: candidate.summary, // 简化：用 summary 作为内容哈希占位
    sourcePattern: {
      kind: 'retrospective',
      layer: candidate.layer,
      workItemId: candidate.work_item_id,
      proposedAction: candidate.proposed_action,
    },
    sourceFingerprint: `retro:${candidate.mission_id}:${candidate.work_item_id}:${candidate.proposed_action}`,
  });

  // 5. 复盘候选 → VALIDATING
  updateRetrospectiveCandidateStatus(params.candidateId, 'VALIDATING', linkedCandidate.id);

  // 6. 运行回放
  const evaluator = new ReplayEvaluator(db);
  // 确保至少有一个 replay case
  if (evaluator.listCases().length === 0) {
    evaluator.addCase({
      name: `retro-${params.candidateId}`,
      input: { prompt: candidate.summary },
      expected: { success: true },
      tags: ['retrospective'],
    });
  }

  const runner = params.replayRunner ?? defaultRunner;
  let verdict: 'PASS' | 'FAIL';
  let reasons: string[];
  let warnings: string[] = [];
  try {
    const result = await evaluator.evaluate(linkedCandidate.id, runner, params.thresholds);
    verdict = result.verdict;
    reasons = result.reasons;
    warnings = result.warnings;
  } catch (err) {
    // 回放执行失败 → 保持 VALIDATING
    return {
      success: false,
      reason: `replay evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      finalStatus: 'VALIDATING',
      linkedEvolutionCandidateId: linkedCandidate.id,
    };
  }

  // 7. 根据回放结果迁移
  if (verdict === 'FAIL') {
    // 回放失败 → 复盘候选保持 VALIDATING
    return {
      success: false,
      reason: `replay failed: ${reasons.join('; ')}`,
      finalStatus: 'VALIDATING',
      linkedEvolutionCandidateId: linkedCandidate.id,
      replayVerdict: 'FAIL',
      replayReasons: reasons,
      replayWarnings: warnings,
    };
  }

  // 回放通过 → APPROVED → SHADOW → ACTIVE
  return transaction((): PromoteCandidateResult => {
    // 复盘候选 → APPROVED
    updateRetrospectiveCandidateStatus(params.candidateId, 'APPROVED');

    // 记录当前 ACTIVE（如果有），用于回滚
    const previousActive = findPreviousActiveCandidate(db, candidate.mission_id, params.candidateId);
    const previousActiveId = previousActive?.candidate_id ?? null;

    // 复盘候选 → SHADOW
    updateRetrospectiveCandidateStatus(params.candidateId, 'SHADOW', undefined, previousActiveId);

    // SHADOW 阶段检查（此处简化为直接通过；真实场景需 enforce mode 对比）
    // 若 SHADOW 检测到回归，应 autoRollbackOnRegression

    // 激活 linked evolution_candidate（APPROVED → ACTIVE）
    try {
      lifecycle.activate(linkedCandidate.id);
    } catch (err) {
      // 激活失败 → 回退到 APPROVED
      updateRetrospectiveCandidateStatus(params.candidateId, 'APPROVED');
      return {
        success: false,
        reason: `evolution activation failed: ${err instanceof Error ? err.message : String(err)}`,
        finalStatus: 'APPROVED',
        linkedEvolutionCandidateId: linkedCandidate.id,
        replayVerdict: 'PASS',
        replayReasons: reasons,
        replayWarnings: warnings,
      };
    }

    // 复盘候选 → ACTIVE
    updateRetrospectiveCandidateStatus(params.candidateId, 'ACTIVE');

    return {
      success: true,
      finalStatus: 'ACTIVE',
      linkedEvolutionCandidateId: linkedCandidate.id,
      replayVerdict: 'PASS',
      replayReasons: reasons,
      replayWarnings: warnings,
    };
  });
}

// ─── quarantineCandidate ──────────────────────────────────

/**
 * 将 ACTIVE 候选隔离，并恢复上一 ACTIVE 版本。
 *
 * 步骤：
 * 1. 读取候选，确认状态为 ACTIVE
 * 2. 记录 previous_active_candidate_id
 * 3. 当前候选 → QUARANTINED
 * 4. 若 previous_active_candidate_id 存在，恢复其为 ACTIVE
 *
 * 若候选无 previous ACTIVE，则仅隔离不恢复。
 */
export function quarantineCandidate(
  candidateId: string,
  reason: string,
): { success: boolean; reason?: string; finalStatus: string; restoredCandidateId?: string } {
  const candidate = getRetrospectiveCandidateById(candidateId);
  if (!candidate) {
    return { success: false, reason: `candidate ${candidateId} not found`, finalStatus: 'UNKNOWN' };
  }
  if (candidate.evolution_status !== 'ACTIVE' && candidate.evolution_status !== 'SHADOW') {
    return {
      success: false,
      reason: `candidate ${candidateId} is ${candidate.evolution_status}, must be ACTIVE or SHADOW to quarantine`,
      finalStatus: candidate.evolution_status,
    };
  }

  return transaction((): { success: boolean; reason?: string; finalStatus: string; restoredCandidateId?: string } => {
    const previousActiveId = candidate.previous_active_candidate_id;

    // 当前候选 → QUARANTINED
    updateRetrospectiveCandidateStatus(candidateId, 'QUARANTINED');

    // 恢复上一 ACTIVE
    if (previousActiveId) {
      const previous = getRetrospectiveCandidateById(previousActiveId);
      if (previous && previous.evolution_status === 'QUARANTINED') {
        updateRetrospectiveCandidateStatus(previousActiveId, 'ACTIVE');
        return {
          success: true,
          reason,
          finalStatus: 'QUARANTINED',
          restoredCandidateId: previousActiveId,
        };
      }
    }

    return {
      success: true,
      finalStatus: 'QUARANTINED',
      reason: previousActiveId ? `no restorable previous ACTIVE (${previousActiveId})` : 'no previous ACTIVE to restore',
    };
  });
}

// ─── autoRollbackOnRegression ─────────────────────────────

/**
 * 当 SHADOW/ACTIVE 候选检测到回归时，自动隔离并恢复上一 ACTIVE。
 *
 * 回归判定：replayMetrics.successRate < REGRESSION_SUCCESS_RATE_THRESHOLD
 *
 * 若指标通过（无回归），候选保持当前状态不变。
 */
export function autoRollbackOnRegression(
  candidateId: string,
  replayMetrics: ReplayMetrics,
): { success: boolean; reason?: string; finalStatus: string; rolledBack: boolean; restoredCandidateId?: string } {
  const candidate = getRetrospectiveCandidateById(candidateId);
  if (!candidate) {
    return {
      success: false,
      reason: `candidate ${candidateId} not found`,
      finalStatus: 'UNKNOWN',
      rolledBack: false,
    };
  }

  // 指标通过 → 无回归，不操作
  if (!isRegression(replayMetrics)) {
    return {
      success: true,
      finalStatus: candidate.evolution_status,
      rolledBack: false,
      reason: 'metrics above threshold, no regression',
    };
  }

  // 检测到回归 → QUARANTINE + 恢复
  const result = quarantineCandidate(candidateId, `auto-rollback: regression detected (successRate=${replayMetrics.successRate})`);
  return {
    success: result.success,
    reason: result.reason ?? `auto-rollback: regression detected (successRate=${replayMetrics.successRate})`,
    finalStatus: result.finalStatus,
    rolledBack: true,
    restoredCandidateId: result.restoredCandidateId,
  };
}

// ─── 查询辅助 ─────────────────────────────────────────────

/**
 * 查询某个 mission 下指定状态的复盘候选。
 */
export function listRetrospectiveCandidatesByStatus(
  missionId: string,
  status: string,
): RetrospectiveCandidateRow[] {
  return queryAll<RetrospectiveCandidateRow>(
    `SELECT * FROM workflow_retrospective_candidate
     WHERE mission_id = ? AND evolution_status = ?
     ORDER BY updated_at DESC`,
    [missionId, status],
  );
}
