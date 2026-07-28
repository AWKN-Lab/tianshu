/**
 * Skill Compiler Contract Tests (Phase 6 / C04 / WP-AOS-07)
 *
 * Covers:
 * - SkillManifestSchema validation (valid/invalid manifests, cross-field invariants)
 * - SkillScore computation (formula verification)
 * - SkillEvaluationRegistry: register, transition, evaluation, ACTIVE conditions
 * - SkillCompiler: compileSkillBundle end-to-end (selection, preflight, execution graph)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SkillManifestSchema,
  CompiledSkillBundleSchema,
  computeSkillScore,
  type SkillManifest,
  type SkillScore,
} from '../../src/contracts/skill.js';
import {
  SkillEvaluationRegistry,
  SkillEvaluationRegistryError,
  type SkillEvaluationRecord,
} from '../../src/skills/evaluation-registry.js';
import {
  compileSkillBundle,
  validateSkillManifest,
  SKILL_COMPILER_VERSION,
  SkillCompilerError,
} from '../../src/skills/compiler.js';
import type { IntentDecision } from '../../src/contracts/intent.js';

const now = '2026-07-28T10:00:00.000Z';
const execId = 'exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const contentHash = 'a'.repeat(64);

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  const base: SkillManifest = {
    schema: 'awkn-skill/v2',
    skillId: 'test-skill',
    version: '1.0.0',
    status: 'ACTIVE',
    taskProfiles: ['analysis'],
    levels: ['L2'],
    triggers: ['analyze_repo'],
    requires: {
      tools: ['grep', 'read_file'],
      capabilities: ['codebase_search'],
      context: ['repository_path'],
    },
    preflight: ['workspace_clean_or_declared'],
    workflow: ['scan', 'analyze', 'report'],
    gates: ['testGate'],
    recovery: ['escalate_to_human'],
    outputs: ['artifact_bundle'],
    evalSuite: 'test-suite-v1',
    description: 'Test skill for contract validation',
    createdAt: now,
    updatedAt: now,
    source: 'builtin',
    contentHash,
  };
  return { ...base, ...overrides } as SkillManifest;
}

function makeIntent(overrides: Partial<IntentDecision> = {}): IntentDecision {
  const base: IntentDecision = {
    schema: 'awkn-intent-decision/v1',
    intentId: 'intent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    inputId: 'in_cccccccccccccccccccccccccccccccc',
    executionLevel: 'L2',
    primaryIntent: 'analyze repository',
    secondaryIntents: [],
    requestedOutcome: 'analysis report',
    deliverableTypes: ['report'],
    externalSideEffects: false,
    timeDependency: 'none',
    taskProfile: 'analysis',
    confidence: 0.8,
    assumptions: [],
    missingFields: [],
    clarificationDecision: 'CONTINUE',
    clarificationValue: 0.5,
    goalRequired: true,
    persistentRunRequired: true,
    reasonCodes: ['analysis_request'],
    routerVersion: 'awkn-intent-router/v1',
    routedAt: now,
  };
  return { ...base, ...overrides } as IntentDecision;
}

describe('Skill Manifest Schema Validation', () => {
  it('accepts a valid SkillManifest', () => {
    const manifest = makeManifest();
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, true);
  });

  it('rejects updatedAt < createdAt', () => {
    const manifest = makeManifest({
      createdAt: '2026-07-28T10:00:00.000Z',
      updatedAt: '2026-07-27T10:00:00.000Z',
    });
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, false);
  });

  it('rejects QUARANTINED skill with non-empty preflight', () => {
    const manifest = makeManifest({
      status: 'QUARANTINED',
      preflight: ['workspace_clean_or_declared'],
    });
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, false);
  });

  it('accepts QUARANTINED skill with empty preflight', () => {
    const manifest = makeManifest({
      status: 'QUARANTINED',
      preflight: [],
    });
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, true);
  });

  it('rejects invalid contentHash (wrong length)', () => {
    const manifest = makeManifest({ contentHash: 'short-hash' });
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, false);
  });

  it('rejects empty taskProfiles', () => {
    const manifest = makeManifest({ taskProfiles: [] as never });
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, false);
  });

  it('rejects empty workflow', () => {
    const manifest = makeManifest({ workflow: [] as never });
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, false);
  });

  it('rejects unknown schema string', () => {
    const manifest = makeManifest({ schema: 'wrong-skill/v1' as never });
    const result = SkillManifestSchema.safeParse(manifest);
    assert.equal(result.success, false);
  });
});

describe('Skill Score Computation', () => {
  it('computes score with full match (no compatibility risk)', () => {
    const score = computeSkillScore({
      skillId: 's1',
      triggerMatch: 1,
      taskProfileMatch: 1,
      levelMatch: 1,
      historicalSuccess: 1,
      evidenceQuality: 1,
      costEfficiency: 1,
      compatibilityRisk: 0,
    });
    // 0.30*1 + 0.20*1 + 0.15*1 + 0.15*1 + 0.10*1 + 0.10*1 - 0.20*0 = 1.0
    assert.equal(score.totalScore, 1);
  });

  it('computes score with zero match', () => {
    const score = computeSkillScore({
      skillId: 's1',
      triggerMatch: 0,
      taskProfileMatch: 0,
      levelMatch: 0,
      historicalSuccess: 0,
      evidenceQuality: 0,
      costEfficiency: 0,
      compatibilityRisk: 0,
    });
    assert.equal(score.totalScore, 0);
  });

  it('subtracts compatibilityRisk', () => {
    const score = computeSkillScore({
      skillId: 's1',
      triggerMatch: 1,
      taskProfileMatch: 1,
      levelMatch: 1,
      historicalSuccess: 1,
      evidenceQuality: 1,
      costEfficiency: 1,
      compatibilityRisk: 1,
    });
    // 1.0 - 0.20*1 = 0.8
    assert.equal(score.totalScore, 0.8);
  });

  it('clamps totalScore to [0, 1]', () => {
    const high = computeSkillScore({
      skillId: 's1',
      triggerMatch: 1,
      taskProfileMatch: 1,
      levelMatch: 1,
      historicalSuccess: 1,
      evidenceQuality: 1,
      costEfficiency: 1,
      compatibilityRisk: 0,
    });
    assert.equal(high.totalScore, 1);

    const low = computeSkillScore({
      skillId: 's1',
      triggerMatch: 0,
      taskProfileMatch: 0,
      levelMatch: 0,
      historicalSuccess: 0,
      evidenceQuality: 0,
      costEfficiency: 0,
      compatibilityRisk: 1,
    });
    // 0 - 0.20 = -0.20, clamped to 0
    assert.equal(low.totalScore, 0);
  });

  it('preserves input fields in output', () => {
    const input = {
      skillId: 's1',
      triggerMatch: 0.5,
      taskProfileMatch: 0.6,
      levelMatch: 0.7,
      historicalSuccess: 0.8,
      evidenceQuality: 0.9,
      costEfficiency: 0.4,
      compatibilityRisk: 0.3,
    };
    const score = computeSkillScore(input);
    assert.equal(score.skillId, input.skillId);
    assert.equal(score.triggerMatch, input.triggerMatch);
    assert.equal(score.taskProfileMatch, input.taskProfileMatch);
    assert.equal(score.levelMatch, input.levelMatch);
    assert.equal(score.historicalSuccess, input.historicalSuccess);
    assert.equal(score.evidenceQuality, input.evidenceQuality);
    assert.equal(score.costEfficiency, input.costEfficiency);
    assert.equal(score.compatibilityRisk, input.compatibilityRisk);
    // Verify formula
    const expected =
      0.30 * 0.5 + 0.20 * 0.6 + 0.15 * 0.7 + 0.15 * 0.8
      + 0.10 * 0.9 + 0.10 * 0.4 - 0.20 * 0.3;
    assert.ok(Math.abs(score.totalScore - expected) < 1e-10);
  });
});

describe('Skill Evaluation Registry', () => {
  it('registers and queries ACTIVE skill', () => {
    const registry = new SkillEvaluationRegistry();
    registry.register(makeManifest(), now);

    const active = registry.getActive('test-skill');
    assert.ok(active);
    assert.equal(active!.skillId, 'test-skill');
  });

  it('rejects invalid manifest on register', () => {
    const registry = new SkillEvaluationRegistry();
    assert.throws(
      () => registry.register({ ...makeManifest(), contentHash: 'short' }, now),
      (err: unknown) => err instanceof SkillEvaluationRegistryError && err.code === 'INVALID_MANIFEST',
    );
  });

  it('rejects duplicate version', () => {
    const registry = new SkillEvaluationRegistry();
    registry.register(makeManifest(), now);
    assert.throws(
      () => registry.register(makeManifest(), now),
      (err: unknown) => err instanceof SkillEvaluationRegistryError && err.code === 'VERSION_CONFLICT',
    );
  });

  it('transitions status along allowed paths', () => {
    const registry = new SkillEvaluationRegistry();
    registry.register(makeManifest({ status: 'DRAFT' }), now);

    registry.transitionStatus('test-skill', 'VALIDATING');
    registry.transitionStatus('test-skill', 'APPROVED');
    registry.transitionStatus('test-skill', 'ACTIVE');

    const active = registry.getActive('test-skill');
    assert.ok(active);
    assert.equal(active!.status, 'ACTIVE');
  });

  it('rejects invalid status transition', () => {
    const registry = new SkillEvaluationRegistry();
    registry.register(makeManifest({ status: 'DRAFT' }), now);

    assert.throws(
      () => registry.transitionStatus('test-skill', 'ACTIVE'),
      (err: unknown) => err instanceof SkillEvaluationRegistryError && err.code === 'INVALID_TRANSITION',
    );
  });

  it('lists ACTIVE skills and queries by taskProfile', () => {
    const registry = new SkillEvaluationRegistry();
    registry.register(makeManifest({ skillId: 's-analysis', taskProfiles: ['analysis'] }), now);
    registry.register(makeManifest({ skillId: 's-research', taskProfiles: ['research'] }), now);

    const allActive = registry.listActive();
    assert.equal(allActive.length, 2);

    const analysisOnly = registry.queryByTaskProfile('analysis');
    assert.equal(analysisOnly.length, 1);
    assert.equal(analysisOnly[0]!.skillId, 's-analysis');
  });

  it('records evaluations and computes historical score', () => {
    const registry = new SkillEvaluationRegistry();
    registry.register(makeManifest(), now);

    const records: SkillEvaluationRecord[] = [
      {
        skillId: 'test-skill',
        version: '1.0.0',
        score: {
          skillId: 'test-skill',
          triggerMatch: 1, taskProfileMatch: 1, levelMatch: 1,
          historicalSuccess: 0.8, evidenceQuality: 0.7, costEfficiency: 0.6,
          compatibilityRisk: 0.1, totalScore: 0.9,
        },
        evaluatedAt: now,
        runId: 'run_1',
        outcome: 'SUCCESS',
      },
      {
        skillId: 'test-skill',
        version: '1.0.0',
        score: {
          skillId: 'test-skill',
          triggerMatch: 1, taskProfileMatch: 1, levelMatch: 1,
          historicalSuccess: 0.6, evidenceQuality: 0.5, costEfficiency: 0.4,
          compatibilityRisk: 0.2, totalScore: 0.7,
        },
        evaluatedAt: now,
        runId: 'run_2',
        outcome: 'PARTIAL',
      },
    ];
    registry.recordEvaluation(records[0]!);
    registry.recordEvaluation(records[1]!);

    const hist = registry.getHistoricalScore('test-skill');
    assert.ok(hist);
    // successRate = 1 SUCCESS / 2 total = 0.5
    assert.equal(hist!.historicalSuccess, 0.5);
    // triggerMatch avg = (1 + 1) / 2 = 1
    assert.equal(hist!.triggerMatch, 1);
  });

  it('checkActiveConditions fails when no evaluation records', () => {
    const registry = new SkillEvaluationRegistry();
    registry.register(makeManifest(), now);

    const result = registry.checkActiveConditions('test-skill');
    assert.equal(result.passed, false);
    assert.ok(result.failures.some((f) => f.includes('no evaluation records')));
  });

  it('checkActiveConditions fails when baseline has FAILURE', () => {
    const registry = new SkillEvaluationRegistry();
    registry.register(makeManifest(), now);
    registry.recordEvaluation({
      skillId: 'test-skill',
      version: '1.0.0',
      score: {
        skillId: 'test-skill',
        triggerMatch: 1, taskProfileMatch: 1, levelMatch: 1,
        historicalSuccess: 0.5, evidenceQuality: 0.5, costEfficiency: 0.5,
        compatibilityRisk: 0, totalScore: 0.5,
      },
      evaluatedAt: now,
      runId: 'run_1',
      outcome: 'FAILURE',
    });

    const result = registry.checkActiveConditions('test-skill');
    assert.equal(result.passed, false);
    assert.ok(result.failures.some((f) => f.includes('FAILURE')));
  });

  it('checkActiveConditions passes with sufficient SUCCESS records', () => {
    const registry = new SkillEvaluationRegistry();
    registry.register(makeManifest(), now);
    for (let i = 0; i < 5; i++) {
      registry.recordEvaluation({
        skillId: 'test-skill',
        version: '1.0.0',
        score: {
          skillId: 'test-skill',
          triggerMatch: 1, taskProfileMatch: 1, levelMatch: 1,
          historicalSuccess: 0.9, evidenceQuality: 0.8, costEfficiency: 0.7,
          compatibilityRisk: 0, totalScore: 0.9,
        },
        evaluatedAt: now,
        runId: `run_${i}`,
        outcome: 'SUCCESS',
      });
    }

    const result = registry.checkActiveConditions('test-skill');
    assert.equal(result.passed, true);
    assert.equal(result.failures.length, 0);
  });

  it('unregister removes skill and its evaluations', () => {
    const registry = new SkillEvaluationRegistry();
    registry.register(makeManifest(), now);
    registry.recordEvaluation({
      skillId: 'test-skill',
      version: '1.0.0',
      score: {
        skillId: 'test-skill',
        triggerMatch: 1, taskProfileMatch: 1, levelMatch: 1,
        historicalSuccess: 1, evidenceQuality: 1, costEfficiency: 1,
        compatibilityRisk: 0, totalScore: 1,
      },
      evaluatedAt: now,
      runId: 'run_1',
      outcome: 'SUCCESS',
    });

    assert.equal(registry.size(), 1);
    assert.equal(registry.evaluationCount('test-skill'), 1);

    registry.unregister('test-skill');
    assert.equal(registry.size(), 0);
    assert.equal(registry.evaluationCount('test-skill'), 0);
  });
});

describe('Skill Compiler', () => {
  it('validates a valid SkillManifest', () => {
    const manifest = makeManifest();
    const validated = validateSkillManifest(manifest);
    assert.equal(validated.skillId, manifest.skillId);
  });

  it('throws SkillCompilerError for invalid manifest', () => {
    assert.throws(
      () => validateSkillManifest({ ...makeManifest(), contentHash: 'short' }),
      SkillCompilerError,
    );
  });

  it('compiles a skill bundle from matching candidates', () => {
    const intent = makeIntent();
    const candidate = makeManifest({ skillId: 'matching-skill' });

    const output = compileSkillBundle({
      executionId: execId,
      intentDecision: intent,
      candidateSkills: [candidate],
      compiledAt: now,
    });

    assert.equal(output.bundle.schema, 'awkn-compiled-skill-bundle/v1');
    assert.equal(output.bundle.compilerVersion, SKILL_COMPILER_VERSION);
    assert.equal(output.bundle.executionId, execId);
    assert.ok(output.bundle.bundleId.startsWith('sb_'));
    assert.equal(output.bundle.selectedSkills.length, 1);
    assert.equal(output.bundle.selectedSkills[0]!.skillId, 'matching-skill');
    assert.equal(output.bundle.rejectedSkills.length, 0);
    assert.equal(output.selectedScores.length, 1);
    // Bundle must pass schema validation
    assert.equal(CompiledSkillBundleSchema.safeParse(output.bundle).success, true);
  });

  it('rejects QUARANTINED skills', () => {
    const intent = makeIntent();
    const candidate = makeManifest({ skillId: 'quarantined', status: 'QUARANTINED', preflight: [] });

    const output = compileSkillBundle({
      executionId: execId,
      intentDecision: intent,
      candidateSkills: [candidate],
      compiledAt: now,
    });

    assert.equal(output.bundle.selectedSkills.length, 0);
    assert.equal(output.bundle.rejectedSkills.length, 1);
    assert.equal(output.bundle.rejectedSkills[0]!.rejectionCode, 'QUARANTINED');
    // Empty selectedSkills → empty executionGraph
    assert.equal(output.bundle.executionGraph.length, 0);
  });

  it('rejects skills with taskProfile mismatch', () => {
    const intent = makeIntent({ taskProfile: 'research' });
    const candidate = makeManifest({ skillId: 'analysis-only', taskProfiles: ['analysis'] });

    const output = compileSkillBundle({
      executionId: execId,
      intentDecision: intent,
      candidateSkills: [candidate],
      compiledAt: now,
    });

    assert.equal(output.bundle.selectedSkills.length, 0);
    assert.equal(output.bundle.rejectedSkills.length, 1);
    assert.equal(output.bundle.rejectedSkills[0]!.rejectionCode, 'PROFILE_MISMATCH');
  });

  it('rejects skills with level mismatch', () => {
    const intent = makeIntent({ executionLevel: 'L4' });
    const candidate = makeManifest({ skillId: 'l2-only', levels: ['L2'] });

    const output = compileSkillBundle({
      executionId: execId,
      intentDecision: intent,
      candidateSkills: [candidate],
      compiledAt: now,
    });

    assert.equal(output.bundle.selectedSkills.length, 0);
    assert.equal(output.bundle.rejectedSkills.length, 1);
    assert.equal(output.bundle.rejectedSkills[0]!.rejectionCode, 'LEVEL_MISMATCH');
  });

  it('explicitly named skills bypass profile/level matching', () => {
    const intent = makeIntent({ taskProfile: 'research' });
    const candidate = makeManifest({ skillId: 'explicit', taskProfiles: ['analysis'] });

    const output = compileSkillBundle({
      executionId: execId,
      intentDecision: intent,
      candidateSkills: [candidate],
      explicitlyNamedSkills: ['explicit'],
      compiledAt: now,
    });

    assert.equal(output.bundle.selectedSkills.length, 1);
    assert.equal(output.bundle.selectedSkills[0]!.skillId, 'explicit');
    assert.ok(output.bundle.selectedSkills[0]!.selectedReason.includes('explicitly named'));
  });

  it('builds execution graph for selected skills', () => {
    const intent = makeIntent();
    const candidate = makeManifest({
      skillId: 'graph-test',
      workflow: ['step1', 'step2', 'step3'],
    });

    const output = compileSkillBundle({
      executionId: execId,
      intentDecision: intent,
      candidateSkills: [candidate],
      compiledAt: now,
    });

    assert.equal(output.bundle.executionGraph.length, 3);
    // First node has no deps
    assert.equal(output.bundle.executionGraph[0]!.dependsOn.length, 0);
    // Second node depends on first
    assert.equal(output.bundle.executionGraph[1]!.dependsOn.length, 1);
    // Third node depends on second
    assert.equal(output.bundle.executionGraph[2]!.dependsOn.length, 1);
    // All nodes belong to the same skill
    for (const node of output.bundle.executionGraph) {
      assert.equal(node.skillId, 'graph-test');
    }
  });

  it('collects gates from selected skills', () => {
    const intent = makeIntent();
    const candidate = makeManifest({
      skillId: 'gate-test',
      gates: ['testGate', 'reviewGate'],
    });

    const output = compileSkillBundle({
      executionId: execId,
      intentDecision: intent,
      candidateSkills: [candidate],
      compiledAt: now,
    });

    assert.equal(output.bundle.gates.length, 2);
    assert.ok(output.bundle.gates.some((g) => g.gateType === 'testGate'));
    assert.ok(output.bundle.gates.some((g) => g.gateType === 'reviewGate'));
  });

  it('collects recovery plan from selected skills', () => {
    const intent = makeIntent();
    const candidate = makeManifest({
      skillId: 'recovery-test',
      recovery: ['escalate_to_human', 'abort_with_receipt'],
    });

    const output = compileSkillBundle({
      executionId: execId,
      intentDecision: intent,
      candidateSkills: [candidate],
      compiledAt: now,
    });

    assert.equal(output.bundle.recoveryPlan.length, 2);
    assert.ok(output.bundle.recoveryPlan.some((r) => r.actionType === 'escalate_to_human'));
    assert.ok(output.bundle.recoveryPlan.some((r) => r.actionType === 'abort_with_receipt'));
  });

  it('uses historical scores when provided', () => {
    const intent = makeIntent();
    const candidate = makeManifest({ skillId: 'hist-test' });
    const histScore: SkillScore = {
      skillId: 'hist-test',
      triggerMatch: 1, taskProfileMatch: 1, levelMatch: 1,
      historicalSuccess: 0.9, evidenceQuality: 0.8, costEfficiency: 0.7,
      compatibilityRisk: 0, totalScore: 0.95,
    };
    const histMap = new Map([['hist-test', histScore]]);

    const output = compileSkillBundle({
      executionId: execId,
      intentDecision: intent,
      candidateSkills: [candidate],
      historicalScores: histMap,
      compiledAt: now,
    });

    assert.equal(output.bundle.selectedSkills.length, 1);
    // Score should reflect high historical success
    assert.ok(output.bundle.selectedSkills[0]!.score > 0.5);
  });

  it('handles empty candidate list gracefully', () => {
    const intent = makeIntent();
    const output = compileSkillBundle({
      executionId: execId,
      intentDecision: intent,
      candidateSkills: [],
      compiledAt: now,
    });

    assert.equal(output.bundle.selectedSkills.length, 0);
    assert.equal(output.bundle.executionGraph.length, 0);
    assert.equal(output.bundle.gates.length, 0);
    assert.equal(output.bundle.recoveryPlan.length, 0);
    // Bundle still passes schema
    assert.equal(CompiledSkillBundleSchema.safeParse(output.bundle).success, true);
  });
});
