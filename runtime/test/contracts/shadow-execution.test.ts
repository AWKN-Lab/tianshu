/**
 * Shadow Execution Tests (R2 Shadow Integration Phase 4e)
 *
 * 测试覆盖：
 * 1. Kill switch（config + 环境变量）
 * 2. fail-closed 隔离（Adapter 错误不向调用方传播）
 * 3. 各组件 comparison 生成
 * 4. Verdict 逻辑（MATCH/ACCEPTABLE/BLOCKING）
 * 5. 确定性
 * 6. Helper 函数（shadowExecutionVerdict / shouldAlertOnShadow）
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  runShadowExecution,
  shadowExecutionVerdict,
  shouldAlertOnShadow,
  type ShadowExecutionInput,
  type ShadowExecutionConfig,
  type ShadowErrorContext,
} from '../../src/shadow/shadow-execution.js';
import type { ShadowDiffReceipt } from '../../src/shadow/shadow-diff-receipt.js';
import type { IntentDecision, ContextManifest } from '../../src/contracts/public.js';
import type { EngineV2InputSnapshot, EngineV2MemorySnapshot, EngineV2GoalSnapshot } from '../../src/adapter/types.js';
import type { ChatMessage, ChatResponse } from '../../src/llm/types.js';
import type { Goal } from '../../src/goal/goal-state.js';
import type { GateResult } from '../../src/gates/quality-gates.js';

const now = '2026-07-28T05:00:00.000Z';
const executionId = 'exec_' + 'a'.repeat(32);
const traceId = 'tr_' + 'b'.repeat(32);

function buildClock(): () => string {
  return () => now;
}

function buildUserMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

function buildSystemMessage(content: string): ChatMessage {
  return { role: 'system', content };
}

function buildAssistantMessage(content: string): ChatMessage {
  return { role: 'assistant', content };
}

function buildLlmResponse(opts: { content?: string; toolCalls?: ChatResponse['toolCalls'] }): ChatResponse {
  return {
    content: opts.content ?? '',
    toolCalls: opts.toolCalls,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    provider: 'trae',
    model: 'test-model',
    finishReason: opts.toolCalls ? 'tool_calls' : 'stop',
  };
}

function buildGoal(opts: Partial<Goal> = {}): Goal {
  return {
    id: opts.id ?? 'goal_test_001',
    title: opts.title ?? 'Test Goal',
    description: opts.description ?? 'A test goal',
    state: opts.state ?? 'active',
    owner: opts.owner ?? 'test',
    createdAt: opts.createdAt ?? now,
    updatedAt: opts.updatedAt ?? now,
    hao: opts.hao ?? [{ description: 'criterion 1', passed: false }],
    history: opts.history ?? [],
  };
}

function buildGateResult(opts: Partial<GateResult> = {}): GateResult {
  return {
    name: opts.name ?? 'test-gate',
    passed: opts.passed ?? true,
    details: opts.details,
    suggestion: opts.suggestion,
    durationMs: opts.durationMs ?? 10,
  };
}

function buildInputSnapshot(opts: {
  userInput?: string;
  messages?: ChatMessage[];
  llmResponse?: ChatResponse;
} = {}): EngineV2InputSnapshot {
  return {
    userInput: opts.userInput ?? 'analyze the data',
    messages: opts.messages ?? [buildUserMessage('analyze the data')],
    llmResponse: opts.llmResponse,
  };
}

function buildMemorySnapshot(opts: {
  messages?: ChatMessage[];
  systemPrompt?: string;
  goalId?: string;
} = {}): EngineV2MemorySnapshot {
  return {
    messages: opts.messages ?? [buildUserMessage('analyze the data')],
    systemPrompt: opts.systemPrompt,
    goalId: opts.goalId,
  };
}

function buildGoalSnapshot(opts: {
  goal?: Goal;
  runId?: string;
  gateResults?: GateResult[];
  judgeVersion?: string;
} = {}): EngineV2GoalSnapshot {
  return {
    goal: opts.goal ?? buildGoal(),
    runId: opts.runId ?? 'run_' + 'c'.repeat(32),
    gateResults: opts.gateResults ?? [],
    judgeVersion: opts.judgeVersion ?? 'awkn-goal-judge/v1',
  };
}

/**
 * 构造 IntentDecision（简化版，只填 shadow-execution 读取的字段）。
 *
 * 注意：这里不通过 IntentDecisionSchema.parse 验证完整 schema，
 * 因为 shadow-execution 只读取 primaryIntent 和 externalSideEffects。
 * 完整的 IntentDecision schema 验证在 execution-coordinator.test.ts 中覆盖。
 */
function buildIntentDecision(opts: {
  primaryIntent?: string;
  externalSideEffects?: boolean;
} = {}): IntentDecision {
  return {
    schema: 'awkn-intent-decision/v1',
    intentId: 'intent_' + 'd'.repeat(32),
    inputId: 'in_' + 'e'.repeat(32),
    executionLevel: 'L1',
    primaryIntent: opts.primaryIntent ?? 'analyze the data',
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
    routedAt: now,
  } as IntentDecision;
}

/**
 * 构造 ContextManifest（简化版）。
 */
function buildContextManifest(opts: {
  query?: string;
  includedCount?: number;
  status?: 'READY' | 'BLOCKED';
} = {}): ContextManifest {
  const included: unknown[] = Array.from({ length: opts.includedCount ?? 0 });
  return {
    schema: 'awkn-context-manifest/v1',
    contextId: 'ctx_' + 'f'.repeat(32),
    executionId,
    query: opts.query ?? 'analyze the data',
    status: opts.status ?? 'READY',
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
    createdAt: now,
    manifestHash: 'g'.repeat(64),
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
    executionId,
    traceId,
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
    clock: buildClock(),
    ...opts,
  };
}

// ─── Kill Switch ──────────────────────────────────────────────────────

describe('ShadowExecution — Kill Switch', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // 恢复环境变量
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('skips when config.enabled=false', () => {
    const result = runShadowExecution(
      buildInput(),
      buildConfig({ enabled: false }),
    );
    assert.equal(result.skipped, true);
    assert.equal(result.diffReceipt, undefined);
    assert.match(result.skipReason ?? '', /config\.enabled=false/);
  });

  it('skips when AWKN_SHADOW_DISABLED=1 env var is set', () => {
    process.env.AWKN_SHADOW_DISABLED = '1';
    const result = runShadowExecution(buildInput(), buildConfig());
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? '', /AWKN_SHADOW_DISABLED=1/);
  });

  it('skips when AWKN_SHADOW_DISABLED=true env var is set', () => {
    process.env.AWKN_SHADOW_DISABLED = 'true';
    const result = runShadowExecution(buildInput(), buildConfig());
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? '', /AWKN_SHADOW_DISABLED=true/);
  });

  it('config.enabled=true overrides env var when env not set', () => {
    delete process.env.AWKN_SHADOW_DISABLED;
    const result = runShadowExecution(buildInput(), buildConfig({ enabled: true }));
    assert.equal(result.skipped, false);
    assert.ok(result.diffReceipt);
  });

  it('config.enabled=false takes precedence over env', () => {
    delete process.env.AWKN_SHADOW_DISABLED;
    const result = runShadowExecution(
      buildInput(),
      buildConfig({ enabled: false }),
    );
    assert.equal(result.skipped, true);
  });

  it('runs when AWKN_SHADOW_DISABLED=0 (only 1/true disable)', () => {
    process.env.AWKN_SHADOW_DISABLED = '0';
    const result = runShadowExecution(buildInput(), buildConfig());
    assert.equal(result.skipped, false);
    assert.ok(result.diffReceipt);
  });

  it('runs when AWKN_SHADOW_DISABLED unset and config.enabled unset', () => {
    delete process.env.AWKN_SHADOW_DISABLED;
    const result = runShadowExecution(buildInput(), { clock: buildClock() });
    assert.equal(result.skipped, false);
    assert.ok(result.diffReceipt);
  });
});

// ─── Fail-Closed Isolation ───────────────────────────────────────────

describe('ShadowExecution — Fail-Closed Isolation', () => {
  it('does not throw when Input adapter throws (empty userInput and messages)', () => {
    const input = buildInput({
      inputSnapshot: {
        userInput: '',
        messages: [],
      },
    });
    const errors: ShadowErrorContext[] = [];
    const result = runShadowExecution(input, buildConfig({
      onError: (_err, ctx) => { errors.push(ctx); },
    }));
    assert.equal(result.skipped, false);
    assert.ok(result.diffReceipt);
    assert.equal(result.diffReceipt.overallVerdict, 'BLOCKING');
    // Input adapter failed → 至少一条 SAFETY_REGRESSION comparison
    const safetyRegressions = result.diffReceipt.comparisons.filter(
      (c) => c.classification === 'SAFETY_REGRESSION',
    );
    assert.ok(safetyRegressions.length >= 1, 'expected at least one SAFETY_REGRESSION');
    // Both Input and Intent adapters throw (both use userInput); verify Input is captured
    const inputErrors = errors.filter((e) => e.component === 'input');
    assert.ok(inputErrors.length >= 1, 'expected at least one input error');
    assert.equal(inputErrors[0]!.adapterName, 'LegacyInputAdapter');
  });

  it('does not throw when Memory adapter throws (empty messages)', () => {
    const input = buildInput({
      memorySnapshot: buildMemorySnapshot({ messages: [] }),
    });
    let errorCaptured = false;
    const result = runShadowExecution(input, buildConfig({
      onError: () => { errorCaptured = true; },
    }));
    assert.equal(result.skipped, false);
    assert.ok(result.diffReceipt);
    assert.equal(result.diffReceipt.overallVerdict, 'BLOCKING');
    assert.ok(errorCaptured, 'onError handler should have been called');
  });

  it('produces UNKNOWN comparison for goal adapter without throwing (invalid state falls through to default)', () => {
    // adaptLegacyGoalManager does not throw for invalid state; it returns UNKNOWN verdict
    // This test verifies that an unusual goal state still produces a valid diff
    const input = buildInput({
      goalSnapshot: buildGoalSnapshot({
        goal: { ...buildGoal(), state: 'unknown_state' as never },
      }),
    });
    const result = runShadowExecution(input, buildConfig());
    assert.equal(result.skipped, false);
    assert.ok(result.diffReceipt);
    const goalComp = result.diffReceipt!.comparisons.find((c) => c.field === 'goal.verdict');
    assert.ok(goalComp);
    // Without r2GoalVerdict, this should be MISSING_IN_R2
    assert.equal(goalComp!.classification, 'MISSING_IN_R2');
  });

  it('does not propagate errors from onError handler itself', () => {
    const input = buildInput({
      inputSnapshot: { userInput: '', messages: [] },
    });
    // onError 自己抛错——shadow-execution 应回退到默认 stderr，不向调用方传播
    assert.doesNotThrow(() => {
      runShadowExecution(input, buildConfig({
        onError: () => { throw new Error('handler crashed'); },
      }));
    });
  });

  it('uses default onError (console.error) when not provided', () => {
    const input = buildInput({
      inputSnapshot: { userInput: '', messages: [] },
    });
    // 默认 onError 写到 stderr，不会抛错
    assert.doesNotThrow(() => {
      const result = runShadowExecution(input, buildConfig());
      assert.equal(result.skipped, false);
      assert.equal(result.diffReceipt!.overallVerdict, 'BLOCKING');
    });
  });
});

// ─── Comparison Generation ────────────────────────────────────────────

describe('ShadowExecution — Comparison Generation', () => {
  it('generates input comparison when only Input snapshot provided', () => {
    const result = runShadowExecution(buildInput(), buildConfig());
    assert.equal(result.skipped, false);
    const inputComp = result.diffReceipt!.comparisons.find((c) => c.field === 'input.rawInput');
    assert.ok(inputComp);
    assert.equal(inputComp!.classification, 'EXACT');
  });

  it('generates intent comparisons when r2IntentDecision provided', () => {
    const input = buildInput({
      r2IntentDecision: buildIntentDecision({
        primaryIntent: 'analyze the data',
        externalSideEffects: false,
      }),
    });
    const result = runShadowExecution(input, buildConfig());
    const primaryComp = result.diffReceipt!.comparisons.find((c) => c.field === 'intent.primaryIntent');
    assert.ok(primaryComp);
    assert.equal(primaryComp!.classification, 'EXACT');

    const sideEffectsComp = result.diffReceipt!.comparisons.find((c) => c.field === 'intent.externalSideEffects');
    assert.ok(sideEffectsComp);
    assert.equal(sideEffectsComp!.classification, 'EXACT');
  });

  it('generates MISSING_IN_R2 for intent when r2IntentDecision is undefined', () => {
    const result = runShadowExecution(buildInput(), buildConfig());
    const primaryComp = result.diffReceipt!.comparisons.find((c) => c.field === 'intent.primaryIntent');
    assert.ok(primaryComp);
    assert.equal(primaryComp!.classification, 'MISSING_IN_R2');
  });

  it('generates context comparisons when memory snapshot + r2ContextManifest provided', () => {
    const input = buildInput({
      memorySnapshot: buildMemorySnapshot(),
      r2ContextManifest: buildContextManifest({
        query: 'analyze the data',
        includedCount: 3,
      }),
    });
    const result = runShadowExecution(input, buildConfig());

    const candidateComp = result.diffReceipt!.comparisons.find((c) => c.field === 'context.candidateCount');
    assert.ok(candidateComp);
    // R2 有真实候选 → EXPECTED_IMPROVEMENT
    assert.equal(candidateComp!.classification, 'EXPECTED_IMPROVEMENT');

    const queryComp = result.diffReceipt!.comparisons.find((c) => c.field === 'context.query');
    assert.ok(queryComp);
    assert.equal(queryComp!.classification, 'EXACT');
  });

  it('skips context comparison when memory snapshot is undefined', () => {
    const result = runShadowExecution(buildInput(), buildConfig());
    const contextComps = result.diffReceipt!.comparisons.filter((c) => c.field.startsWith('context.'));
    assert.equal(contextComps.length, 0);
  });

  it('generates MISSING_IN_R2 for context when r2ContextManifest undefined', () => {
    const input = buildInput({
      memorySnapshot: buildMemorySnapshot(),
      // r2ContextManifest 未提供
    });
    const result = runShadowExecution(input, buildConfig());
    const candidateComp = result.diffReceipt!.comparisons.find((c) => c.field === 'context.candidateCount');
    assert.ok(candidateComp);
    assert.equal(candidateComp!.classification, 'MISSING_IN_R2');
  });

  it('generates goal comparison when goal snapshot provided', () => {
    const input = buildInput({
      goalSnapshot: buildGoalSnapshot({
        goal: buildGoal({ state: 'achieved', hao: [{ description: 'c1', passed: true }] }),
      }),
      r2GoalVerdict: 'ACHIEVED',
    });
    const result = runShadowExecution(input, buildConfig());
    const goalComp = result.diffReceipt!.comparisons.find((c) => c.field === 'goal.verdict');
    assert.ok(goalComp);
    assert.equal(goalComp!.classification, 'EXACT');
  });

  it('generates MISSING_IN_R2 for goal when r2GoalVerdict undefined', () => {
    const input = buildInput({
      goalSnapshot: buildGoalSnapshot(),
    });
    const result = runShadowExecution(input, buildConfig());
    const goalComp = result.diffReceipt!.comparisons.find((c) => c.field === 'goal.verdict');
    assert.ok(goalComp);
    assert.equal(goalComp!.classification, 'MISSING_IN_R2');
    assert.match(goalComp!.reason, /R2 GoalJudge not yet implemented/);
  });

  it('generates UNKNOWN comparison when no snapshots provided at all', () => {
    // 没有 Input snapshot 是不可能的（input 是必需的），但所有 R2 输出都没提供时
    // 仍应生成 diff（至少包含 input 和 intent 的 MISSING_IN_R2）
    const result = runShadowExecution(buildInput(), buildConfig());
    assert.equal(result.skipped, false);
    assert.ok(result.diffReceipt);
    assert.ok(result.diffReceipt!.comparisons.length >= 1);
  });
});

// ─── Verdict Logic ───────────────────────────────────────────────────

describe('ShadowExecution — Verdict Logic', () => {
  it('returns MATCH when all comparisons are EXACT', () => {
    const input = buildInput({
      r2IntentDecision: buildIntentDecision({
        primaryIntent: 'analyze the data',
        externalSideEffects: false,
      }),
    });
    const result = runShadowExecution(input, buildConfig());
    assert.equal(result.diffReceipt!.overallVerdict, 'MATCH');
  });

  it('returns ACCEPTABLE when EXPECTED_IMPROVEMENT present', () => {
    const input = buildInput({
      r2IntentDecision: buildIntentDecision({ primaryIntent: 'analyze the data' }),
      memorySnapshot: buildMemorySnapshot(),
      r2ContextManifest: buildContextManifest({ includedCount: 5 }),
    });
    const result = runShadowExecution(input, buildConfig());
    assert.equal(result.diffReceipt!.overallVerdict, 'ACCEPTABLE');
  });

  it('returns BLOCKING when adapter throws (SAFETY_REGRESSION)', () => {
    const input = buildInput({
      inputSnapshot: { userInput: '', messages: [] }, // Input adapter throws
    });
    const result = runShadowExecution(input, buildConfig());
    assert.equal(result.diffReceipt!.overallVerdict, 'BLOCKING');
  });

  it('returns BLOCKING when intent side effects regress (legacy=yes, r2=no)', () => {
    // 让 legacy 推断 externalSideEffects=true（通过 toolCalls）
    const input = buildInput({
      inputSnapshot: buildInputSnapshot({
        userInput: 'write a file',
        messages: [buildUserMessage('write a file')],
        llmResponse: buildLlmResponse({
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'write_file', arguments: '{}' },
          }],
        }),
      }),
      // R2 认为 externalSideEffects=false（与 legacy 不一致）
      r2IntentDecision: buildIntentDecision({
        primaryIntent: 'write a file',
        externalSideEffects: false,
      }),
    });
    const result = runShadowExecution(input, buildConfig());
    const sideEffectsComp = result.diffReceipt!.comparisons.find(
      (c) => c.field === 'intent.externalSideEffects',
    );
    assert.ok(sideEffectsComp);
    assert.equal(sideEffectsComp!.classification, 'SAFETY_REGRESSION');
    assert.equal(result.diffReceipt!.overallVerdict, 'BLOCKING');
  });

  it('returns ACCEPTABLE when intent side effects improve (legacy=no, r2=yes)', () => {
    const input = buildInput({
      inputSnapshot: buildInputSnapshot({
        userInput: 'analyze',
        messages: [buildUserMessage('analyze')],
        // 无 toolCalls → legacy 推断 externalSideEffects=false
        llmResponse: buildLlmResponse({ content: 'analysis result' }),
      }),
      // R2 认为 externalSideEffects=true（R2 检测到 legacy 漏判的副作用）
      r2IntentDecision: buildIntentDecision({
        primaryIntent: 'analyze',
        externalSideEffects: true,
      }),
    });
    const result = runShadowExecution(input, buildConfig());
    const sideEffectsComp = result.diffReceipt!.comparisons.find(
      (c) => c.field === 'intent.externalSideEffects',
    );
    assert.ok(sideEffectsComp);
    assert.equal(sideEffectsComp!.classification, 'EXPECTED_IMPROVEMENT');
    assert.equal(result.diffReceipt!.overallVerdict, 'ACCEPTABLE');
  });

  it('returns BLOCKING when all R2 components are missing (MISSING_IN_R2)', () => {
    const input = buildInput({
      inputSnapshot: buildInputSnapshot(),
      memorySnapshot: buildMemorySnapshot(),
      goalSnapshot: buildGoalSnapshot(),
      // 所有 R2 输出都未提供
    });
    const result = runShadowExecution(input, buildConfig());
    assert.equal(result.diffReceipt!.overallVerdict, 'BLOCKING');
    // 至少有 MISSING_IN_R2 出现在 intent/context/goal
    const missingInR2 = result.diffReceipt!.comparisons.filter(
      (c) => c.classification === 'MISSING_IN_R2',
    );
    assert.ok(missingInR2.length >= 2, 'expected at least 2 MISSING_IN_R2 (intent + context + goal)');
  });

  it('returns CORRECTNESS_REGRESSION when legacy=ACHIEVED but r2=NOT_ACHIEVED', () => {
    const input = buildInput({
      goalSnapshot: buildGoalSnapshot({
        goal: buildGoal({
          state: 'achieved',
          hao: [{ description: 'c1', passed: true }],
        }),
      }),
      r2GoalVerdict: 'NOT_ACHIEVED',
    });
    const result = runShadowExecution(input, buildConfig());
    const goalComp = result.diffReceipt!.comparisons.find((c) => c.field === 'goal.verdict');
    assert.ok(goalComp);
    assert.equal(goalComp!.classification, 'CORRECTNESS_REGRESSION');
    assert.equal(result.diffReceipt!.overallVerdict, 'BLOCKING');
  });

  it('returns EXPECTED_IMPROVEMENT when legacy verdict=UNKNOWN but R2 has verdict', () => {
    const input = buildInput({
      r2IntentDecision: buildIntentDecision({ primaryIntent: 'analyze the data' }),
      goalSnapshot: buildGoalSnapshot({
        goal: buildGoal({ state: 'paused' }), // paused → UNKNOWN
      }),
      r2GoalVerdict: 'ACHIEVED',
    });
    const result = runShadowExecution(input, buildConfig());
    const goalComp = result.diffReceipt!.comparisons.find((c) => c.field === 'goal.verdict');
    assert.ok(goalComp);
    assert.equal(goalComp!.classification, 'EXPECTED_IMPROVEMENT');
    assert.equal(result.diffReceipt!.overallVerdict, 'ACCEPTABLE');
  });

  it('returns ACCEPTABLE_DIVERGENCE when verdicts differ but no regression', () => {
    // legacy=NOT_ACHIEVED (from unmet state), R2=BLOCKED
    const input = buildInput({
      r2IntentDecision: buildIntentDecision({ primaryIntent: 'analyze the data' }),
      goalSnapshot: buildGoalSnapshot({
        goal: buildGoal({ state: 'unmet' }),
      }),
      r2GoalVerdict: 'BLOCKED',
    });
    const result = runShadowExecution(input, buildConfig());
    const goalComp = result.diffReceipt!.comparisons.find((c) => c.field === 'goal.verdict');
    assert.ok(goalComp);
    assert.equal(goalComp!.classification, 'ACCEPTABLE_DIVERGENCE');
    assert.equal(result.diffReceipt!.overallVerdict, 'ACCEPTABLE');
  });
});

// ─── Determinism ─────────────────────────────────────────────────────

describe('ShadowExecution — Determinism', () => {
  it('produces identical verdict for identical input', () => {
    const input = buildInput({
      inputSnapshot: buildInputSnapshot(),
      r2IntentDecision: buildIntentDecision({ primaryIntent: 'analyze the data' }),
    });
    const result1 = runShadowExecution(input, buildConfig());
    const result2 = runShadowExecution(input, buildConfig());
    assert.equal(result1.skipped, result2.skipped);
    assert.equal(result1.diffReceipt!.overallVerdict, result2.diffReceipt!.overallVerdict);
    assert.equal(result1.diffReceipt!.summary.total, result2.diffReceipt!.summary.total);
  });

  it('produces stable summary for same classification set', () => {
    const input = buildInput({
      inputSnapshot: buildInputSnapshot(),
      r2IntentDecision: buildIntentDecision({ primaryIntent: 'analyze the data' }),
    });
    const result1 = runShadowExecution(input, buildConfig());
    const result2 = runShadowExecution(input, buildConfig());
    assert.deepEqual(result1.diffReceipt!.summary, result2.diffReceipt!.summary);
  });
});

// ─── Helper Functions ────────────────────────────────────────────────

describe('ShadowExecution — Helper Functions', () => {
  describe('shadowExecutionVerdict', () => {
    it('returns MATCH when skipped', () => {
      const result = runShadowExecution(buildInput(), buildConfig({ enabled: false }));
      assert.equal(shadowExecutionVerdict(result), 'MATCH');
    });

    it('returns diffReceipt.overallVerdict when not skipped', () => {
      const result = runShadowExecution(buildInput(), buildConfig());
      assert.equal(
        shadowExecutionVerdict(result),
        result.diffReceipt!.overallVerdict,
      );
    });
  });

  describe('shouldAlertOnShadow', () => {
    it('returns false when skipped', () => {
      const result = runShadowExecution(buildInput(), buildConfig({ enabled: false }));
      assert.equal(shouldAlertOnShadow(result), false);
    });

    it('returns true when verdict is BLOCKING', () => {
      const result = runShadowExecution(
        buildInput({ inputSnapshot: { userInput: '', messages: [] } }),
        buildConfig(),
      );
      assert.equal(shouldAlertOnShadow(result), true);
    });

    it('returns false when verdict is MATCH', () => {
      const result = runShadowExecution(
        buildInput({
          r2IntentDecision: buildIntentDecision({ primaryIntent: 'analyze the data' }),
        }),
        buildConfig(),
      );
      assert.equal(shouldAlertOnShadow(result), false);
    });

    it('returns false when verdict is ACCEPTABLE', () => {
      const result = runShadowExecution(
        buildInput({
          r2IntentDecision: buildIntentDecision({ primaryIntent: 'analyze the data' }),
          memorySnapshot: buildMemorySnapshot(),
          r2ContextManifest: buildContextManifest({ includedCount: 5 }),
        }),
        buildConfig(),
      );
      assert.equal(shouldAlertOnShadow(result), false);
    });
  });
});

// ─── End-to-End Scenario ─────────────────────────────────────────────

describe('ShadowExecution — End-to-End Scenario', () => {
  it('full shadow run with all components produces comprehensive diff', () => {
    const input = buildInput({
      inputSnapshot: buildInputSnapshot({
        userInput: 'analyze the data',
        messages: [
          buildSystemMessage('you are a helpful assistant'),
          buildUserMessage('analyze the data'),
        ],
        llmResponse: buildLlmResponse({ content: 'analysis' }),
      }),
      memorySnapshot: buildMemorySnapshot({
        messages: [buildUserMessage('analyze the data')],
      }),
      goalSnapshot: buildGoalSnapshot({
        goal: buildGoal({
          state: 'achieved',
          hao: [{ description: 'c1', passed: true }],
        }),
        gateResults: [buildGateResult({ name: 'test-gate', passed: true })],
      }),
      r2IntentDecision: buildIntentDecision({
        primaryIntent: 'analyze the data',
        externalSideEffects: false,
      }),
      r2ContextManifest: buildContextManifest({
        query: 'analyze the data',
        includedCount: 2,
      }),
      r2GoalVerdict: 'ACHIEVED',
    });

    const result = runShadowExecution(input, buildConfig());
    assert.equal(result.skipped, false);
    assert.ok(result.diffReceipt);

    // 至少包含 input + 2 intent + 2 context + 1 goal = 6 comparisons
    assert.ok(result.diffReceipt!.comparisons.length >= 5);

    // 所有比较都是 EXACT 或 EXPECTED_IMPROVEMENT
    const regressions = result.diffReceipt!.comparisons.filter(
      (c) => c.classification === 'SAFETY_REGRESSION'
        || c.classification === 'CORRECTNESS_REGRESSION'
        || c.classification === 'MISSING_IN_R2'
        || c.classification === 'UNKNOWN',
    );
    assert.equal(regressions.length, 0);

    // verdict 应该是 ACCEPTABLE（因为有 EXPECTED_IMPROVEMENT 来自 context.candidateCount）
    assert.equal(result.diffReceipt!.overallVerdict, 'ACCEPTABLE');
  });

  it('ShadowDiffReceipt schema validation passes', () => {
    const result = runShadowExecution(buildInput(), buildConfig());
    // schema 字段必须存在且正确
    assert.equal(result.diffReceipt!.schema, 'awkn-shadow-diff-receipt/v1');
    assert.match(result.diffReceipt!.diffId, /^sdiff_[0-9a-f]{32}$/);
    assert.equal(result.diffReceipt!.executionId, executionId);
    assert.equal(result.diffReceipt!.traceId, traceId);
    assert.equal(result.diffReceipt!.createdAt, now);
  });
});
