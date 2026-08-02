/**
 * Retrospective 契约 — Spiral 4
 *
 * 定义 Retrospective 候选与 Receipt Payload 的 Zod schema。
 * Retrospective 只能生成 DRAFT 候选，不得 promote/activate/quarantine。
 *
 * 对应契约: contracts/workflow-v2.ts — INCOMPATIBLE_PAIRS_V2 ['Retrospective','Evolution']
 *           contracts/receipts.ts — ReceiptType 'RETROSPECTIVE'
 *           contracts/feature-flag.ts — AWKN_RETRO_EVOLUTION_V1
 */
import { z } from 'zod';
import { awknIdSchema } from '../contracts/ids.js';
import { UtcTimestampSchema } from '../contracts/time.js';

// ─── Retrospective 层级 ──────────────────────────────────

export const RetrospectiveLayerSchema = z.enum([
  'WORKPACKAGE',
  'MODULE',
  'COMPONENT',
  'MISSION',
]);
export type RetrospectiveLayer = z.infer<typeof RetrospectiveLayerSchema>;

// ─── 候选动作 ─────────────────────────────────────────────

export const RetrospectiveProposedActionSchema = z.enum([
  'PROMOTE_RULE',
  'ADJUST_POLICY',
  'QUARANTINE_PATTERN',
  'ESCALATE',
]);
export type RetrospectiveProposedAction = z.infer<typeof RetrospectiveProposedActionSchema>;

// ─── 严重程度 ─────────────────────────────────────────────

export const RetrospectiveSeveritySchema = z.enum([
  'INFO',
  'WARN',
  'ERROR',
]);
export type RetrospectiveSeverity = z.infer<typeof RetrospectiveSeveritySchema>;

// ─── Retrospective 候选 ───────────────────────────────────

export const RetrospectiveCandidateSchema = z.object({
  schema: z.literal('awkn-retrospective-candidate/v1'),
  candidateId: z.string().min(1),
  missionId: awknIdSchema('goal'),
  layer: RetrospectiveLayerSchema,
  workItemId: z.string().min(1),
  workItemType: z.string().min(1),
  summary: z.string().min(1),
  lessons: z.array(z.string().min(1)),
  evidenceReceiptIds: z.array(z.string().min(1)),
  proposedAction: RetrospectiveProposedActionSchema,
  severity: RetrospectiveSeveritySchema,
  generatedByActorId: z.string().min(1),
  generatedAt: UtcTimestampSchema,
}).strict();
export type RetrospectiveCandidate = z.infer<typeof RetrospectiveCandidateSchema>;

// ─── Retrospective Receipt Payload ────────────────────────

export const RetrospectiveReceiptPayloadSchema = z.object({
  schema: z.literal('awkn-retrospective-receipt/v1'),
  missionId: awknIdSchema('goal'),
  layer: RetrospectiveLayerSchema,
  workItemId: z.string().min(1),
  candidateIds: z.array(z.string().min(1)),
  verdict: z.enum(['PASS', 'PARTIAL', 'BLOCKED']),
  summary: z.string().min(1),
}).strict();
export type RetrospectiveReceiptPayload = z.infer<typeof RetrospectiveReceiptPayloadSchema>;

// ─── Evolution 状态（含 SHADOW 中间态）────────────────────
//
// 复盘候选的 evolution_status 列支持 SHADOW 阶段：
// DRAFT → VALIDATING → APPROVED → SHADOW → ACTIVE → QUARANTINED / RETIRED
// 现有 EvolutionLifecycle（evolve/lifecycle.ts）不含 SHADOW，
// SHADOW 由 retrospective-bridge 在复盘候选层独立跟踪。

export const RetrospectiveEvolutionStatusSchema = z.enum([
  'DRAFT',
  'VALIDATING',
  'APPROVED',
  'SHADOW',
  'ACTIVE',
  'QUARANTINED',
  'RETIRED',
]);
export type RetrospectiveEvolutionStatus = z.infer<typeof RetrospectiveEvolutionStatusSchema>;

// ─── 持久化行类型 ─────────────────────────────────────────

export interface RetrospectiveCandidateRow {
  candidate_id: string;
  mission_id: string;
  layer: string;
  work_item_id: string;
  work_item_type: string;
  summary: string;
  lessons_json: string;
  evidence_receipt_ids_json: string;
  proposed_action: string;
  severity: string;
  generated_by_actor_id: string;
  generated_at: string;
  evolution_status: string;
  previous_active_candidate_id: string | null;
  linked_evolution_candidate_id: string | null;
  created_at: string;
  updated_at: string;
}
