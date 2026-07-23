/**
 * 场景A：天火 + cicd-tester 循环编排器
 *
 * 业务流程：天火独立规划执行 → 提交产物给 cicd-tester → cicd-tester 跨模型审查 →
 *           评估 5 项停止条件 → 未达标则打回原因回填给天火 → 下一轮
 *
 * 跨模型防互认同：天火用 TRAE，cicd-tester 用 CODEX/MiniMax（通过 provider 字段显式指定）
 *
 * 5 项停止条件（全部确定性）：
 *   1. tsc --noEmit 0 错误
 *   2. vitest run 0 failed
 *   3. eslint . 0 新增
 *   4. cicd-tester 输出 VERDICT: PASS
 *   5. budget 未超限
 */

import { createLogger } from '../core/logger.js';
import { AgentLoop } from '../core/agent-loop.js';
import { getGoalManager } from '../goal/goal-manager.js';
import { evaluateTianhuoCicdStop } from '../gates/quality-gates.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LlmProvider } from '../llm/types.js';

const logger = createLogger('TianhuoCicdLoop');

export interface TianhuoCicdLoopConfig {
  /** 工作目录 */
  cwd: string;
  /** 关联的 goal ID */
  goalId: string;
  /** 任务描述（天火的输入 prompt） */
  taskPrompt: string;
  /** 最大循环数（默认 10） */
  maxCycles: number;
  /** 天火 agent.prompt 相对路径 */
  tianhuoPromptPath: string;
  /** cicd-tester agent.prompt 相对路径 */
  cicdTesterPromptPath: string;
  /** 天火用的 LLM provider（默认 trae） */
  tianhuoProvider: LlmProvider;
  /** cicd-tester 用的 LLM provider（默认 codex，跨模型防互认同） */
  cicdTesterProvider: LlmProvider;
  /** L1 最大轮数（天火每轮内部的 maxTurns，默认 8） */
  maxTurnsPerCycle: number;
}

export interface TianhuoCicdLoopResult {
  /** 是否达到停止条件 */
  achieved: boolean;
  /** 实际循环数 */
  cycles: number;
  /** 天火最终输出文本 */
  finalText: string;
  /** 最后一轮的 gate 结果摘要 */
  lastSummary: string;
  /** 总 token 消耗 */
  totalTokens: number;
  /** 未达标时的原因 */
  reason?: string;
}

export async function runTianhuoCicdLoop(config: TianhuoCicdLoopConfig): Promise<TianhuoCicdLoopResult> {
  const gm = getGoalManager();

  // 加载 agent prompt
  const tianhuoPrompt = readFileSync(resolve(config.cwd, config.tianhuoPromptPath), 'utf-8');
  const cicdPrompt = readFileSync(resolve(config.cwd, config.cicdTesterPromptPath), 'utf-8');

  let cycle = 0;
  let feedbackFromLastCycle = '';
  let totalTokens = 0;
  let lastSummary = '';
  let lastFinalText = '';

  logger.info(`启动天火+cicd-tester循环，goal=${config.goalId}，maxCycles=${config.maxCycles}`);

  while (cycle < config.maxCycles) {
    cycle++;
    const goal = gm.read(config.goalId);
    if (!goal) {
      return { achieved: false, cycles: cycle, finalText: '', lastSummary: '', totalTokens, reason: `goal ${config.goalId} 不存在` };
    }
    if (goal.state !== 'active') {
      return { achieved: false, cycles: cycle, finalText: lastFinalText, lastSummary, totalTokens, reason: `goal state=${goal.state}` };
    }

    logger.info(`--- Cycle ${cycle}/${config.maxCycles} ---`);

    // M3 进阶-15（2026-07-23）：本轮开始时间，用于计算 cycleDurationMs
    const cycleStartedAt = Date.now();

    // 1. 天火用 TRAE 规划+执行
    const tianhuoInput = config.taskPrompt + (feedbackFromLastCycle
      ? `\n\n上一轮 cicd-tester 评审打回原因，请针对性修复：\n${feedbackFromLastCycle}`
      : '');

    const tianhuoLoop = new AgentLoop({
      cwd: config.cwd,
      enableL2: false,
      callSource: 'sub_agent',
      systemPrompt: tianhuoPrompt,
      provider: config.tianhuoProvider,
      maxTurns: config.maxTurnsPerCycle,
    });
    const tianhuoResult = await tianhuoLoop.runL1(tianhuoInput);
    totalTokens += tianhuoResult.totalTokens;
    lastFinalText = tianhuoResult.finalText;

    if (tianhuoResult.terminated) {
      logger.warn(`天火 L1 终止：${tianhuoResult.terminationReason}`);
      return {
        achieved: false, cycles: cycle, finalText: tianhuoResult.finalText,
        lastSummary: '', totalTokens, reason: `天火 L1 终止：${tianhuoResult.terminationReason}`,
      };
    }

    logger.info(`天火完成，产出 ${tianhuoResult.finalText.length} 字符，消耗 ${tianhuoResult.totalTokens} tokens`);

    // 2. cicd-tester 用 CODEX/MiniMax 跨模型审查
    const cicdLoop = new AgentLoop({
      cwd: config.cwd,
      enableL2: false,
      callSource: 'sub_agent',
      systemPrompt: cicdPrompt,
      provider: config.cicdTesterProvider,
      maxTurns: config.maxTurnsPerCycle,
    });
    const reviewResult = await cicdLoop.runL1(
      `审查以下天火提交的产物（输出格式必须为 VERDICT: PASS|FAIL，若 FAIL 需附 ISSUES 清单）：\n\n${tianhuoResult.finalText}`
    );
    totalTokens += reviewResult.totalTokens;

    // M3 进阶-28（2026-07-23）：原版不检查 reviewResult.terminated
    //   若 cicd-tester L1 因 3-strike / 重复模式 / 反思停止 / token 异常终止，
    //   其 finalText 是错误信息（如 "[循环异常：检测到工具调用重复模式，已终止]"）
    //   → 被当作正常评审反馈回填给天火 → 天火尝试"修复"无意义的循环异常信息 → 浪费 cycle
    //   修复：cicd-tester 终止时直接退出外循环，记录到 corrections-ledger
    if (reviewResult.terminated) {
      logger.warn(`cicd-tester L1 终止：${reviewResult.terminationReason}`);
      return {
        achieved: false, cycles: cycle, finalText: tianhuoResult.finalText,
        lastSummary: '', totalTokens, reason: `cicd-tester L1 终止：${reviewResult.terminationReason}`,
      };
    }

    logger.info(`cicd-tester 完成，评审输出 ${reviewResult.finalText.length} 字符`);

    // M3 进阶-15（2026-07-23）：recordCycle 必须在 budgetGate 之前
    //   原版：先 evaluateTianhuoCicdStop（含 budgetGate）后 recordCycle → budgetGate 评估时
    //   本轮 token（天火 + cicd-tester）还没累加到 goal.budget.consumed → 误判 budget 未超限 → 假成功
    //   修复：recordCycle 移到 evaluateTianhuoCicdStop 之前，让 budgetGate 能拿到本轮真实消耗
    //   附带修复：原版 durationMs 传 0，现改为 Date.now() - cycleStartedAt
    const cycleDurationMs = Date.now() - cycleStartedAt;
    gm.recordCycle(
      config.goalId,
      tianhuoResult.totalTokens + reviewResult.totalTokens,
      cycleDurationMs,
    );

    // 3. 评估 5 项停止条件（此时本轮 token 已 recordCycle，budgetGate 能拿到真实累计）
    const stopEval = await evaluateTianhuoCicdStop({
      cwd: config.cwd,
      goalId: config.goalId,
      cicdTesterVerdict: reviewResult.finalText,
    });
    lastSummary = stopEval.summary;

    logger.info(`Cycle ${cycle} 评估：${stopEval.summary}`);

    if (stopEval.achieved) {
      gm.updateGoal(config.goalId, { state: 'achieved' }, 'model');
      logger.info(`场景A 循环达成，共 ${cycle} 轮`);
      return {
        achieved: true, cycles: cycle, finalText: tianhuoResult.finalText,
        lastSummary: stopEval.summary, totalTokens,
      };
    }

    // 4. 打回原因回填给天火，下一轮（recordCycle 已在上面调用，这里不再重复）
    feedbackFromLastCycle = reviewResult.finalText;
  }

  logger.warn(`场景A 达到最大循环数 ${config.maxCycles}，未达成`);
  return {
    achieved: false, cycles: cycle, finalText: lastFinalText,
    lastSummary, totalTokens, reason: `达到最大循环数 ${config.maxCycles}`,
  };
}
