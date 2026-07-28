/**
 * Skill Compiler Contracts (Phase 6 / C04 / WP-AOS-07)
 *
 * 设计文档：`docs/agent-os-3.0/05-Policy-Skill-Compiler.md` v0.2 Draft 第 4、7.2、8 章
 *
 * 本文件冻结 Skill Compiler 的所有公开 Contract：
 * - SkillManifestSchema (awkn-skill/v2)：Skill 源定义
 * - SkillRefSchema：选中 Skill 引用
 * - RejectedSkillSchema：被拒绝 Skill
 * - SkillExecutionNodeSchema：执行图节点
 * - PreflightResultSchema：前置检查结果
 * - GateRefSchema：Gate 引用
 * - RecoveryActionSchema：恢复动作
 * - CompiledSkillBundleSchema (awkn-compiled-skill-bundle/v1)：Bundle 产物
 * - SkillScoreSchema：Skill 评分（第 8 章）
 *
 * 不变量：
 * - 所有 schema 使用 zod strict + superRefine
 * - 所有 hash 使用 stableHash
 * - 所有 ID 使用 createAwknId / awknIdSchema
 */

import { z } from 'zod';
import { awknIdSchema, createAwknId } from './ids.js';
import { SafePositiveIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-zA-Z.-]+)?(?:\+[0-9a-zA-Z.-]+)?$/;

// ===== 通用枚举 =====

/** Skill 状态生命周期（与 Policy 一致） */
export const SkillStatusSchema = z.enum([
  'DRAFT',
  'VALIDATING',
  'APPROVED',
  'ACTIVE',
  'QUARANTINED',
  'RETIRED',
]);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

/** Skill 触发器类型 */
export const SkillTriggerSchema = z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/i, 'trigger must be snake-case');
export type SkillTrigger = z.infer<typeof SkillTriggerSchema>;

/** Skill 工作流步骤类型 */
export const SkillWorkflowStepSchema = z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/i, 'step must be snake-case');
export type SkillWorkflowStep = z.infer<typeof SkillWorkflowStepSchema>;

/** Skill 前置检查类型 */
export const SkillPreflightTypeSchema = z.enum([
  'workspace_clean_or_declared',
  'acceptance_criteria_present',
  'required_tools_available',
  'context_loaded',
  'policy_bundle_frozen',
  'budget_allocated',
  'permissions_granted',
  'no_active_blockers',
]);
export type SkillPreflightType = z.infer<typeof SkillPreflightTypeSchema>;

/** Skill Gate 类型 */
export const SkillGateTypeSchema = z.enum([
  'typecheckGate',
  'testGate',
  'lintGate',
  'reviewGate',
  'qualityGate',
  'safetyGate',
  'acceptanceGate',
  'evidenceGate',
]);
export type SkillGateType = z.infer<typeof SkillGateTypeSchema>;

/** Skill 恢复动作类型 */
export const SkillRecoveryActionSchema = z.enum([
  'restore_checkpoint',
  'switch_strategy_after_repeat',
  'escalate_to_human',
  'rollback_to_legacy',
  'pause_and_ask',
  'abort_with_receipt',
]);
export type SkillRecoveryAction = z.infer<typeof SkillRecoveryActionSchema>;

/** Skill 输出类型 */
export const SkillOutputTypeSchema = z.enum([
  'artifact_bundle',
  'evidence_delta',
  'delivery_receipt',
  'audit_trail',
  'memory_candidate',
  'evolve_candidate',
]);
export type SkillOutputType = z.infer<typeof SkillOutputTypeSchema>;

// ===== Skill Capability Requirements =====

/** Skill 工具能力要求 */
export const SkillCapabilityRequirementSchema = z.object({
  tools: z.array(z.string().min(1)),
  capabilities: z.array(z.string().min(1)),
  context: z.array(z.string().min(1)),
}).strict();
export type SkillCapabilityRequirement = z.infer<typeof SkillCapabilityRequirementSchema>;

// ===== Skill Manifest (awkn-skill/v2) =====

/**
 * Skill Manifest Schema (awkn-skill/v2)
 *
 * 设计文档第 4 章。
 *
 * 注意：本 Schema 是 Skill 源定义，不含 Skill 自然语言内容。
 * Skill 自然语言内容由外置 Skill Root 提供，天枢只保存索引、版本、Hash、评测和使用 Receipt。
 */
export const SkillManifestSchema = z.object({
  schema: z.literal('awkn-skill/v2'),
  skillId: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/i, 'skillId must be kebab-case'),
  version: z.string().regex(SEMVER_PATTERN, 'version must be semver'),
  status: SkillStatusSchema,
  taskProfiles: z.array(z.enum([
    'analysis',
    'research',
    'engineering',
    'repository_review',
    'document_creation',
    'automation',
    'scheduled_check',
    'multi_agent_orchestration',
  ])).min(1),
  levels: z.array(z.enum(['L0', 'L1', 'L2', 'L3', 'L4'])).min(1),
  triggers: z.array(SkillTriggerSchema).min(1),
  requires: SkillCapabilityRequirementSchema,
  preflight: z.array(SkillPreflightTypeSchema),
  workflow: z.array(SkillWorkflowStepSchema).min(1),
  gates: z.array(SkillGateTypeSchema),
  recovery: z.array(SkillRecoveryActionSchema),
  outputs: z.array(SkillOutputTypeSchema).min(1),
  evalSuite: z.string().min(1),
  description: z.string().min(1),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  source: z.enum(['builtin', 'awkn_skills_root', 'evolve_candidate']),
  /** Skill 自然语言内容的 SHA256 hash（用于版本追踪） */
  contentHash: z.string().regex(SHA256_HEX_PATTERN),
}).strict().superRefine((value, context) => {
  if (value.updatedAt < value.createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt must be >= createdAt',
    });
  }
  // QUARANTINED/RETIRED Skill 不能 preflight 通过
  if ((value.status === 'QUARANTINED' || value.status === 'RETIRED')
    && value.preflight.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['preflight'],
      message: 'QUARANTINED/RETIRED skill must have empty preflight',
    });
  }
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ===== SkillRef =====

/** 选中 Skill 引用 */
export const SkillRefSchema = z.object({
  skillId: z.string().min(1),
  version: z.string().regex(SEMVER_PATTERN),
  score: z.number().min(0).max(1),
  selectedReason: z.string().min(1),
  contentHash: z.string().regex(SHA256_HEX_PATTERN),
}).strict();
export type SkillRef = z.infer<typeof SkillRefSchema>;

// ===== RejectedSkill =====

/** 被拒绝 Skill */
export const RejectedSkillSchema = z.object({
  skillId: z.string().min(1),
  version: z.string().regex(SEMVER_PATTERN),
  rejectedReason: z.string().min(1),
  rejectionCode: z.enum([
    'TRIGGER_MISMATCH',
    'PROFILE_MISMATCH',
    'LEVEL_MISMATCH',
    'PREFLIGHT_FAILED',
    'DEPENDENCY_MISSING',
    'COMPATIBILITY_RISK',
    'NOT_APPROVED',
    'QUARANTINED',
  ]),
}).strict();
export type RejectedSkill = z.infer<typeof RejectedSkillSchema>;

// ===== SkillExecutionNode =====

/** Skill 执行图节点 */
export const SkillExecutionNodeSchema = z.object({
  nodeId: z.string().min(1),
  skillId: z.string().min(1),
  step: SkillWorkflowStepSchema,
  dependsOn: z.array(z.string().min(1)),
  produces: z.array(z.string().min(1)),
  consumes: z.array(z.string().min(1)),
}).strict();
export type SkillExecutionNode = z.infer<typeof SkillExecutionNodeSchema>;

// ===== PreflightResult =====

/** 前置检查结果 */
export const PreflightResultSchema = z.object({
  preflightType: SkillPreflightTypeSchema,
  passed: z.boolean(),
  failureReason: z.string().optional(),
  evaluatedAt: UtcTimestampSchema,
}).strict();
export type PreflightResult = z.infer<typeof PreflightResultSchema>;

// ===== GateRef =====

/** Gate 引用 */
export const GateRefSchema = z.object({
  gateType: SkillGateTypeSchema,
  gateId: z.string().min(1),
  required: z.boolean(),
  blocking: z.boolean(),
}).strict();
export type GateRef = z.infer<typeof GateRefSchema>;

// ===== RecoveryAction =====

/** 恢复动作（运行时实例） */
export const RecoveryActionSchema = z.object({
  actionType: SkillRecoveryActionSchema,
  trigger: z.enum(['repeat_threshold', 'gate_failure', 'budget_exceeded', 'blocked']),
  repeatThreshold: SafePositiveIntegerSchema.optional(),
}).strict();
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

// ===== CompiledSkillBundle (awkn-compiled-skill-bundle/v1) =====

/**
 * 检测 executionGraph 中的环（DFS）.
 *
 * 返回所有检测到的环路径，每个环是一个 nodeId 数组（首尾相同）.
 * 例如: [['A','B','C','A']] 表示 A→B→C→A 形成环.
 */
function detectCycles(nodes: readonly SkillExecutionNode[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.nodeId, [...node.dependsOn]);
  }
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(nodeId: string): void {
    if (recursionStack.has(nodeId)) {
      // 找到环：从 path 中找到 nodeId 出现的位置，截取环
      const cycleStart = path.indexOf(nodeId);
      if (cycleStart >= 0) {
        const cycle = [...path.slice(cycleStart), nodeId];
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(nodeId)) return;

    visited.add(nodeId);
    recursionStack.add(nodeId);
    path.push(nodeId);

    const deps = adjacency.get(nodeId) ?? [];
    for (const dep of deps) {
      if (adjacency.has(dep)) {
        dfs(dep);
      }
    }

    path.pop();
    recursionStack.delete(nodeId);
  }

  for (const node of nodes) {
    if (!visited.has(node.nodeId)) {
      dfs(node.nodeId);
    }
  }

  return cycles;
}

/**
 * Compiled Skill Bundle Schema (awkn-compiled-skill-bundle/v1)
 *
 * 设计文档第 7.2 章。
 *
 * 不变量：
 * - bundleHash 由 stableHash 计算（排除 frozenAt）
 * - 如果 preflightResults 任一失败，selectedSkills 必须为空
 * - executionGraph 必须形成 DAG（无环）
 */
export const CompiledSkillBundleSchema = z.object({
  schema: z.literal('awkn-compiled-skill-bundle/v1'),
  bundleId: z.string().min(1).regex(/^sb_[0-9a-f]{32}$/),
  executionId: awknIdSchema('exec'),
  selectedSkills: z.array(SkillRefSchema),
  rejectedSkills: z.array(RejectedSkillSchema),
  executionGraph: z.array(SkillExecutionNodeSchema),
  preflightResults: z.array(PreflightResultSchema),
  gates: z.array(GateRefSchema),
  recoveryPlan: z.array(RecoveryActionSchema),
  compilerVersion: z.string().regex(/^awkn-skill-compiler\/v\d+$/, 'compilerVersion must be awkn-skill-compiler/v<n>'),
  bundleHash: z.string().regex(SHA256_HEX_PATTERN),
  frozenAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  // 如果 preflight 任一失败，selectedSkills 必须为空
  const hasPreflightFailure = value.preflightResults.some((p) => !p.passed);
  if (hasPreflightFailure && value.selectedSkills.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedSkills'],
      message: 'selectedSkills must be empty when any preflight fails',
    });
  }
  // 如果 selectedSkills 为空，executionGraph 必须为空
  if (value.selectedSkills.length === 0 && value.executionGraph.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executionGraph'],
      message: 'executionGraph must be empty when no selectedSkills',
    });
  }
  // 检查 executionGraph 形成无环 DAG
  // 1. 缺失依赖：dependsOn 引用的 nodeId 必须存在
  // 2. 自依赖：node 不能依赖自身
  // 3. 真实环：依赖链不能形成环
  const nodeIds = new Set(value.executionGraph.map((n) => n.nodeId));
  const missingDeps: string[] = [];
  const selfDeps: string[] = [];
  for (const node of value.executionGraph) {
    for (const depId of node.dependsOn) {
      if (!nodeIds.has(depId)) {
        missingDeps.push(`${node.nodeId}→${depId}`);
      }
      if (depId === node.nodeId) {
        selfDeps.push(node.nodeId);
      }
    }
  }
  if (missingDeps.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executionGraph'],
      message: `missing dependencies: ${missingDeps.join(', ')}`,
    });
  }
  if (selfDeps.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executionGraph'],
      message: `self-dependency detected: ${selfDeps.join(', ')}`,
    });
  }
  // 3. 真实环检测：DFS 检查依赖链是否形成环
  const cycles = detectCycles(value.executionGraph);
  if (cycles.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executionGraph'],
      message: `cycles detected: ${cycles.map((c) => c.join('→')).join('; ')}`,
    });
  }
});
export type CompiledSkillBundle = z.infer<typeof CompiledSkillBundleSchema>;

// ===== Bundle ID 生成 =====

/** Skill Bundle ID 前缀 */
export const SKILL_BUNDLE_ID_PREFIX = 'sb';

/**
 * 生成 Skill Bundle ID.
 *
 * @param contentHash 可选内容 Hash (SHA256 hex). 若提供，则基于内容 Hash 生成确定性 ID
 *   (相同内容产生相同 ID). 若不提供，则回退到随机 UUID.
 */
export function createSkillBundleId(contentHash?: string): string {
  if (contentHash && /^[0-9a-f]{64}$/.test(contentHash)) {
    return `${SKILL_BUNDLE_ID_PREFIX}_${contentHash.slice(0, 32)}`;
  }
  return createAwknId('skillBundle');
}

// ===== Skill Score（设计文档第 8 章） =====

/**
 * Skill Score Schema
 *
 * SkillScore =
 * 0.30 × TriggerMatch
 * + 0.20 × TaskProfileMatch
 * + 0.15 × LevelMatch
 * + 0.15 × HistoricalSuccess
 * + 0.10 × EvidenceQuality
 * + 0.10 × CostEfficiency
 * - 0.20 × CompatibilityRisk
 */
export const SkillScoreSchema = z.object({
  skillId: z.string().min(1),
  triggerMatch: z.number().min(0).max(1),
  taskProfileMatch: z.number().min(0).max(1),
  levelMatch: z.number().min(0).max(1),
  historicalSuccess: z.number().min(0).max(1),
  evidenceQuality: z.number().min(0).max(1),
  costEfficiency: z.number().min(0).max(1),
  compatibilityRisk: z.number().min(0).max(1),
  totalScore: z.number().min(0).max(1),
}).strict();
export type SkillScore = z.infer<typeof SkillScoreSchema>;

/** 计算 Skill 总分（按设计文档公式） */
export function computeSkillScore(input: Omit<SkillScore, 'totalScore'>): SkillScore {
  const totalScore = Math.max(0, Math.min(1,
    0.30 * input.triggerMatch
    + 0.20 * input.taskProfileMatch
    + 0.15 * input.levelMatch
    + 0.15 * input.historicalSuccess
    + 0.10 * input.evidenceQuality
    + 0.10 * input.costEfficiency
    - 0.20 * input.compatibilityRisk,
  ));
  return { ...input, totalScore };
}

// ===== Skill Bundle Hash 输入 =====

/**
 * Bundle Hash 计算输入（用于 stableHash）
 *
 * 排除 frozenAt（时间戳不影响内容 hash）
 */
export interface SkillBundleHashInput {
  readonly schema: 'awkn-compiled-skill-bundle/v1';
  readonly bundleId: string;
  readonly executionId: string;
  readonly selectedSkills: readonly SkillRef[];
  readonly rejectedSkills: readonly RejectedSkill[];
  readonly executionGraph: readonly SkillExecutionNode[];
  readonly preflightResults: readonly PreflightResult[];
  readonly gates: readonly GateRef[];
  readonly recoveryPlan: readonly RecoveryAction[];
  readonly compilerVersion: string;
}
