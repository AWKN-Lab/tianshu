import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentLoop } from '../core/agent-loop.js';
import { collectArtifactBundle } from '../evidence/artifact-bundle.js';
import {
  evaluateTianhuoCicdStop,
  lintGate,
  testGate,
  typecheckGate,
} from '../gates/quality-gates.js';
import { getGoalManager } from '../goal/goal-manager.js';
import type { LlmProvider } from '../llm/types.js';

export interface TianhuoCicdLoopConfig {
  cwd: string;
  goalId: string;
  taskPrompt: string;
  maxCycles: number;
  tianhuoPromptPath: string;
  cicdTesterPromptPath: string;
  tianhuoProvider: LlmProvider;
  cicdTesterProvider: LlmProvider;
  maxTurnsPerCycle: number;
}

export interface TianhuoCicdLoopResult {
  achieved: boolean;
  cycles: number;
  finalText: string;
  lastSummary: string;
  totalTokens: number;
  reason?: string;
}

export async function runTianhuoCicdLoop(config: TianhuoCicdLoopConfig): Promise<TianhuoCicdLoopResult> {
  const gm = getGoalManager();
  const tianhuoPrompt = readFileSync(resolve(config.cwd, config.tianhuoPromptPath), 'utf-8');
  const cicdPrompt = readFileSync(resolve(config.cwd, config.cicdTesterPromptPath), 'utf-8');

  let cycle = 0;
  let feedback = '';
  let totalTokens = 0;
  let lastSummary = '';
  let lastFinalText = '';

  while (cycle < config.maxCycles) {
    cycle++;
    const goal = gm.read(config.goalId);
    if (!goal) return { achieved: false, cycles: cycle, finalText: '', lastSummary, totalTokens, reason: `goal ${config.goalId} 不存在` };
    if (goal.state !== 'active') return { achieved: false, cycles: cycle, finalText: lastFinalText, lastSummary, totalTokens, reason: `goal state=${goal.state}` };

    const cycleStartedAt = Date.now();
    const tianhuoInput = feedback
      ? `${config.taskPrompt}\n\n上一轮打回证据，请逐项修复：\n${feedback}`
      : config.taskPrompt;

    const tianhuoResult = await new AgentLoop({
      cwd: config.cwd,
      enableL2: false,
      callSource: 'sub_agent',
      systemPrompt: tianhuoPrompt,
      provider: config.tianhuoProvider,
      maxTurns: config.maxTurnsPerCycle,
    }).runL1(tianhuoInput);

    totalTokens += tianhuoResult.totalTokens;
    lastFinalText = tianhuoResult.finalText;
    if (tianhuoResult.terminated) {
      return { achieved: false, cycles: cycle, finalText: lastFinalText, lastSummary, totalTokens, reason: `天火 L1 终止：${tianhuoResult.terminationReason}` };
    }

    const gateContext = { cwd: config.cwd, goalId: config.goalId };
    const deterministicGates = await Promise.all([
      typecheckGate({ ...gateContext, typecheckCmd: 'npm run typecheck' }),
      testGate({ ...gateContext, testCmd: 'npm run test:all' }),
      lintGate({ ...gateContext, lintCmd: 'npm run lint' }),
    ]);

    const artifactBundle = await collectArtifactBundle({
      cwd: config.cwd,
      finalText: tianhuoResult.finalText,
      gates: deterministicGates,
    });

    const reviewResult = await new AgentLoop({
      cwd: config.cwd,
      enableL2: false,
      callSource: 'sub_agent',
      systemPrompt: cicdPrompt,
      provider: config.cicdTesterProvider,
      maxTurns: config.maxTurnsPerCycle,
    }).runL1(`基于 Artifact Bundle 审查本轮提交。缺失证据必须判定 FAIL。\n\n${JSON.stringify(artifactBundle, null, 2)}`);

    totalTokens += reviewResult.totalTokens;
    if (reviewResult.terminated) {
      return { achieved: false, cycles: cycle, finalText: lastFinalText, lastSummary, totalTokens, reason: `cicd-tester L1 终止：${reviewResult.terminationReason}` };
    }

    const cycleDurationMs = Date.now() - cycleStartedAt;
    // M3 进阶-15: recordCycle 必须在 evaluateTianhuoCicdStop 之前
    // 让 budgetGate 能拿到本轮真实 token 消耗，避免预算超限仍"假成功"
    gm.recordCycle(
      config.goalId,
      tianhuoResult.totalTokens + reviewResult.totalTokens,
      cycleDurationMs,
    );

    const stopEvaluation = await evaluateTianhuoCicdStop({
      ...gateContext,
      cicdTesterVerdict: reviewResult.finalText,
    });
    lastSummary = stopEvaluation.summary;

    if (stopEvaluation.achieved) {
      gm.updateGoal(config.goalId, { state: 'achieved' }, 'model');
      return { achieved: true, cycles: cycle, finalText: lastFinalText, lastSummary, totalTokens };
    }

    feedback = [
      reviewResult.finalText,
      ...stopEvaluation.results.filter((result) => !result.passed)
        .map((result) => `[${result.name}] ${result.details ?? 'failed'}${result.suggestion ? `\n建议：${result.suggestion}` : ''}`),
    ].join('\n\n');
  }

  return { achieved: false, cycles: cycle, finalText: lastFinalText, lastSummary, totalTokens, reason: `达到最大循环数 ${config.maxCycles}` };
}
