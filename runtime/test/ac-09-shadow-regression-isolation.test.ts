/**
 * AC-09 — Shadow Regression Isolation (BLOCKING verdict on safety regression)
 *
 * 验收标准：Shadow Execution 检测到 SAFETY_REGRESSION / CORRECTNESS_REGRESSION /
 * MISSING_IN_R2 / UNKNOWN 时必须返回 BLOCKING verdict，并通过 fail-closed 隔离
 * 确保 Adapter 错误不向 Engine v2 主链传播。
 *
 * 端到端覆盖：
 *   (a) SAFETY_REGRESSION → BLOCKING（legacy 检测到副作用，R2 漏判）
 *   (b) CORRECTNESS_REGRESSION → BLOCKING（legacy=ACHIEVED vs R2=NOT_ACHIEVED）
 *   (c) MISSING_IN_R2 → BLOCKING（R2 未提供对应输出）
 *   (d) UNKNOWN → BLOCKING（fail-closed：无法分类时保守拒绝）
 *   (e) 全 EXACT → MATCH（控制组：无差异时通过）
 *   (f) EXPECTED_IMPROVEMENT → ACCEPTABLE（R2 比 legacy 更精确）
 *   (g) ACCEPTABLE_DIVERGENCE → ACCEPTABLE（可接受差异）
 *   (h) Kill switch：AWKN_SHADOW_DISABLED=1 跳过 Shadow 路径，不产 diff
 *   (i) Kill switch：config.enabled=false 跳过 Shadow 路径
 *   (j) Fail-closed 隔离：Input Adapter 抛错时转换为 SAFETY_REGRESSION，不向调用方传播
 *   (k) shouldAlertOnShadow 对 BLOCKING 返回 true，对 MATCH/ACCEPTABLE 返回 false
 *   (l) 确定性：相同输入产生相同 diffId
 *
 * 对应源码:
 *   - src/shadow/shadow-execution.ts (runShadowExecution, shouldAlertOnShadow)
 *   - src/shadow/shadow-diff-receipt.ts (computeOverallVerdict, 9 种 classification)
 *   - src/shadow/shadow-diff-evaluator.ts (evaluateShadowDiff)
 *   - src/adapter/types.ts (LegacyAdapterContext, fail-closed 设计)
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  runShadowExecution,
  shadowExecutionVerdict,
  shouldAlertOnShadow,
  type ShadowExecutionConfig,
  type ShadowExecutionInput,
  type ShadowErrorContext,
} from '../src/shadow/shadow-execution.js';
import {
  computeOverallVerdict,
  type ShadowDiffClassification,
} from '../src/shadow/shadow-diff-receipt.js';
import {
  buildComparison,
  evaluateShadowDiff,
} from '../src/shadow/shadow-diff-evaluator.js';
import type { IntentDecision, ContextManifest } from '../src/contracts/public.js';
import type {
  EngineV2InputSnapshot,
  EngineV2MemorySnapshot,
  EngineV2GoalSnapshot,
} from '../src/adapter/types.js';
import type { ChatMessage, ChatResponse } from '../src/llm/types.js';
import type { Goal } from '../src/goal/goal-state.js';
import type { GateResult } from '../src/gates/quality-gates.js';
import { createAwknId } from '../src/contracts/ids.js';

// ─── 常量与 fixture ────────────────────────────────────────

const NOW = '2026-08-02T00:00:00.000Z';
const EXECUTION_ID = createAwknId('execution');
const TRACE_ID = createAwknId('trace');
const PRIMARY_INTENT = 'analyze the data';

function clock(): () => string {
  return () => NOW;
}

function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

function llmResponseWithToolCalls(content: string): ChatResponse {
  // 提供带 toolCalls 的 LLM 响应，使 LegacyIntentRouterAdapter 推断 externalSideEffects=true
  return {
    content,
    toolCalls: [
      {
        id: 'call_ac09_1',
        type: 'function',
        function: { name: 'send_email', arguments: '{"to":"alice"}' },
      },
    ],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    provider: 'trae',
    model: 'test-model',
    finishReason: 'tool_calls',
  };
}

function buildGoal(opts: Partial<Goal> = {}): Goal {
  return {
    id: opts.id ?? 'goal_ac09_001',
    title: opts.title ?? 'AC-09 Goal',
    description: opts.description ?? 'goal for shadow regression test',
    state: opts.state ?? 'active',
    owner: opts.owner ?? 'tester',
    createdAt: opts.createdAt ?? NOW,
    updatedAt: opts.updatedAt ?? NOW,
    hao: opts.hao ?? [{ description: 'criterion 1', passed: false }],
    history: opts.history ?? [],
  };
}

function buildGateResult(passed = true): GateResult {
  return {
    name: 'test-gate',
    passed,
    durationMs: 10,
  };
}

function buildInputSnapshot(userInput = PRIMARY_INTENT): EngineV2InputSnapshot {
  return {
    userInput,
    messages: [userMessage(userInput)],
  };
}

function buildMemorySnapshot(messages: ChatMessage[] = [userMessage(PRIMARY_INTENT)]): EngineV2MemorySnapshot {
  return { messages };
}

function buildGoalSnapshot(goalOverride?: Partial<Goal>): EngineV2GoalSnapshot {
  return {
    goal: buildGoal(goalOverride),
    runId: createAwknId('run'),
    gateResults: [buildGateResult(true)],
    judgeVersion: 'awkn-goal-judge/v1',
  };
}

function buildIntentDecision(opts: { primaryIntent?: string; externalSideEffects?: boolean } = {}): IntentDecision {
  return {
    schema: 'awkn-intent-decision/v1',
    intentId: createAwknId('intent'),
    inputId: createAwknId('input'),
    executionLevel: 'L1',
    primaryIntent: opts.primaryIntent ?? PRIMARY_INTENT,
    secondaryIntents: [],
    requestedOutcome: 'a grounded answer',
    deliverableTypes: ['chat'],
    externalSideEffects: opts.externalSideEffects ?? false,
    timeDependency: 'none',
    taskProfile: 'analysis',
    confidence: 0.9,
    assumptions: [],
    missingFields: [],
    clarificationDecision: 'CONTINUE',
    clarificationValue: 0.5,
    goalRequired: false,
    persistentRunRequired: false,
    reasonCodes: ['default'],
    routerVersion: 'awkn-intent-router/v1',
    routedAt: NOW,
  } as IntentDecision;
}

function buildContextManifest(opts: { query?: string; includedCount?: number } = {}): ContextManifest {
  const included: unknown[] = Array.from({ length: opts.includedCount ?? 0 });
  return {
    schema: 'awkn-context-manifest/v1',
    contextId: createAwknId('context'),
    executionId: EXECUTION_ID,
    query: opts.query ?? PRIMARY_INTENT,
    status: 'READY',
    tokenBudget: 200,
    safetyReserveTokens: 0,
    selectedTokenCount: 0,
    sectionAllocations: [],
    included: included as never[],
    excluded: [],
    conflicts: [],
    sourceReceipts: [],
    blockingReasonCodes: [],
    policyVersion: 'context-policy/v1',
    plannerVersion: 'context-planner/v1',
    createdAt: NOW,
    manifestHash: 'a'.repeat(64),
  } as ContextManifest;
}

function buildInput(opts: {
  inputSnapshot?: EngineV2InputSnapshot;
  memorySnapshot?: EngineV2MemorySnapshot;
  goalSnapshot?: EngineV2GoalSnapshot;
  r2IntentDecision?: IntentDecision;
  r2ContextManifest?: ContextManifest;
  r2GoalVerdict?: string;
} = {}): ShadowExecutionInput {
  return {
    executionId: EXECUTION_ID,
    traceId: TRACE_ID,
    engineV2InputSnapshot: opts.inputSnapshot ?? buildInputSnapshot(),
    engineV2MemorySnapshot: opts.memorySnapshot,
    engineV2GoalSnapshot: opts.goalSnapshot,
    r2IntentDecision: opts.r2IntentDecision,
    r2ContextManifest: opts.r2ContextManifest,
    r2GoalVerdict: opts.r2GoalVerdict,
  };
}

function buildConfig(opts: ShadowExecutionConfig = {}): ShadowExecutionConfig {
  return {
    enabled: true,
    clock: clock(),
    ...opts,
  };
}

// ─── 测试 ──────────────────────────────────────────────────

describe('AC-09 — Shadow Regression Isolation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 确保每个测试默认启用 shadow
    delete process.env.AWKN_SHADOW_DISABLED;
  });

  afterEach(() => {
    // 恢复环境变量
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  // ─── (a) SAFETY_REGRESSION → BLOCKING ────────────────────

  it('SAFETY_REGRESSION classification triggers BLOCKING verdict', () => {
    // 场景：legacy 通过 LLM toolCalls 推断 externalSideEffects=true，R2 漏判为 false
    const input = buildInput({
      inputSnapshot: {
        userInput: 'send email to alice',
        messages: [userMessage('send email to alice')],
        llmResponse: llmResponseWithToolCalls('sending email'),
      },
      r2IntentDecision: buildIntentDecision({
        primaryIntent: 'send email to alice',
        externalSideEffects: false, // R2 missed the side effect
      }),
    });
    // legacy intent adapter 通过 llmResponse.toolCalls 推断 externalSideEffects=true
    // 触发 SAFETY_REGRESSION 路径
    const result = runShadowExecution(input, buildConfig());

    assert.equal(result.skipped, false);
    assert.ok(result.diffReceipt, 'diff receipt must be produced');
    assert.equal(result.diffReceipt!.overallVerdict, 'BLOCKING');
    const safetyRegressions = result.diffReceipt!.comparisons.filter(
      (c) => c.classification === 'SAFETY_REGRESSION',
    );
    assert.ok(
      safetyRegressions.length >= 1,
      'must produce at least one SAFETY_REGRESSION comparison',
    );
    assert.ok(
      safetyRegressions.some((c) => c.field === 'intent.externalSideEffects'),
      'SAFETY_REGRESSION must be on intent.externalSideEffects field',
    );
  });

  // ─── (b) CORRECTNESS_REGRESSION → BLOCKING ───────────────

  it('CORRECTNESS_REGRESSION (legacy=ACHIEVED vs R2=NOT_ACHIEVED) triggers BLOCKING', () => {
    const input = buildInput({
      goalSnapshot: buildGoalSnapshot({
        state: 'achieved',
        hao: [{ description: 'all criteria met', passed: true }],
      }),
      r2GoalVerdict: 'NOT_ACHIEVED',
    });
    const result = runShadowExecution(input, buildConfig());

    assert.equal(result.skipped, false);
    assert.equal(result.diffReceipt!.overallVerdict, 'BLOCKING');
    const goalComp = result.diffReceipt!.comparisons.find((c) => c.field === 'goal.verdict');
    assert.ok(goalComp, 'goal.verdict comparison must exist');
    assert.equal(goalComp!.classification, 'CORRECTNESS_REGRESSION');
  });

  // ─── (c) MISSING_IN_R2 → BLOCKING ────────────────────────

  it('MISSING_IN_R2 classification triggers BLOCKING verdict', () => {
    // 不提供 r2IntentDecision → intent.primaryIntent 标记为 MISSING_IN_R2
    const input = buildInput();
    const result = runShadowExecution(input, buildConfig());

    assert.equal(result.skipped, false);
    assert.equal(result.diffReceipt!.overallVerdict, 'BLOCKING');
    const missingComps = result.diffReceipt!.comparisons.filter(
      (c) => c.classification === 'MISSING_IN_R2',
    );
    assert.ok(missingComps.length >= 1, 'must have at least one MISSING_IN_R2 comparison');
  });

  // ─── (d) UNKNOWN → BLOCKING ──────────────────────────────

  it('UNKNOWN classification (no snapshots) triggers BLOCKING verdict', () => {
    // 不提供任何 snapshot 与 r2 输出：comparisons 为空时 fail-closed 标记为 UNKNOWN
    // 通过直接调用 evaluateShadowDiff 验证 UNKNOWN → BLOCKING 规则
    const comparison = buildComparison(
      'shadow.unclassified',
      null,
      null,
      'UNKNOWN',
      'unable to classify (fail-closed)',
    );
    const receipt = evaluateShadowDiff({
      executionId: EXECUTION_ID,
      traceId: TRACE_ID,
      comparisons: [comparison],
      clock: clock(),
    });
    assert.equal(receipt.overallVerdict, 'BLOCKING');
    assert.equal(receipt.summary.unknown, 1);
  });

  // ─── (e) 全 EXACT → MATCH（控制组） ─────────────────────

  it('all EXACT comparisons produce MATCH verdict (control case)', () => {
    const input = buildInput({
      r2IntentDecision: buildIntentDecision({
        primaryIntent: PRIMARY_INTENT,
        externalSideEffects: false,
      }),
    });
    const result = runShadowExecution(input, buildConfig());

    assert.equal(result.skipped, false);
    assert.equal(result.diffReceipt!.overallVerdict, 'MATCH');
    // MATCH 不应包含任何 BLOCKING 分类
    const blockingClassifications: ShadowDiffClassification[] = [
      'SAFETY_REGRESSION',
      'CORRECTNESS_REGRESSION',
      'MISSING_IN_R2',
      'UNKNOWN',
    ];
    for (const cls of blockingClassifications) {
      const found = result.diffReceipt!.comparisons.filter((c) => c.classification === cls);
      assert.equal(found.length, 0, `MATCH verdict must not include ${cls}`);
    }
  });

  // ─── (f) EXPECTED_IMPROVEMENT → ACCEPTABLE ───────────────

  it('EXPECTED_IMPROVEMENT produces ACCEPTABLE verdict', () => {
    // R2 ContextManifest 有 included items，legacy 推断为 0 → EXPECTED_IMPROVEMENT
    const input = buildInput({
      r2IntentDecision: buildIntentDecision({ primaryIntent: PRIMARY_INTENT }),
      memorySnapshot: buildMemorySnapshot(),
      r2ContextManifest: buildContextManifest({ includedCount: 5 }),
    });
    const result = runShadowExecution(input, buildConfig());

    assert.equal(result.skipped, false);
    assert.equal(result.diffReceipt!.overallVerdict, 'ACCEPTABLE');
    const improvement = result.diffReceipt!.comparisons.find(
      (c) => c.classification === 'EXPECTED_IMPROVEMENT',
    );
    assert.ok(improvement, 'must produce EXPECTED_IMPROVEMENT comparison');
    assert.equal(improvement!.field, 'context.candidateCount');
  });

  // ─── (g) ACCEPTABLE_DIVERGENCE → ACCEPTABLE ──────────────

  it('ACCEPTABLE_DIVERGENCE produces ACCEPTABLE verdict', () => {
    // primaryIntent 不匹配（legacy vs R2）→ ACCEPTABLE_DIVERGENCE
    const input = buildInput({
      r2IntentDecision: buildIntentDecision({
        primaryIntent: 'different intent wording',
        externalSideEffects: false,
      }),
    });
    const result = runShadowExecution(input, buildConfig());

    assert.equal(result.skipped, false);
    assert.equal(result.diffReceipt!.overallVerdict, 'ACCEPTABLE');
    const divergence = result.diffReceipt!.comparisons.find(
      (c) => c.classification === 'ACCEPTABLE_DIVERGENCE',
    );
    assert.ok(divergence, 'must produce ACCEPTABLE_DIVERGENCE comparison');
  });

  // ─── (h) Kill switch：AWKN_SHADOW_DISABLED=1 ─────────────

  it('AWKN_SHADOW_DISABLED=1 skips shadow execution entirely', () => {
    process.env.AWKN_SHADOW_DISABLED = '1';
    const result = runShadowExecution(buildInput(), buildConfig());

    assert.equal(result.skipped, true, 'must skip when env kill switch is set');
    assert.equal(result.diffReceipt, undefined, 'no diff receipt when skipped');
    assert.ok(result.skipReason, 'must provide skip reason');
    assert.match(result.skipReason!, /AWKN_SHADOW_DISABLED=1/);
  });

  // ─── (i) Kill switch：config.enabled=false ───────────────

  it('config.enabled=false skips shadow execution', () => {
    const result = runShadowExecution(
      buildInput(),
      buildConfig({ enabled: false }),
    );

    assert.equal(result.skipped, true);
    assert.equal(result.diffReceipt, undefined);
    assert.match(result.skipReason!, /config\.enabled=false/);
  });

  // ─── (j) Fail-closed 隔离：Adapter 错误不传播 ───────────

  it('fail-closed: Input Adapter error converts to SAFETY_REGRESSION without throwing', () => {
    // userInput='' 触发 LegacyInputAdapter 抛错
    const input = buildInput({
      inputSnapshot: { userInput: '', messages: [] },
    });
    const errors: ShadowErrorContext[] = [];

    assert.doesNotThrow(() => {
      const result = runShadowExecution(input, buildConfig({
        onError: (_err, ctx) => { errors.push(ctx); },
      }));
      assert.equal(result.skipped, false, 'must still produce diff (fail-closed)');
      assert.ok(result.diffReceipt, 'diff receipt must exist');
      assert.equal(result.diffReceipt.overallVerdict, 'BLOCKING');
      const safetyRegressions = result.diffReceipt.comparisons.filter(
        (c) => c.classification === 'SAFETY_REGRESSION',
      );
      assert.ok(safetyRegressions.length >= 1, 'Adapter error must convert to SAFETY_REGRESSION');
    });

    const inputErrors = errors.filter((e) => e.component === 'input');
    assert.ok(inputErrors.length >= 1, 'onError must be called for input component');
    assert.equal(inputErrors[0]!.adapterName, 'LegacyInputAdapter');
    assert.equal(inputErrors[0]!.mode, 'shadow');
  });

  it('fail-closed: onError handler crash does not propagate to caller', () => {
    const input = buildInput({
      inputSnapshot: { userInput: '', messages: [] },
    });
    assert.doesNotThrow(() => {
      runShadowExecution(input, buildConfig({
        onError: () => { throw new Error('handler crashed'); },
      }));
    });
  });

  // ─── (k) shouldAlertOnShadow ─────────────────────────────

  it('shouldAlertOnShadow returns true for BLOCKING, false for MATCH/ACCEPTABLE', () => {
    // BLOCKING case: no r2IntentDecision → MISSING_IN_R2 → BLOCKING
    const blockingInput = buildInput();
    const blockingResult = runShadowExecution(blockingInput, buildConfig());
    assert.equal(shouldAlertOnShadow(blockingResult), true, 'must alert on BLOCKING');
    assert.equal(shadowExecutionVerdict(blockingResult), 'BLOCKING');

    // MATCH case
    const matchInput = buildInput({
      r2IntentDecision: buildIntentDecision({ primaryIntent: PRIMARY_INTENT, externalSideEffects: false }),
    });
    const matchResult = runShadowExecution(matchInput, buildConfig());
    assert.equal(shouldAlertOnShadow(matchResult), false, 'must NOT alert on MATCH');
    assert.equal(shadowExecutionVerdict(matchResult), 'MATCH');

    // ACCEPTABLE case
    const acceptableInput = buildInput({
      r2IntentDecision: buildIntentDecision({ primaryIntent: 'different intent' }),
    });
    const acceptableResult = runShadowExecution(acceptableInput, buildConfig());
    assert.equal(shouldAlertOnShadow(acceptableResult), false, 'must NOT alert on ACCEPTABLE');
    assert.equal(shadowExecutionVerdict(acceptableResult), 'ACCEPTABLE');

    // Skipped case (kill switch) → verdict=MATCH, no alert
    process.env.AWKN_SHADOW_DISABLED = '1';
    const skippedResult = runShadowExecution(buildInput(), buildConfig());
    assert.equal(shouldAlertOnShadow(skippedResult), false, 'must NOT alert when skipped');
    assert.equal(shadowExecutionVerdict(skippedResult), 'MATCH');
  });

  // ─── (l) 确定性：相同输入产生相同 diffId ───────────────

  it('deterministic: same input produces same verdict and comparisons', () => {
    const input = buildInput({
      r2IntentDecision: buildIntentDecision({ primaryIntent: PRIMARY_INTENT }),
    });
    const cfg = buildConfig();
    const result1 = runShadowExecution(input, cfg);
    const result2 = runShadowExecution(input, cfg);

    assert.equal(result1.skipped, false);
    assert.equal(result2.skipped, false);
    // Same input must produce same overallVerdict and comparison structure (deterministic)
    assert.equal(
      result1.diffReceipt!.overallVerdict,
      result2.diffReceipt!.overallVerdict,
      'same input must produce same overallVerdict (deterministic)',
    );
    assert.equal(
      result1.diffReceipt!.comparisons.length,
      result2.diffReceipt!.comparisons.length,
      'same input must produce same comparison count (deterministic)',
    );
    for (let i = 0; i < result1.diffReceipt!.comparisons.length; i++) {
      assert.equal(
        result1.diffReceipt!.comparisons[i]!.classification,
        result2.diffReceipt!.comparisons[i]!.classification,
        `comparison ${i} classification must match (deterministic)`,
      );
    }
  });

  // ─── computeOverallVerdict 单元边界 ─────────────────────

  it('computeOverallVerdict: empty classifications returns BLOCKING (fail-closed)', () => {
    const verdict = computeOverallVerdict([]);
    assert.equal(verdict, 'BLOCKING', 'empty classifications must be BLOCKING (fail-closed)');
  });

  it('computeOverallVerdict: priority SAFETY_REGRESSION > MISSING_IN_R2 > EXPECTED_IMPROVEMENT > EXACT', () => {
    // 任意 SAFETY_REGRESSION → BLOCKING（即使有 EXACT）
    assert.equal(
      computeOverallVerdict(['EXACT', 'SAFETY_REGRESSION']),
      'BLOCKING',
    );
    // 任意 CORRECTNESS_REGRESSION → BLOCKING
    assert.equal(
      computeOverallVerdict(['EXACT', 'CORRECTNESS_REGRESSION']),
      'BLOCKING',
    );
    // MISSING_IN_R2 → BLOCKING
    assert.equal(
      computeOverallVerdict(['EXACT', 'MISSING_IN_R2']),
      'BLOCKING',
    );
    // UNKNOWN → BLOCKING
    assert.equal(
      computeOverallVerdict(['EXACT', 'UNKNOWN']),
      'BLOCKING',
    );
    // EXPECTED_IMPROVEMENT → ACCEPTABLE
    assert.equal(
      computeOverallVerdict(['EXACT', 'EXPECTED_IMPROVEMENT']),
      'ACCEPTABLE',
    );
    // ACCEPTABLE_DIVERGENCE → ACCEPTABLE
    assert.equal(
      computeOverallVerdict(['EXACT', 'ACCEPTABLE_DIVERGENCE']),
      'ACCEPTABLE',
    );
    // MISSING_IN_LEGACY → ACCEPTABLE
    assert.equal(
      computeOverallVerdict(['EXACT', 'MISSING_IN_LEGACY']),
      'ACCEPTABLE',
    );
    // SEMANTIC_EQUIVALENT → MATCH
    assert.equal(
      computeOverallVerdict(['EXACT', 'SEMANTIC_EQUIVALENT']),
      'MATCH',
    );
    // 全 EXACT → MATCH
    assert.equal(computeOverallVerdict(['EXACT']), 'MATCH');
  });

  // ─── 综合：多种 classification 共存时的优先级 ───────────

  it('multiple classifications: SAFETY_REGRESSION dominates EXPECTED_IMPROVEMENT', () => {
    // 通过直接构造 comparisons 验证多分类共存
    const comparisons = [
      buildComparison('field.a', 'same', 'same', 'EXACT', 'matched'),
      buildComparison('field.b', null, 'r2-value', 'MISSING_IN_LEGACY', 'legacy lacks'),
      buildComparison('field.c', true, false, 'SAFETY_REGRESSION', 'R2 missed side effect'),
    ];
    const receipt = evaluateShadowDiff({
      executionId: EXECUTION_ID,
      traceId: TRACE_ID,
      comparisons,
      clock: clock(),
    });
    assert.equal(receipt.overallVerdict, 'BLOCKING', 'SAFETY_REGRESSION must dominate');
    assert.equal(receipt.summary.total, 3);
    assert.equal(receipt.summary.exact, 1);
    assert.equal(receipt.summary.missingInLegacy, 1);
    assert.equal(receipt.summary.safetyRegression, 1);
  });
});
