/**
 * Skill 契约 (Phase 6 / C04 / WP-AOS-07)
 *
 * 设计文档: `docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 4, 8, 9 节
 *
 * 职责:
 * - 声明 SkillManifest / CompiledSkillBundle / SkillScore / SkillExecutionNode schema
 * - 计算 Bundle 稳定哈希 (排除 bundleHash / frozenAt, stripUndefined)
 *
 * 设计原则:
 * - fail-closed: 不兼容 Skill 组合 / 缺少前置条件 → 阻断执行
 * - 版本冻结: bundleHash 由 stableHash(schemaId, value) 决定, 跨平台一致
 * - Skill 来源必须属于天枢外置 Skill Root 或天枢内置资产
 * - Skill 文本不能改写 Policy AST
 */

import { z } from 'zod';
import { stableHash } from './canonical-json.js';
import { awknIdSchema } from './ids.js';
import type { JsonValue } from './json-value.js';
import { SafeNonNegativeIntegerSchema, SafePositiveIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ===========================================================================
// Section 1: Skill Status & Source & Level
// ===========================================================================

/**
 * Skill 状态机 (设计文档第 14 节)
 *
 *   DRAFT → VALIDATING → APPROVED → ACTIVE → QUARANTINED / RETIRED
 */
export const SkillStatusSchema = z.enum([
  'DRAFT',
  'VALIDATING',
  'APPROVED',
  'ACTIVE',
  'QUARANTINED',
  'RETIRED',
]);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

/**
 * Skill 来源类型 (设计文档第 11 节 Registry 边界)
 *
 * 允许注册:
 * - builtin: 天枢内置 Skill
 * - skillsRoot: AWKN_SKILLS_ROOT 指向的天枢 Skill 资产
 *
 * 禁止注册: gundam, value, hotel, mr-mont, annie, subtitle 等其他业务仓库 Skill
 */
export const SkillSourceSchema = z.enum(['builtin', 'skillsRoot']);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const SkillLevelSchema = z.enum(['L1', 'L2', 'L3', 'L4']);
export type SkillLevel = z.infer<typeof SkillLevelSchema>;

// ===========================================================================
// Section 2: Skill Manifest (设计文档第 4 节 awkn-skill/v2)
// ===========================================================================

export const SKILL_MANIFEST_SCHEMA_ID = 'awkn-skill/v2';

export const SkillRequiresSchema = z.object({
  tools: z.array(z.string().min(1)),
  capabilities: z.array(z.string().min(1)),
  context: z.array(z.string().min(1)),
}).strict();
export type SkillRequires = z.infer<typeof SkillRequiresSchema>;

/**
 * Skill Manifest (awkn-skill/v2)
 *
 * 设计文档第 4 节:
 * ```yaml
 * schema: awkn-skill/v2
 * skillId: awkn-engineering-fix-loop
 * version: 2.0.0
 * status: ACTIVE
 * taskProfiles: [engineering]
 * levels: [L2]
 * triggers: [build_failure, test_failure]
 * requires: { tools, capabilities, context }
 * preflight: [...]
 * workflow: [...]
 * gates: [...]
 * recovery: [...]
 * outputs: [...]
 * evalSuite: engineering-fix-loop-v2
 * ```
 */
export const SkillManifestSchema = z.object({
  schema: z.literal(SKILL_MANIFEST_SCHEMA_ID),
  skillId: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver x.y.z'),
  status: SkillStatusSchema,
  source: SkillSourceSchema,
  taskProfiles: z.array(z.string().min(1)).min(1),
  levels: z.array(SkillLevelSchema).min(1),
  triggers: z.array(z.string().min(1)),
  requires: SkillRequiresSchema,
  preflight: z.array(z.string().min(1)),
  workflow: z.array(z.string().min(1)).min(1),
  gates: z.array(z.string().min(1)),
  recovery: z.array(z.string().min(1)),
  outputs: z.array(z.string().min(1)),
  evalSuite: z.string().min(1),
}).strict();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ===========================================================================
// Section 3: Skill Ref (引用, 用于 Bundle)
// ===========================================================================

/**
 * SkillRef - 对 Skill 的稳定引用 (设计文档第 13 节 SkillsManager 输出 SkillRef)
 */
export const SkillRefSchema = z.object({
  schema: z.literal('awkn-skill-ref/v1'),
  skillId: z.string().min(1),
  version: z.string().min(1),
  source: SkillSourceSchema,
  contentHash: z.string().regex(SHA256_HEX_PATTERN),
}).strict();
export type SkillRef = z.infer<typeof SkillRefSchema>;

/**
 * 被拒绝的 Skill (含拒绝原因)
 */
export const RejectedSkillSchema = z.object({
  schema: z.literal('awkn-rejected-skill/v1'),
  skillId: z.string().min(1),
  version: z.string().min(1),
  reasonCodes: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
}).strict();
export type RejectedSkill = z.infer<typeof RejectedSkillSchema>;

// ===========================================================================
// Section 4: Skill Score (设计文档第 8 节)
// ===========================================================================

/**
 * SkillScore (设计文档第 8 节)
 *
 * SkillScore =
 *   0.30 × TriggerMatch
 * + 0.20 × TaskProfileMatch
 * + 0.15 × LevelMatch
 * + 0.15 × HistoricalSuccess
 * + 0.10 × EvidenceQuality
 * + 0.10 × CostEfficiency
 * - 0.20 × CompatibilityRisk
 */
export const SkillScoreSchema = z.object({
  schema: z.literal('awkn-skill-score/v1'),
  skillId: z.string().min(1),
  triggerMatch: z.number().min(0).max(1),
  taskProfileMatch: z.number().min(0).max(1),
  levelMatch: z.number().min(0).max(1),
  historicalSuccess: z.number().min(0).max(1),
  evidenceQuality: z.number().min(0).max(1),
  costEfficiency: z.number().min(0).max(1),
  compatibilityRisk: z.number().min(0).max(1),
  total: z.number().min(-1).max(1.5),
  reasonCodes: z.array(z.string().min(1)),
}).strict();
export type SkillScore = z.infer<typeof SkillScoreSchema>;

export const SKILL_SCORE_WEIGHTS = {
  triggerMatch: 0.30,
  taskProfileMatch: 0.20,
  levelMatch: 0.15,
  historicalSuccess: 0.15,
  evidenceQuality: 0.10,
  costEfficiency: 0.10,
  compatibilityRisk: -0.20,
} as const;

export function computeSkillScore(input: {
  skillId: string;
  triggerMatch: number;
  taskProfileMatch: number;
  levelMatch: number;
  historicalSuccess: number;
  evidenceQuality: number;
  costEfficiency: number;
  compatibilityRisk: number;
  reasonCodes?: string[];
}): SkillScore {
  const total =
    SKILL_SCORE_WEIGHTS.triggerMatch * input.triggerMatch +
    SKILL_SCORE_WEIGHTS.taskProfileMatch * input.taskProfileMatch +
    SKILL_SCORE_WEIGHTS.levelMatch * input.levelMatch +
    SKILL_SCORE_WEIGHTS.historicalSuccess * input.historicalSuccess +
    SKILL_SCORE_WEIGHTS.evidenceQuality * input.evidenceQuality +
    SKILL_SCORE_WEIGHTS.costEfficiency * input.costEfficiency +
    SKILL_SCORE_WEIGHTS.compatibilityRisk * input.compatibilityRisk;
  return {
    schema: 'awkn-skill-score/v1',
    skillId: input.skillId,
    triggerMatch: input.triggerMatch,
    taskProfileMatch: input.taskProfileMatch,
    levelMatch: input.levelMatch,
    historicalSuccess: input.historicalSuccess,
    evidenceQuality: input.evidenceQuality,
    costEfficiency: input.costEfficiency,
    compatibilityRisk: input.compatibilityRisk,
    total,
    reasonCodes: input.reasonCodes ?? [],
  };
}

// ===========================================================================
// Section 5: Skill Execution Graph (设计文档第 7.2 节)
// ===========================================================================

/**
 * Skill Execution Node (设计文档第 7.2 节 executionGraph)
 */
export const SkillExecutionNodeSchema = z.object({
  schema: z.literal('awkn-skill-execution-node/v1'),
  nodeId: z.string().min(1),
  skillRef: SkillRefSchema,
  stepName: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),
  inputs: z.array(z.string().min(1)),
  outputs: z.array(z.string().min(1)),
  gates: z.array(z.string().min(1)),
}).strict();
export type SkillExecutionNode = z.infer<typeof SkillExecutionNodeSchema>;

/**
 * Preflight 结果 (设计文档第 7.2 节 preflightResults)
 */
export const PreflightResultSchema = z.object({
  schema: z.literal('awkn-preflight-result/v1'),
  skillId: z.string().min(1),
  checkName: z.string().min(1),
  passed: z.boolean(),
  reason: z.string().min(1),
  reasonCodes: z.array(z.string().min(1)),
}).strict();
export type PreflightResult = z.infer<typeof PreflightResultSchema>;

/**
 * Gate 引用 (设计文档第 7.2 节 gates)
 */
export const GateRefSchema = z.object({
  schema: z.literal('awkn-gate-ref/v1'),
  gateType: z.string().min(1),
  gateId: z.string().min(1),
  skillId: z.string().min(1),
  blocking: z.boolean(),
}).strict();
export type GateRef = z.infer<typeof GateRefSchema>;

/**
 * Recovery Action (设计文档第 7.2 节 recoveryPlan)
 */
export const RecoveryActionSchema = z.object({
  schema: z.literal('awkn-recovery-action/v1'),
  skillId: z.string().min(1),
  actionName: z.string().min(1),
  trigger: z.enum(['preflight_failed', 'gate_failed', 'execution_error', 'compatibility_conflict']),
  steps: z.array(z.string().min(1)).min(1),
}).strict();
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

// ===========================================================================
// Section 6: Compiled Skill Bundle (设计文档第 7.2 节)
// ===========================================================================

export const COMPILED_SKILL_BUNDLE_SCHEMA_ID = 'awkn-compiled-skill-bundle/v1';

export const CompiledSkillBundleSchema = z.object({
  schema: z.literal(COMPILED_SKILL_BUNDLE_SCHEMA_ID),
  bundleId: awknIdSchema('sb'),
  executionId: awknIdSchema('exec'),
  selectedSkills: z.array(SkillRefSchema),
  rejectedSkills: z.array(RejectedSkillSchema),
  executionGraph: z.array(SkillExecutionNodeSchema),
  preflightResults: z.array(PreflightResultSchema),
  gates: z.array(GateRefSchema),
  recoveryPlan: z.array(RecoveryActionSchema),
  bundleHash: z.string().regex(SHA256_HEX_PATTERN),
  frozenAt: UtcTimestampSchema,
}).strict();
export type CompiledSkillBundle = z.infer<typeof CompiledSkillBundleSchema>;

// ===========================================================================
// Section 7: Bundle Hash
// ===========================================================================

/**
 * 深度剥离 undefined 字段 (递归处理对象和数组).
 */
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

/**
 * 计算 CompiledSkillBundle 的稳定哈希 (跨平台一致).
 *
 * 排除 bundleHash / frozenAt 以保证幂等性.
 * 在哈希前剥离 undefined optional 字段以符合 canonical JSON 规范.
 */
export function computeSkillBundleHash(
  bundle: Omit<CompiledSkillBundle, 'bundleHash' | 'frozenAt'>,
): string {
  const stripped = stripUndefined(bundle as unknown as JsonValue);
  return stableHash(COMPILED_SKILL_BUNDLE_SCHEMA_ID, stripped);
}

// ===========================================================================
// Section 8: Skill Evaluation (设计文档第 9 节 历史评测结果)
// ===========================================================================

/**
 * Skill 评测记录 (用于 SkillScore.historicalSuccess)
 */
export const SkillEvaluationRecordSchema = z.object({
  schema: z.literal('awkn-skill-evaluation/v1'),
  skillId: z.string().min(1),
  evalSuite: z.string().min(1),
  totalRuns: SafeNonNegativeIntegerSchema,
  successfulRuns: SafeNonNegativeIntegerSchema,
  successRate: z.number().min(0).max(1),
  evidenceQualityScore: z.number().min(0).max(1),
  costEfficiencyScore: z.number().min(0).max(1),
  lastEvaluatedAt: UtcTimestampSchema,
}).strict();
export type SkillEvaluationRecord = z.infer<typeof SkillEvaluationRecordSchema>;

// ===========================================================================
// Section 9: Skill Compatibility (设计文档第 8 节 强制规则)
// ===========================================================================

/**
 * Skill 兼容性检查结果
 *
 * 用于判断多个 Skill 组合是否兼容 (设计文档第 8 节 多个 Skill 组合需要依赖图和输入输出匹配).
 */
export const SkillCompatibilityResultSchema = z.object({
  schema: z.literal('awkn-skill-compatibility/v1'),
  skillIds: z.array(z.string().min(1)).min(2),
  compatible: z.boolean(),
  conflictReason: z.string().optional(),
  sharedInputs: z.array(z.string().min(1)),
  sharedOutputs: z.array(z.string().min(1)),
}).strict();
export type SkillCompatibilityResult = z.infer<typeof SkillCompatibilityResultSchema>;

// ===========================================================================
// Section 10: Schema IDs 常量
// ===========================================================================

export const SKILL_REF_SCHEMA_ID = 'awkn-skill-ref/v1';
export const REJECTED_SKILL_SCHEMA_ID = 'awkn-rejected-skill/v1';
export const SKILL_SCORE_SCHEMA_ID = 'awkn-skill-score/v1';
export const SKILL_EXECUTION_NODE_SCHEMA_ID = 'awkn-skill-execution-node/v1';
export const PREFLIGHT_RESULT_SCHEMA_ID = 'awkn-preflight-result/v1';
export const GATE_REF_SCHEMA_ID = 'awkn-gate-ref/v1';
export const RECOVERY_ACTION_SCHEMA_ID = 'awkn-recovery-action/v1';
export const SKILL_EVALUATION_SCHEMA_ID = 'awkn-skill-evaluation/v1';
export const SKILL_COMPATIBILITY_SCHEMA_ID = 'awkn-skill-compatibility/v1';

export type { SafePositiveIntegerSchema };
