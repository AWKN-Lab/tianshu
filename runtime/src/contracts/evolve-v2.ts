/**
 * Evolve Candidate v2 Contracts (Phase 6 / C09 / WP-AOS-16)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第七、八节
 *
 * 本文件冻结 Evolve Candidate v2 的所有公开 Contract：
 * - EvolveCandidateTypeSchema: 9 种候选类型
 * - EvolveCandidateSourceSchema: 9 种来源
 * - EvolveCandidateStatusSchema: 6 种状态
 * - ReplayMetricsSchema: 回放指标
 * - ProposedChangeSchema: 提议变更内容
 * - EvolveCandidateV2Schema (awkn-evolve-candidate-v2/v1): Evolve v2 候选
 * - EvolveCandidateTransitionSchema: 状态转换记录
 *
 * 不变量：
 * - 所有 schema 使用 zod strict + superRefine
 * - 所有 hash 使用 stableHash（canonical-json.ts）
 * - 所有 ID 使用 createAwknId / awknIdSchema
 * - 所有时间戳使用 UtcTimestampSchema
 * - canonical JSON 不允许 undefined 字段，哈希前需 stripUndefined
 * - 外部材料候选必须重新建模和评测（不能直接 ACTIVE）
 * - Policy/Skill 候选无回放不能 ACTIVE
 * - Candidate 回归时自动 QUARANTINED
 * - 不保留跨仓运行依赖
 */

import { z } from 'zod';
import { stableHash } from './canonical-json.js';
import { awknIdSchema, createAwknId } from './ids.js';
import type { JsonValue } from './json-value.js';
import { SafeNonNegativeIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ===== Section 1: Enums =====

export const EvolveCandidateTypeSchema = z.enum([
  'POLICY',
  'SKILL',
  'PROMPT',
  'MODEL_ROUTE',
  'TOOL_ROUTE',
  'GATE',
  'PROJECT_RULE',
  'CONTEXT_RULE',
  'DELIVERY_RULE',
]);
export type EvolveCandidateType = z.infer<typeof EvolveCandidateTypeSchema>;

export const ALL_EVOLVE_CANDIDATE_TYPES: ReadonlyArray<EvolveCandidateType> = [
  'POLICY', 'SKILL', 'PROMPT', 'MODEL_ROUTE', 'TOOL_ROUTE',
  'GATE', 'PROJECT_RULE', 'CONTEXT_RULE', 'DELIVERY_RULE',
];

export const EvolveCandidateSourceSchema = z.enum([
  'RUN_FAILURE',
  'USER_CORRECTION',
  'OUTCOME_ATTRIBUTION',
  'COSTLY_REPETITION',
  'CONTEXT_MISSELECT',
  'ROUTE_DEGRADATION',
  'DELIVERY_FAILURE',
  'RUNTIME_FEEDBACK',
  'EXTERNAL_RESEARCH',
]);
export type EvolveCandidateSource = z.infer<typeof EvolveCandidateSourceSchema>;

export const ALL_EVOLVE_CANDIDATE_SOURCES: ReadonlyArray<EvolveCandidateSource> = [
  'RUN_FAILURE', 'USER_CORRECTION', 'OUTCOME_ATTRIBUTION', 'COSTLY_REPETITION',
  'CONTEXT_MISSELECT', 'ROUTE_DEGRADATION', 'DELIVERY_FAILURE', 'RUNTIME_FEEDBACK',
  'EXTERNAL_RESEARCH',
];

export const EvolveCandidateStatusSchema = z.enum([
  'DRAFT',
  'VALIDATING',
  'APPROVED',
  'ACTIVE',
  'QUARANTINED',
  'RETIRED',
]);
export type EvolveCandidateStatus = z.infer<typeof EvolveCandidateStatusSchema>;

export const ALLOWED_TRANSITIONS: Readonly<Record<EvolveCandidateStatus, ReadonlyArray<EvolveCandidateStatus>>> = {
  DRAFT: ['VALIDATING', 'RETIRED'],
  VALIDATING: ['APPROVED', 'QUARANTINED', 'RETIRED'],
  APPROVED: ['ACTIVE', 'QUARANTINED', 'RETIRED'],
  ACTIVE: ['QUARANTINED', 'RETIRED'],
  QUARANTINED: ['VALIDATING', 'RETIRED'],
  RETIRED: [],
};

// ===== Section 2: Replay Metrics =====

export const ReplayMetricsSchema = z.object({
  successRate: z.number().min(0).max(1).optional(),
  evidenceGainRate: z.number().min(0).max(1).optional(),
  meanCycles: SafeNonNegativeIntegerSchema.optional(),
  tokenCost: SafeNonNegativeIntegerSchema.optional(),
  latency: SafeNonNegativeIntegerSchema.optional(),
  errorRate: z.number().min(0).max(1).optional(),
  humanTakeoverRate: z.number().min(0).max(1).optional(),
  safetyViolationRate: z.number().min(0).max(1).optional(),
  userDecisionMisattributionRate: z.number().min(0).max(1).optional(),
  contextIrrelevantRate: z.number().min(0).max(1).optional(),
  repeatedSideEffectRate: z.number().min(0).max(1).optional(),
  deliverySuccessRate: z.number().min(0).max(1).optional(),
  independenceViolationRate: z.number().min(0).max(1).optional(),
}).strict().superRefine((value, context) => {
  const allFields = [
    value.successRate, value.evidenceGainRate, value.meanCycles, value.tokenCost,
    value.latency, value.errorRate, value.humanTakeoverRate, value.safetyViolationRate,
    value.userDecisionMisattributionRate, value.contextIrrelevantRate,
    value.repeatedSideEffectRate, value.deliverySuccessRate, value.independenceViolationRate,
  ];
  if (allFields.every((v) => v === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'replay metrics must contain at least one metric field',
    });
  }
});
export type ReplayMetrics = z.infer<typeof ReplayMetricsSchema>;

// ===== Section 3: Proposed Change =====

export const ProposedChangeSchema = z.object({
  changeType: z.string().min(1),
  manifestHash: z.string().regex(SHA256_HEX_PATTERN),
  manifestRef: z.string().min(1),
  description: z.string().min(1),
  impactScope: z.string().min(1).optional(),
}).strict();
export type ProposedChange = z.infer<typeof ProposedChangeSchema>;

// ===== Section 4: Evolve Candidate V2 (awkn-evolve-candidate-v2/v1) =====

export const EvolveCandidateV2Schema = z.object({
  schema: z.literal('awkn-evolve-candidate-v2/v1'),
  candidateId: awknIdSchema('ecv'),
  type: EvolveCandidateTypeSchema,
  source: EvolveCandidateSourceSchema,
  status: EvolveCandidateStatusSchema,
  sourceRunId: awknIdSchema('run').optional(),
  sourceEvidenceIds: z.array(awknIdSchema('ev')).min(1),
  proposedChange: ProposedChangeSchema,
  replayMetrics: ReplayMetricsSchema.optional(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema.optional(),
  quarantineReason: z.string().min(1).optional(),
  humanApproved: z.boolean().optional(),
  independenceScanPassed: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  // 外部材料不能直接 ACTIVE（设计文档 7.2 + 测试 12）
  if (value.source === 'EXTERNAL_RESEARCH' && value.status === 'ACTIVE') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'EXTERNAL_RESEARCH source cannot directly enter ACTIVE status; must re-model and re-evaluate',
    });
  }
  // ACTIVE 必须有回放指标
  if (value.status === 'ACTIVE' && value.replayMetrics === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replayMetrics'],
      message: 'ACTIVE candidate requires replay metrics',
    });
  }
  // POLICY/SKILL ACTIVE 必须有回放（测试 8）
  if ((value.type === 'POLICY' || value.type === 'SKILL') && value.status === 'ACTIVE'
    && value.replayMetrics === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replayMetrics'],
      message: `${value.type} candidate requires replay metrics before ACTIVE`,
    });
  }
  // QUARANTINED 必须有原因
  if (value.status === 'QUARANTINED' && value.quarantineReason === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['quarantineReason'],
      message: 'QUARANTINED candidate requires quarantineReason',
    });
  }
  // sourceEvidenceIds 不能重复
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const eid of value.sourceEvidenceIds) {
    if (seen.has(eid)) duplicates.add(eid);
    seen.add(eid);
  }
  if (duplicates.size > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceEvidenceIds'],
      message: `duplicate sourceEvidenceId: ${[...duplicates].sort().join(', ')}`,
    });
  }
});
export type EvolveCandidateV2 = z.infer<typeof EvolveCandidateV2Schema>;

export const EVOLVE_CANDIDATE_V2_SCHEMA_ID = 'awkn-evolve-candidate-v2/v1';

// ===== Section 5: Transition Record =====

export const EvolveCandidateTransitionSchema = z.object({
  schema: z.literal('awkn-evolve-candidate-transition/v1'),
  transitionId: z.string().min(1),
  candidateId: awknIdSchema('ecv'),
  fromStatus: EvolveCandidateStatusSchema,
  toStatus: EvolveCandidateStatusSchema,
  reason: z.string().min(1),
  transitionedAt: UtcTimestampSchema,
  actor: z.string().min(1).optional(),
}).strict();
export type EvolveCandidateTransition = z.infer<typeof EvolveCandidateTransitionSchema>;

// ===== Section 6: Hash Computation =====

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val !== undefined) {
      result[key] = stripUndefined(val);
    }
  }
  return result;
}

export function computeEvolveCandidateV2Hash(
  candidate: Omit<EvolveCandidateV2, 'candidateId' | 'updatedAt'>,
): string {
  const { candidateId: _candidateId, updatedAt: _updatedAt, ...contentFields } = candidate as EvolveCandidateV2;
  void _candidateId;
  void _updatedAt;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(EVOLVE_CANDIDATE_V2_SCHEMA_ID, stripped);
}

// ===== Section 7: ID 生成辅助 =====

export function createEvolveCandidateV2Id(): string {
  return createAwknId('evolveCandidateV2');
}

// ===== Section 8: 状态转换校验 =====

export function isValidTransition(
  from: EvolveCandidateStatus,
  to: EvolveCandidateStatus,
): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

export function getAllowedNextStatuses(current: EvolveCandidateStatus): ReadonlyArray<EvolveCandidateStatus> {
  return ALLOWED_TRANSITIONS[current] ?? [];
}

// ===== Section 9: ACTIVE 条件校验 =====

export interface ActiveConditionCheck {
  canActivate: boolean;
  failedConditions: string[];
}

export function checkActiveConditions(candidate: EvolveCandidateV2): ActiveConditionCheck {
  const failed: string[] = [];

  if (candidate.status !== 'APPROVED') {
    failed.push('status must be APPROVED before ACTIVE');
  }
  if (candidate.replayMetrics === undefined) {
    failed.push('replay metrics required for ACTIVE');
  }
  if (!candidate.proposedChange.manifestHash) {
    failed.push('manifest hash required for ACTIVE');
  }
  if (candidate.independenceScanPassed !== true) {
    failed.push('independence scan must pass for ACTIVE');
  }
  if ((candidate.type === 'POLICY' || candidate.type === 'SKILL' || candidate.type === 'PROJECT_RULE')
    && candidate.humanApproved !== true) {
    failed.push(`${candidate.type} candidate requires human approval for ACTIVE`);
  }

  return {
    canActivate: failed.length === 0,
    failedConditions: failed,
  };
}
