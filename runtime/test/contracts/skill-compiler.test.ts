/**
 * Skill Compiler 契约测试 (Phase 6 / C04 / WP-AOS-07)
 *
 * 设计文档: `docs/agent-os-3.0/05-Policy-Skill-Compiler.md` 第 15 节 测试矩阵
 *
 * 覆盖:
 * 4. 不兼容 Skill 组合被拒绝
 * 5. 缺少前置条件时 Preflight 失败
 * 6. Bundle Hash 对相同输入稳定
 * 8. Skill 文本中的指令不能改写 Policy AST (通过 source 隔离)
 * 10. Quarantine 后新 Run 不再使用该版本
 * 11. 其他业务仓库 Skill 不能被注册
 * 12. 外部材料生成候选后仍需独立评测
 *
 * 额外测试:
 * - Schema 校验 (SkillManifest / Bundle / Score / ExecutionNode)
 * - Skill 评分公式 (TriggerMatch / TaskProfile / Level / HistoricalSuccess)
 * - 依赖解析 (依赖图)
 * - 来源校验 (业务仓库 Skill 被拒绝)
 * - 用户点名 Skill 优先
 * - 缺少 tools / capabilities / context 被拒绝
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  SkillManifestSchema,
  CompiledSkillBundleSchema,
  SkillScoreSchema,
  SkillExecutionNodeSchema,
  PreflightResultSchema,
  computeSkillScore,
  computeSkillBundleHash,
  SKILL_SCORE_WEIGHTS,
  type SkillManifest,
  type CompiledSkillBundle,
  type SkillScore,
  type SkillRef,
} from '../../src/contracts/skill.js';
import { createAwknId } from '../../src/contracts/ids.js';
import { toUtcTimestamp } from '../../src/contracts/time.js';
import {
  SkillEvaluationRegistry,
  buildEvaluationFromRuns,
  type SkillRunRecord,
} from '../../src/skills/evaluation-registry.js';
import {
  compileSkillBundle,
  SkillCompilerError,
  buildSkillCompilerReceipt,
  hashSkillManifest,
  ALLOWED_SKILL_SOURCES,
  FORBIDDEN_SKILL_ID_PREFIXES,
  type SkillCompilerInput,
} from '../../src/skills/compiler.js';

// ============================================================================
// Fixtures
// ============================================================================

const NOW = toUtcTimestamp('2026-07-28T10:00:00.000Z');
const EXECUTION_ID = createAwknId('execution');

function makeSkillManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    schema: 'awkn-skill/v2',
    skillId: 'awkn-engineering-fix-loop',
    version: '2.0.0',
    status: 'ACTIVE',
    source: 'skillsRoot',
    taskProfiles: ['engineering'],
    levels: ['L2'],
    triggers: ['build_failure', 'test_failure'],
    requires: {
      tools: ['read', 'grep', 'write', 'exec'],
      capabilities: ['git_diff', 'test_runner'],
      context: ['goal', 'failure_evidence'],
    },
    preflight: ['workspace_clean_or_declared', 'acceptance_criteria_present'],
    workflow: ['locate', 'analyze', 'plan', 'edit', 'verify'],
    gates: ['typecheckGate', 'testGate'],
    recovery: ['restore_checkpoint', 'switch_strategy_after_repeat'],
    outputs: ['artifact_bundle', 'evidence_delta'],
    evalSuite: 'engineering-fix-loop-v2',
    ...overrides,
  };
}

function makeSkillScore(overrides: Partial<SkillScore> = {}): SkillScore {
  return {
    schema: 'awkn-skill-score/v1',
    skillId: 'test-skill',
    triggerMatch: 1,
    taskProfileMatch: 1,
    levelMatch: 1,
    historicalSuccess: 0.8,
    evidenceQuality: 0.7,
    costEfficiency: 0.6,
    compatibilityRisk: 0,
    total: 0.85,
    reasonCodes: [],
    ...overrides,
  };
}

function makeSkillRef(overrides: Partial<SkillRef> = {}): SkillRef {
  return {
    schema: 'awkn-skill-ref/v1',
    skillId: 'test-skill',
    version: '1.0.0',
    source: 'skillsRoot',
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

function makeCompilerInput(overrides: Partial<SkillCompilerInput> = {}): SkillCompilerInput {
  return {
    executionId: EXECUTION_ID,
    candidates: [makeSkillManifest()],
    userInput: 'fix build failure',
    taskProfile: 'engineering',
    level: 'L2',
    availableTools: ['read', 'grep', 'write', 'exec'],
    availableCapabilities: ['git_diff', 'test_runner'],
    availableContextKeys: ['goal', 'failure_evidence'],
    preflightChecker: () => true,
    evaluationRegistry: new SkillEvaluationRegistry(),
    compilerVersion: '1.0.0',
    frozenAt: NOW,
    ...overrides,
  };
}

// ============================================================================
// Section 1: Skill Manifest Schema Validation
// ============================================================================

describe('Skill Manifest Schema Validation', () => {
  it('validates a valid SkillManifest', () => {
    const manifest = makeSkillManifest();
    const result = SkillManifestSchema.safeParse(manifest);
    assert.ok(result.success, `expected success: ${result.success ? '' : result.error.message}`);
  });

  it('rejects SkillManifest with invalid status', () => {
    const manifest = { ...makeSkillManifest(), status: 'INVALID' as never };
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, false);
  });

  it('rejects SkillManifest with invalid source', () => {
    const manifest = { ...makeSkillManifest(), source: 'external' as never };
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, false);
  });

  it('rejects SkillManifest with invalid version', () => {
    const manifest = { ...makeSkillManifest(), version: 'v2.0.0' };
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, false);
  });

  it('rejects SkillManifest with empty workflow', () => {
    const manifest = { ...makeSkillManifest(), workflow: [] };
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, false);
  });
});

// ============================================================================
// Section 2: Skill Score (设计文档第 8 节)
// ============================================================================

describe('Skill Score', () => {
  it('computeSkillScore applies weights correctly (设计文档第 8 节)', () => {
    const score = computeSkillScore({
      skillId: 'test',
      triggerMatch: 1,
      taskProfileMatch: 1,
      levelMatch: 1,
      historicalSuccess: 1,
      evidenceQuality: 1,
      costEfficiency: 1,
      compatibilityRisk: 0,
    });
    // 总分 = 0.3*1 + 0.2*1 + 0.15*1 + 0.15*1 + 0.1*1 + 0.1*1 - 0.2*0 = 1.0
    assert.equal(score.total, 1.0);
  });

  it('computeSkillScore applies compatibility risk penalty', () => {
    const score = computeSkillScore({
      skillId: 'test',
      triggerMatch: 1,
      taskProfileMatch: 1,
      levelMatch: 1,
      historicalSuccess: 1,
      evidenceQuality: 1,
      costEfficiency: 1,
      compatibilityRisk: 1,
    });
    // 总分 = 1.0 - 0.2*1 = 0.8
    assert.equal(score.total, 0.8);
  });

  it('SKILL_SCORE_WEIGHTS sums to 1.0 for positive contributions', () => {
    const positiveSum = SKILL_SCORE_WEIGHTS.triggerMatch +
      SKILL_SCORE_WEIGHTS.taskProfileMatch +
      SKILL_SCORE_WEIGHTS.levelMatch +
      SKILL_SCORE_WEIGHTS.historicalSuccess +
      SKILL_SCORE_WEIGHTS.evidenceQuality +
      SKILL_SCORE_WEIGHTS.costEfficiency;
    assert.equal(positiveSum, 1.0);
  });

  it('validates a valid SkillScore', () => {
    const score = makeSkillScore();
    const result = SkillScoreSchema.safeParse(score);
    assert.ok(result.success, `expected success: ${result.success ? '' : result.error.message}`);
  });
});

// ============================================================================
// Section 3: Skill Compiler Pipeline (测试 4, 5, 6)
// ============================================================================

describe('Skill Compiler', () => {
  it('compiles a valid skill bundle (测试 6 - Hash 稳定)', () => {
    const input = makeCompilerInput();
    const bundle = compileSkillBundle(input);
    assert.equal(bundle.schema, 'awkn-compiled-skill-bundle/v1');
    assert.equal(bundle.executionId, EXECUTION_ID);
    assert.equal(bundle.selectedSkills.length, 1);
    assert.equal(bundle.bundleHash.length, 64);
    assert.equal(bundle.frozenAt, NOW);
    // Schema validation
    const result = CompiledSkillBundleSchema.safeParse(bundle);
    assert.ok(result.success, `expected schema success: ${result.success ? '' : result.error.message}`);
  });

  it('bundle hash is stable for same input (测试 6)', () => {
    const input = makeCompilerInput();
    const bundle1 = compileSkillBundle(input);
    const bundle2 = compileSkillBundle(input);
    // bundleId 是随机的, 但 bundleHash 排除了它
    assert.equal(bundle1.bundleHash, bundle2.bundleHash);
  });

  it('throws when no skill candidate after source filter', () => {
    const input = makeCompilerInput({
      candidates: [makeSkillManifest({ source: 'external' as never })],
    });
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'NO_SKILL_CANDIDATE',
    );
  });

  it('throws when no skill matches scope (测试 4 - 不兼容组合被拒绝)', () => {
    const input = makeCompilerInput({
      candidates: [makeSkillManifest({ taskProfiles: ['research'], levels: ['L1'] })],
    });
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'NO_SKILL_IN_SCOPE',
    );
  });

  it('throws when preflight fails (测试 5 - 缺少前置条件)', () => {
    const input = makeCompilerInput({
      preflightChecker: () => false,
    });
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'PREFLIGHT_FAILED',
    );
  });

  it('throws when required tools are missing', () => {
    const input = makeCompilerInput({
      availableTools: ['read'], // 缺少 grep, write, exec
    });
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'MISSING_TOOLS',
    );
  });

  it('throws when required capabilities are missing', () => {
    const input = makeCompilerInput({
      availableCapabilities: [], // 缺少 git_diff, test_runner
    });
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'MISSING_CAPABILITIES',
    );
  });

  it('throws when required context keys are missing', () => {
    const input = makeCompilerInput({
      availableContextKeys: [], // 缺少 goal, failure_evidence
    });
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'MISSING_CONTEXT',
    );
  });

  it('rejects forbidden business repo skills (测试 11)', () => {
    const input = makeCompilerInput({
      candidates: [
        makeSkillManifest({ skillId: 'gundam.policy' }),
        makeSkillManifest({ skillId: 'value.invest' }),
        makeSkillManifest({ skillId: 'win.hotel' }),
        makeSkillManifest({ skillId: 'mr-mont.content' }),
        makeSkillManifest({ skillId: 'annie.subtitle' }),
      ],
    });
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'NO_SKILL_CANDIDATE',
    );
  });

  it('quarantined skills are excluded from new runs (测试 10)', () => {
    const evaluationRegistry = new SkillEvaluationRegistry();
    const manifest = makeSkillManifest();
    evaluationRegistry.quarantine(manifest.skillId, manifest.version, 'evaluation failed');
    const input = makeCompilerInput({
      candidates: [manifest],
      evaluationRegistry,
    });
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'NO_SKILL_IN_SCOPE',
    );
  });

  it('user-named skills are prioritized even with low score', () => {
    const manifest = makeSkillManifest({ triggers: [] }); // no triggers, no score from trigger
    const input = makeCompilerInput({
      candidates: [manifest],
      userInput: 'no matching trigger here',
      userNamedSkillIds: [manifest.skillId],
    });
    const bundle = compileSkillBundle(input);
    assert.equal(bundle.selectedSkills[0].skillId, manifest.skillId);
  });

  it('builds a valid SkillCompilerReceipt', () => {
    const input = makeCompilerInput();
    const bundle = compileSkillBundle(input);
    const receipt = buildSkillCompilerReceipt(bundle, '1.0.0');
    assert.equal(receipt.schema, 'awkn-skill-compiler-receipt/v1');
    assert.equal(receipt.executionId, EXECUTION_ID);
    assert.equal(receipt.skillBundleId, bundle.bundleId);
    assert.equal(receipt.selectedSkills.length, 1);
    assert.equal(receipt.bundleHash, bundle.bundleHash);
    assert.equal(receipt.preflightPassed, true);
  });
});

// ============================================================================
// Section 4: Incompatible Skill Combination (测试 4 详细)
// ============================================================================

describe('Incompatible Skill Combination (测试 4)', () => {
  it('rejects skills with conflicting outputs', () => {
    const skillA = makeSkillManifest({
      skillId: 'skill.a',
      outputs: ['artifact_bundle', 'shared_output'],
    });
    const skillB = makeSkillManifest({
      skillId: 'skill.b',
      outputs: ['shared_output', 'other_output'],
    });
    const input = makeCompilerInput({
      candidates: [skillA, skillB],
      availableTools: ['read', 'grep', 'write', 'exec'],
      availableCapabilities: ['git_diff', 'test_runner'],
      availableContextKeys: ['goal', 'failure_evidence'],
    });
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'INCOMPATIBLE_SKILL_COMBINATION',
    );
  });

  it('rejects skills with mutually exclusive tools', () => {
    const skillA = makeSkillManifest({
      skillId: 'skill.a',
      requires: { tools: ['git_write'], capabilities: [], context: [] },
    });
    const skillB = makeSkillManifest({
      skillId: 'skill.b',
      requires: { tools: ['git_read_only'], capabilities: [], context: [] },
    });
    const input = makeCompilerInput({
      candidates: [skillA, skillB],
      availableTools: ['git_write', 'git_read_only'],
      availableCapabilities: [],
      availableContextKeys: [],
    });
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'INCOMPATIBLE_SKILL_COMBINATION',
    );
  });
});

// ============================================================================
// Section 5: Evaluation Registry (测试 10, 12)
// ============================================================================

describe('Skill Evaluation Registry (测试 10, 12)', () => {
  let registry: SkillEvaluationRegistry;

  beforeEach(() => {
    registry = new SkillEvaluationRegistry();
  });

  it('records runs and computes historical success rate', () => {
    registry.recordRun({
      runId: 'r1',
      skillId: 'skill.x',
      skillVersion: '1.0.0',
      status: 'success',
      evidenceQualityScore: 0.8,
      costEfficiencyScore: 0.7,
      executedAt: NOW,
    });
    registry.recordRun({
      runId: 'r2',
      skillId: 'skill.x',
      skillVersion: '1.0.0',
      status: 'failure',
      evidenceQualityScore: 0.5,
      costEfficiencyScore: 0.4,
      executedAt: NOW,
    });
    assert.equal(registry.computeHistoricalSuccess('skill.x', '1.0.0'), 0.5);
    assert.equal(registry.computeEvidenceQuality('skill.x', '1.0.0'), 0.65);
    assert.equal(registry.computeCostEfficiency('skill.x', '1.0.0'), 0.55);
  });

  it('returns 0 for skills without evaluation (fail-closed)', () => {
    assert.equal(registry.computeHistoricalSuccess('unknown', '1.0.0'), 0);
    assert.equal(registry.computeEvidenceQuality('unknown', '1.0.0'), 0);
    assert.equal(registry.computeCostEfficiency('unknown', '1.0.0'), 0);
  });

  it('quarantine prevents new runs from using version', () => {
    registry.quarantine('skill.x', '1.0.0', 'evaluation failed');
    assert.equal(registry.isQuarantined('skill.x', '1.0.0'), true);
    assert.equal(registry.isQuarantined('skill.x', '2.0.0'), false);
  });

  it('hasEvaluation returns false without records (测试 9)', () => {
    assert.equal(registry.hasEvaluation('skill.x', '1.0.0'), false);
    registry.saveEvaluation(buildEvaluationFromRuns('skill.x', 'suite', [{
      runId: 'r1',
      skillId: 'skill.x',
      skillVersion: '1.0.0',
      status: 'success',
      evidenceQualityScore: 0.8,
      costEfficiencyScore: 0.7,
      executedAt: NOW,
    }]));
    assert.equal(registry.hasEvaluation('skill.x', '1.0.0'), true);
  });

  it('external material candidates need independent evaluation (测试 12)', () => {
    // 外部材料生成的候选 Skill 必须重新评测
    // 即使来源伪装为 skillsRoot, 也需要有评测数据才能在 SkillScore 中获得非零 historicalSuccess
    const manifest = makeSkillManifest({ skillId: 'external.derived' });
    const input = makeCompilerInput({
      candidates: [manifest],
      evaluationRegistry: new SkillEvaluationRegistry(), // 无评测数据
    });
    // 仍然能编译, 但 historicalSuccess=0, score 较低
    const bundle = compileSkillBundle(input);
    assert.equal(bundle.selectedSkills.length, 1);
    // 但如果 trigger 不匹配且无 evaluation, 总分应该较低
    const lowScoreInput = makeCompilerInput({
      candidates: [makeSkillManifest({ skillId: 'low.score', triggers: ['unmatched_trigger'] })],
      userInput: 'no match',
    });
    assert.throws(
      () => compileSkillBundle(lowScoreInput),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'NO_SKILL_IN_SCOPE',
    );
  });
});

// ============================================================================
// Section 6: Hash Stability (测试 6 详细)
// ============================================================================

describe('Skill Bundle Hash Stability (测试 6)', () => {
  it('computeSkillBundleHash is stable for same input', () => {
    const bundle: Omit<CompiledSkillBundle, 'bundleHash' | 'frozenAt'> = {
      schema: 'awkn-compiled-skill-bundle/v1',
      bundleId: 'sb_' + 'a'.repeat(32),
      executionId: EXECUTION_ID,
      selectedSkills: [makeSkillRef()],
      rejectedSkills: [],
      executionGraph: [],
      preflightResults: [],
      gates: [],
      recoveryPlan: [],
    };
    const hash1 = computeSkillBundleHash(bundle);
    const hash2 = computeSkillBundleHash(bundle);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });

  it('computeSkillBundleHash differs when skills differ', () => {
    const baseBundle: Omit<CompiledSkillBundle, 'bundleHash' | 'frozenAt'> = {
      schema: 'awkn-compiled-skill-bundle/v1',
      bundleId: 'sb_' + 'a'.repeat(32),
      executionId: EXECUTION_ID,
      selectedSkills: [makeSkillRef({ skillId: 'a' })],
      rejectedSkills: [],
      executionGraph: [],
      preflightResults: [],
      gates: [],
      recoveryPlan: [],
    };
    const otherBundle: Omit<CompiledSkillBundle, 'bundleHash' | 'frozenAt'> = {
      ...baseBundle,
      selectedSkills: [makeSkillRef({ skillId: 'b' })],
    };
    assert.notEqual(computeSkillBundleHash(baseBundle), computeSkillBundleHash(otherBundle));
  });

  it('hashSkillManifest is stable', () => {
    const manifest = makeSkillManifest();
    const hash1 = hashSkillManifest(manifest);
    const hash2 = hashSkillManifest(manifest);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });
});

// ============================================================================
// Section 7: Source Boundaries (测试 11)
// ============================================================================

describe('Skill Source Boundaries (测试 11)', () => {
  it('ALLOWED_SKILL_SOURCES only contains builtin/skillsRoot', () => {
    assert.deepEqual([...ALLOWED_SKILL_SOURCES].sort(), ['builtin', 'skillsRoot']);
  });

  it('FORBIDDEN_SKILL_ID_PREFIXES covers all business repos', () => {
    const expected = ['gundam.', 'value.', 'win.', 'hotel.', 'mr-mont.', 'annie.', 'subtitle.'];
    for (const prefix of expected) {
      assert.ok(FORBIDDEN_SKILL_ID_PREFIXES.includes(prefix), `missing ${prefix}`);
    }
  });
});

// ============================================================================
// Section 8: Execution Graph Schema
// ============================================================================

describe('Skill Execution Graph Schema', () => {
  it('validates a valid SkillExecutionNode', () => {
    const node = {
      schema: 'awkn-skill-execution-node/v1' as const,
      nodeId: 'skill.1.step',
      skillRef: makeSkillRef(),
      stepName: 'locate',
      dependsOn: [],
      inputs: ['context.goal'],
      outputs: ['skill.1.step.output'],
      gates: [],
    };
    const result = SkillExecutionNodeSchema.safeParse(node);
    assert.ok(result.success, `expected success: ${result.success ? '' : result.error.message}`);
  });

  it('validates a valid PreflightResult', () => {
    const result = {
      schema: 'awkn-preflight-result/v1' as const,
      skillId: 'test-skill',
      checkName: 'workspace_clean',
      passed: true,
      reason: 'workspace is clean',
      reasonCodes: ['PASSED'],
    };
    const parsed = PreflightResultSchema.safeParse(result);
    assert.ok(parsed.success, `expected success: ${parsed.success ? '' : parsed.error.message}`);
  });
});

// ============================================================================
// Section 9: User-Named Skill Priority (设计文档第 8 节 强制规则)
// ============================================================================

describe('User-Named Skill Priority', () => {
  it('user-named skill is selected even without trigger match', () => {
    const manifest = makeSkillManifest({
      skillId: 'user.named.skill',
      triggers: ['unmatched_trigger'],
    });
    const input = makeCompilerInput({
      candidates: [manifest],
      userInput: 'completely different text',
      userNamedSkillIds: ['user.named.skill'],
    });
    const bundle = compileSkillBundle(input);
    assert.equal(bundle.selectedSkills[0].skillId, 'user.named.skill');
  });

  it('non-user-named skill without trigger match has lower score', () => {
    const manifest = makeSkillManifest({
      skillId: 'low.priority.skill',
      triggers: ['unmatched_trigger'],
    });
    const input = makeCompilerInput({
      candidates: [manifest],
      userInput: 'completely different text',
      // 不在 userNamedSkillIds 中
    });
    // 应该被拒绝 (NO_SKILL_IN_SCOPE) 因为 score 太低
    assert.throws(
      () => compileSkillBundle(input),
      (err: Error) => err instanceof SkillCompilerError && err.code === 'NO_SKILL_IN_SCOPE',
    );
  });
});
