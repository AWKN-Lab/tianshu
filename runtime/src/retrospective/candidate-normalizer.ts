/**
 * Retrospective 候选归一化器 — Spiral 4
 *
 * 从已完成工作项的 receipts / stage 结果 / 失败信息中提取归一化的
 * RetrospectiveCandidate 输入，去重并按严重程度排序。
 *
 * 约束：本模块只做数据归一化，不触碰 DB、不改变候选状态。
 */
import { createHash } from 'node:crypto';
import {
  RetrospectiveCandidateSchema,
  RetrospectiveLayerSchema,
  RetrospectiveSeveritySchema,
  type RetrospectiveCandidate,
  type RetrospectiveLayer,
  type RetrospectiveProposedAction,
  type RetrospectiveSeverity,
} from './contracts.js';
import { createAwknId } from '../contracts/ids.js';
import { stableHash } from '../contracts/canonical-json.js';

// ─── 输入类型 ─────────────────────────────────────────────

/** 已完成工作项的原始复盘输入 */
export interface RetrospectiveRawInput {
  missionId: string;
  layer: RetrospectiveLayer;
  workItemId: string;
  workItemType: string;
  /** 关联的 stage receipts（包含 verdict、toolsUsed、evidenceRefs） */
  receipts: ReadonlyArray<{
    receiptId: string;
    receiptType: string;
    verdict: string;
    evidenceRefs: ReadonlyArray<string>;
  }>;
  /** 失败/异常记录 */
  failures: ReadonlyArray<{
    stageType: string;
    reason: string;
    severity: RetrospectiveSeverity;
  }>;
  /** 生成候选的 actor */
  generatedByActorId: string;
}

/** 归一化后的候选创建输入（未持久化） */
export interface NormalizedCandidateInput {
  candidateId: string;
  missionId: string;
  layer: RetrospectiveLayer;
  workItemId: string;
  workItemType: string;
  summary: string;
  lessons: string[];
  evidenceReceiptIds: string[];
  proposedAction: RetrospectiveProposedAction;
  severity: RetrospectiveSeverity;
  generatedByActorId: string;
  generatedAt: string;
}

// ─── 常量 ─────────────────────────────────────────────────

const MAX_SUMMARY_LENGTH = 500;

const SEVERITY_RANK: Record<RetrospectiveSeverity, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
};

// ─── 辅助 ─────────────────────────────────────────────────

function dedupeArray<T>(values: ReadonlyArray<T>): T[] {
  return [...new Set(values)];
}

function truncateSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_LENGTH) return summary;
  return `${summary.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

function proposeActionFromFailure(
  severity: RetrospectiveSeverity,
  verdict: string,
): RetrospectiveProposedAction {
  if (severity === 'ERROR' && verdict === 'FAIL') return 'QUARANTINE_PATTERN';
  if (severity === 'WARN') return 'ADJUST_POLICY';
  if (severity === 'ERROR') return 'ESCALATE';
  return 'PROMOTE_RULE';
}

function contentHash(input: NormalizedCandidateInput): string {
  return stableHash('awkn-retrospective-candidate-content/v1', {
    layer: input.layer,
    workItemId: input.workItemId,
    proposedAction: input.proposedAction,
    summary: input.summary,
    lessons: input.lessons,
  });
}

// ─── 主函数 ───────────────────────────────────────────────

/**
 * 从原始复盘输入生成归一化的候选输入列表。
 *
 * - 对 evidence receipt IDs 去重
 * - 校验 layer 合法性
 * - 截断过长的 summary
 * - 每条 failure 生成一个候选；无 failure 时从通过的 receipts 生成 INFO 候选
 */
export function normalizeRetrospectiveInput(raw: RetrospectiveRawInput): NormalizedCandidateInput[] {
  // 校验 layer
  const layerParse = RetrospectiveLayerSchema.safeParse(raw.layer);
  if (!layerParse.success) {
    throw new Error(`invalid retrospective layer: ${raw.layer}`);
  }

  const generatedAt = new Date().toISOString();
  const allEvidenceIds = dedupeArray(
    raw.receipts.flatMap((r) => r.evidenceRefs),
  );
  const allReceiptIds = dedupeArray(
    raw.receipts.map((r) => r.receiptId),
  );

  const inputs: NormalizedCandidateInput[] = [];

  if (raw.failures.length > 0) {
    for (const failure of raw.failures) {
      const severity = RetrospectiveSeveritySchema.parse(failure.severity);
      const verdict = raw.receipts.find((r) => r.verdict === 'FAIL')?.verdict ?? 'FAIL';
      const proposedAction = proposeActionFromFailure(severity, verdict);
      const summary = truncateSummary(
        `${failure.stageType} failure: ${failure.reason}`,
      );
      inputs.push({
        candidateId: createAwknId('candidate'),
        missionId: raw.missionId,
        layer: raw.layer,
        workItemId: raw.workItemId,
        workItemType: raw.workItemType,
        summary,
        lessons: [failure.reason],
        evidenceReceiptIds: allReceiptIds.length > 0 ? allReceiptIds : allEvidenceIds,
        proposedAction,
        severity,
        generatedByActorId: raw.generatedByActorId,
        generatedAt,
      });
    }
  } else {
    // 无失败：生成一个 INFO 候选记录成功经验
    const summary = truncateSummary(
      `${raw.workItemType} ${raw.workItemId} completed successfully with ${raw.receipts.length} receipts`,
    );
    inputs.push({
      candidateId: createAwknId('candidate'),
      missionId: raw.missionId,
      layer: raw.layer,
      workItemId: raw.workItemId,
      workItemType: raw.workItemType,
      summary,
      lessons: [`all ${raw.receipts.length} stages passed`],
      evidenceReceiptIds: allReceiptIds.length > 0 ? allReceiptIds : allEvidenceIds,
      proposedAction: 'PROMOTE_RULE',
      severity: 'INFO',
      generatedByActorId: raw.generatedByActorId,
      generatedAt,
    });
  }

  return inputs;
}

/**
 * 去重候选：按 (layer + workItemId + proposedAction + content hash) 去重。
 * 保留首个出现的候选。
 */
export function deduplicateCandidates(inputs: NormalizedCandidateInput[]): NormalizedCandidateInput[] {
  const seen = new Set<string>();
  const result: NormalizedCandidateInput[] = [];
  for (const input of inputs) {
    const hash = contentHash(input);
    const key = `${input.layer}|${input.workItemId}|${input.proposedAction}|${hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(input);
  }
  return result;
}

/**
 * 按严重程度排序：ERROR > WARN > INFO。
 * 同级别按 candidateId 稳定排序。
 */
export function rankCandidatesBySeverity(inputs: NormalizedCandidateInput[]): NormalizedCandidateInput[] {
  return [...inputs].sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rankDiff !== 0) return rankDiff;
    return a.candidateId.localeCompare(b.candidateId);
  });
}

/**
 * 将归一化输入转换为持久化候选对象（通过 schema 校验）。
 */
export function toRetrospectiveCandidate(input: NormalizedCandidateInput): RetrospectiveCandidate {
  const candidate: RetrospectiveCandidate = {
    schema: 'awkn-retrospective-candidate/v1',
    candidateId: input.candidateId,
    missionId: input.missionId,
    layer: input.layer,
    workItemId: input.workItemId,
    workItemType: input.workItemType,
    summary: input.summary,
    lessons: input.lessons,
    evidenceReceiptIds: input.evidenceReceiptIds,
    proposedAction: input.proposedAction,
    severity: input.severity,
    generatedByActorId: input.generatedByActorId,
    generatedAt: input.generatedAt,
  };
  return RetrospectiveCandidateSchema.parse(candidate);
}

/**
 * 计算候选内容的短哈希（用于去重键）。
 */
export function candidateContentHash(input: NormalizedCandidateInput): string {
  return createHash('sha256').update(contentHash(input)).digest('hex').slice(0, 16);
}
