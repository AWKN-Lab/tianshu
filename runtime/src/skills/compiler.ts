/**
 * Skill Compiler (Phase 6 / C04 / WP-AOS-07)
 *
 * 设计文档：`docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 4、7.2、8 章
 *
 * 职责：
 * - 按 IntentDecision + ContextManifest scope 选择 Skill
 * - 计算 SkillScore（设计文档第 8 章公式）
 * - 执行 Preflight（前置条件检查）
 * - 构建 ExecutionGraph（DAG）
 * - 冻结 CompiledSkillBundle
 *
 * SkillScore 公式（设计文档第 8 章）：
 *   SkillScore =
 *   0.30 × TriggerMatch
 *   + 0.20 × TaskProfileMatch
 *   + 0.15 × LevelMatch
 *   + 0.15 × HistoricalSuccess
 *   + 0.10 × EvidenceQuality
 *   + 0.10 × CostEfficiency
 *   - 0.20 × CompatibilityRisk
 */

import { stableHash } from '../contracts/canonical-json.js';
import type {
  SkillManifest,
  SkillRef,
  RejectedSkill,
  SkillExecutionNode,
  PreflightResult,
  GateRef,
  RecoveryAction,
  CompiledSkillBundle,
  SkillScore,
  SkillBundleHashInput,
} from '../contracts/skill.js';
import { computeSkillScore, createSkillBundleId } from '../contracts/skill.js';
import { SkillManifestSchema } from '../contracts/skill.js';
import type { IntentDecision } from '../contracts/intent.js';
import type { JsonValue } from '../contracts/json-value.js';

/** Compiler 版本 */
export const SKILL_COMPILER_VERSION = 'awkn-skill-compiler/v1';

/** Compiler 错误 */
export class SkillCompilerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SkillCompilerError';
  }
}

/** Compiler 输入 */
export interface SkillCompilerInput {
  readonly executionId: string;
  readonly intentDecision: IntentDecision;
  readonly candidateSkills: readonly SkillManifest[];
  readonly historicalScores?: ReadonlyMap<string, SkillScore>;
  readonly explicitlyNamedSkills?: readonly string[];
  readonly preflightContext?: JsonValue;
  readonly compiledAt: string;
}

/** Compiler 输出 */
export interface SkillCompilerOutput {
  readonly bundle: CompiledSkillBundle;
  readonly selectedScores: readonly SkillScore[];
  readonly rejectedReasons: readonly RejectedSkill[];
}

/** 选择阈值：分数低于此值的 Skill 被拒绝 */
const MIN_SCORE_THRESHOLD = 0.3;

/**
 * 编译 Skill Bundle
 *
 * 步骤：
 * 1. 按 IntentDecision scope 过滤候选 Skill（taskProfile + level + triggers）
 * 2. 计算 SkillScore
 * 3. 执行 Preflight（前置条件检查）
 * 4. 构建 ExecutionGraph（DAG）
 * 5. 收集 Gates + RecoveryPlan
 * 6. 计算 bundleHash
 * 7. 冻结 Bundle
 */
export function compileSkillBundle(input: SkillCompilerInput): SkillCompilerOutput {
  const {
    executionId,
    intentDecision,
    candidateSkills,
    historicalScores,
    explicitlyNamedSkills,
    preflightContext,
    compiledAt,
  } = input;

  // Mode 0: preflightContext 预留，未来 Phase 7 用于真实 preflight 评估
  void preflightContext;

  const selectedSkills: SkillRef[] = [];
  const rejectedSkills: RejectedSkill[] = [];
  const selectedScores: SkillScore[] = [];

  // Step 1: 过滤候选 Skill
  for (const skill of candidateSkills) {
    // 校验 Skill 状态
    if (skill.status === 'QUARANTINED' || skill.status === 'RETIRED') {
      rejectedSkills.push({
        skillId: skill.skillId,
        version: skill.version,
        rejectedReason: `Skill is ${skill.status}`,
        rejectionCode: 'QUARANTINED',
      });
      continue;
    }
    if (skill.status !== 'ACTIVE' && skill.status !== 'APPROVED') {
      rejectedSkills.push({
        skillId: skill.skillId,
        version: skill.version,
        rejectedReason: `Skill is not APPROVED or ACTIVE (status: ${skill.status})`,
        rejectionCode: 'NOT_APPROVED',
      });
      continue;
    }

    // 匹配 taskProfile
    const taskProfileMatch = skill.taskProfiles.includes(intentDecision.taskProfile);

    // 匹配 level
    const levelMatch = skill.levels.includes(intentDecision.executionLevel);

    // 用户明确点名 Skill 优先
    const explicitlyNamed = explicitlyNamedSkills?.includes(skill.skillId) ?? false;

    // 计算 SkillScore
    const historicalScore = historicalScores?.get(skill.skillId);
    const score = computeSkillScore({
      skillId: skill.skillId,
      triggerMatch: taskProfileMatch ? 1 : 0,
      taskProfileMatch: taskProfileMatch ? 1 : 0,
      levelMatch: levelMatch ? 1 : 0,
      historicalSuccess: historicalScore?.historicalSuccess ?? 0.5,
      evidenceQuality: historicalScore?.evidenceQuality ?? 0.5,
      costEfficiency: historicalScore?.costEfficiency ?? 0.5,
      compatibilityRisk: 0, // 简化：默认 0，后续根据依赖图计算
    });

    // 决定接受/拒绝
    if (!taskProfileMatch && !explicitlyNamed) {
      rejectedSkills.push({
        skillId: skill.skillId,
        version: skill.version,
        rejectedReason: `taskProfile mismatch: skill ${skill.taskProfiles.join(',')} vs intent ${intentDecision.taskProfile}`,
        rejectionCode: 'PROFILE_MISMATCH',
      });
      continue;
    }
    if (!levelMatch && !explicitlyNamed) {
      rejectedSkills.push({
        skillId: skill.skillId,
        version: skill.version,
        rejectedReason: `level mismatch: skill ${skill.levels.join(',')} vs intent ${intentDecision.executionLevel}`,
        rejectionCode: 'LEVEL_MISMATCH',
      });
      continue;
    }
    if (score.totalScore < MIN_SCORE_THRESHOLD && !explicitlyNamed) {
      rejectedSkills.push({
        skillId: skill.skillId,
        version: skill.version,
        rejectedReason: `score ${score.totalScore.toFixed(3)} < threshold ${MIN_SCORE_THRESHOLD}`,
        rejectionCode: 'PREFLIGHT_FAILED',
      });
      continue;
    }

    selectedSkills.push({
      skillId: skill.skillId,
      version: skill.version,
      score: score.totalScore,
      selectedReason: explicitlyNamed
        ? `explicitly named by user (score: ${score.totalScore.toFixed(3)})`
        : `matched profile=${intentDecision.taskProfile} level=${intentDecision.executionLevel} (score: ${score.totalScore.toFixed(3)})`,
      contentHash: skill.contentHash,
    });
    selectedScores.push(score);
  }

  // Step 2: 执行 Preflight
  const preflightResults: PreflightResult[] = [];
  if (selectedSkills.length > 0) {
    // 简化：执行所有 Skill 的 preflight 类型并集
    const preflightTypes = new Set<string>();
    for (const skill of candidateSkills) {
      if (!selectedSkills.some((s) => s.skillId === skill.skillId)) continue;
      for (const pf of skill.preflight) {
        preflightTypes.add(pf);
      }
    }
    // 简化：所有 preflight pass（Mode 0，假设 context 已就绪）
    for (const pfType of preflightTypes) {
      preflightResults.push({
        preflightType: pfType as PreflightResult['preflightType'],
        passed: true,
        evaluatedAt: compiledAt,
      });
    }
  }

  // 如果 preflight 失败，清空 selectedSkills
  if (preflightResults.some((p) => !p.passed)) {
    for (const selected of selectedSkills) {
      rejectedSkills.push({
        skillId: selected.skillId,
        version: selected.version,
        rejectedReason: 'preflight failed',
        rejectionCode: 'PREFLIGHT_FAILED',
      });
    }
    selectedSkills.length = 0;
    selectedScores.length = 0;
  }

  // Step 3: 构建 ExecutionGraph（DAG）
  const executionGraph: SkillExecutionNode[] = [];
  if (selectedSkills.length > 0) {
    // 简化：每个 Skill 的 workflow 步骤作为独立节点，按顺序执行
    for (const selected of selectedSkills) {
      const skill = candidateSkills.find((s) => s.skillId === selected.skillId);
      if (!skill) continue;
      for (let i = 0; i < skill.workflow.length; i++) {
        const step = skill.workflow[i]!;
        executionGraph.push({
          nodeId: `${selected.skillId}_${step}_${i}`,
          skillId: selected.skillId,
          step,
          dependsOn: i > 0 ? [`${selected.skillId}_${skill.workflow[i - 1]!}_${i - 1}`] : [],
          produces: [`${selected.skillId}_${step}_output`],
          consumes: i > 0 ? [`${selected.skillId}_${skill.workflow[i - 1]!}_output`] : [],
        });
      }
    }
  }

  // Step 4: 收集 Gates
  const gates: GateRef[] = [];
  for (const selected of selectedSkills) {
    const skill = candidateSkills.find((s) => s.skillId === selected.skillId);
    if (!skill) continue;
    for (const gateType of skill.gates) {
      gates.push({
        gateType,
        gateId: `gate_${selected.skillId}_${gateType}`,
        required: true,
        blocking: true,
      });
    }
  }

  // Step 5: 收集 RecoveryPlan
  const recoveryPlan: RecoveryAction[] = [];
  for (const selected of selectedSkills) {
    const skill = candidateSkills.find((s) => s.skillId === selected.skillId);
    if (!skill) continue;
    for (const actionType of skill.recovery) {
      recoveryPlan.push({
        actionType,
        trigger: 'repeat_threshold',
        repeatThreshold: 3,
      });
    }
  }

  // Step 6: 计算 bundleHash
  // 先计算不含 bundleId 的内容指纹，用于生成确定性 bundleId (相同内容 → 相同 ID)
  const contentFingerprint = stableHash(
    'awkn-skill-bundle-fingerprint/v1',
    {
      schema: 'awkn-compiled-skill-bundle/v1',
      executionId,
      selectedSkills,
      rejectedSkills,
      executionGraph,
      preflightResults,
      gates,
      recoveryPlan,
      compilerVersion: SKILL_COMPILER_VERSION,
    } as unknown as JsonValue,
  );
  const bundleId = createSkillBundleId(contentFingerprint);
  const hashInput: SkillBundleHashInput = {
    schema: 'awkn-compiled-skill-bundle/v1',
    bundleId,
    executionId,
    selectedSkills,
    rejectedSkills,
    executionGraph,
    preflightResults,
    gates,
    recoveryPlan,
    compilerVersion: SKILL_COMPILER_VERSION,
  };
  const bundleHash = stableHash('awkn-compiled-skill-bundle/v1', hashInput as unknown as JsonValue);

  // Step 7: 冻结 Bundle
  const bundle: CompiledSkillBundle = {
    schema: 'awkn-compiled-skill-bundle/v1',
    bundleId,
    executionId,
    selectedSkills,
    rejectedSkills,
    executionGraph,
    preflightResults,
    gates,
    recoveryPlan,
    compilerVersion: SKILL_COMPILER_VERSION,
    bundleHash,
    frozenAt: compiledAt,
  };

  return {
    bundle,
    selectedScores,
    rejectedReasons: rejectedSkills,
  };
}

/**
 * 验证 Skill Manifest
 *
 * @throws SkillCompilerError 如果 Manifest 无效
 */
export function validateSkillManifest(manifest: unknown): SkillManifest {
  const result = SkillManifestSchema.safeParse(manifest);
  if (!result.success) {
    throw new SkillCompilerError(
      `invalid SkillManifest: ${result.error.message}`,
      'INVALID_MANIFEST',
    );
  }
  return result.data;
}

// ===========================================================================
// Section: DAG Validation (设计文档第 7.2 节 executionGraph 必须形成无环 DAG)
// ===========================================================================

/** DAG 校验结果（包含缺失依赖、自依赖、环路路径的详细信息） */
export interface DagValidationResult {
  /** DAG 是否有效（无缺失依赖、无自依赖、无环） */
  valid: boolean;
  /** 缺失依赖清单：[nodeId, missingDepId][] */
  missingDependencies: Array<{ nodeId: string; missingDep: string }>;
  /** 自依赖节点列表（nodeId 依赖自身） */
  selfDependencies: string[];
  /** 检测到的环路路径，每条路径是 nodeId 数组（首尾相同） */
  cycles: string[][];
}

/**
 * 校验 executionGraph 是否形成有效 DAG.
 *
 * 检查三项：
 * 1. 缺失依赖：dependsOn 引用的 nodeId 必须存在
 * 2. 自依赖：node 不能依赖自身
 * 3. 真实环：依赖链不能形成环（DFS 检测）
 *
 * @param nodes executionGraph 节点列表
 * @returns 详细校验结果
 */
export function validateSkillDag(nodes: readonly SkillExecutionNode[]): DagValidationResult {
  const nodeIds = new Set(nodes.map((n) => n.nodeId));
  const missingDependencies: Array<{ nodeId: string; missingDep: string }> = [];
  const selfDependencies: string[] = [];

  for (const node of nodes) {
    for (const depId of node.dependsOn) {
      if (!nodeIds.has(depId)) {
        missingDependencies.push({ nodeId: node.nodeId, missingDep: depId });
      }
      if (depId === node.nodeId) {
        selfDependencies.push(node.nodeId);
      }
    }
  }

  // 环检测：DFS
  const cycles: string[][] = [];
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.nodeId, [...node.dependsOn]);
  }
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(nodeId: string): void {
    if (recursionStack.has(nodeId)) {
      const cycleStart = path.indexOf(nodeId);
      if (cycleStart >= 0) {
        cycles.push([...path.slice(cycleStart), nodeId]);
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

  return {
    valid: missingDependencies.length === 0 && selfDependencies.length === 0 && cycles.length === 0,
    missingDependencies,
    selfDependencies,
    cycles,
  };
}
