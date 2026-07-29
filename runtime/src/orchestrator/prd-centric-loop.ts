/**
 * 场景B：PRD 核心优化循环编排器
 *
 * 业务流程：目标→PRD→执行计划→工程文档→自评→PRD不一致打回→循环
 *
 * 3 项停止条件：
 *   1. PRD 一致性 ≥ 0.8（确定性算法：hash 交集）
 *   2. awkn-审核 输出 PASS
 *   3. budget 未超限
 *
 * 关键点：orchestrator 不直接调 LLM，全部走 skillTool（读 SKILL.md body 起子 AgentLoop）
 */

import { createLogger } from '../core/logger.js';
import { getGoalManager } from '../goal/goal-manager.js';
import { getSkillsManager } from '../skills/manager.js';
import { AgentLoop } from '../core/agent-loop.js';
import { evaluatePrdConsistency, parseReviewVerdict } from '../gates/prd-consistency.js';
import { budgetGate, recordGateFailures } from '../gates/quality-gates.js';
import { getCorrectionsLedger } from '../evolve/corrections-ledger.js';

const logger = createLogger('PrdCentricLoop');

export interface PrdCentricLoopConfig {
  /** 工作目录 */
  cwd: string;
  /** 关联的 goal ID */
  goalId: string;
  /** 原始目标描述 */
  originalGoal: string;
  /** 最大循环数（默认 5） */
  maxCycles: number;
}

export interface PrdCentricLoopResult {
  /** 是否达到停止条件 */
  achieved: boolean;
  /** 实际循环数 */
  cycles: number;
  /** 最终 PRD 一致性分数（0..1） */
  consistency: number;
  /** 最终 PRD 文本 */
  prd: string;
  /** 未覆盖的需求清单 */
  uncovered: string[];
  /** 总 token 消耗 */
  totalTokens: number;
  /** 未达标时的原因 */
  reason?: string;
}

/** 调用技能：读 SKILL.md body 作为 system prompt，起子 AgentLoop 执行 */
async function callSkill(skillName: string, input: string, cwd: string): Promise<{ text: string; tokens: number }> {
  const sm = getSkillsManager();
  const body = sm.getSkillBody(skillName);
  if (!body) {
    throw new Error(`Skill "${skillName}" not found`);
  }
  const loop = new AgentLoop({
    cwd,
    enableL2: false,
    callSource: 'skill_tool',
    systemPrompt: body,
    excludedTools: ['skill'],
  });
  const result = await loop.runL1(input);

  // M3 进阶-8（2026-07-23）：检查 terminated（与 skill-tool.ts M3 进阶-7 同类修复）
  // 原版：直接返回 { text: result.finalText, tokens: result.totalTokens }，不检查 terminated
  // 问题：子 AgentLoop 可能因 LLM 失败 3 次 / 重复模式 / budget 超限被终止，
  //   此时 finalText 是错误占位文本或空串，但调用方当成功技能输出 → "无信号当成功"同类 bug
  // 修复：terminated 时 throw error，让上层循环 catch 处理
  if (result.terminated) {
    throw new Error(
      `Skill "${skillName}" terminated: ${result.terminationReason ?? 'unknown reason'}`,
    );
  }
  return { text: result.finalText, tokens: result.totalTokens };
}

export async function runPrdCentricLoop(config: PrdCentricLoopConfig): Promise<PrdCentricLoopResult> {
  const gm = getGoalManager();
  let totalTokens = 0;
  // M3 进阶-9（2026-07-23）：recordCycle token 双计 bug 修复（与 agent-loop runL2 M3 进阶-6 同类）
  // 原版：recordCycle(config.goalId, totalTokens, 0) 传累计值，
  //   但 recordCycle 内部 consumed.tokens += tokens（增量累加）→ 多轮循环时 token 双计 → 预算提前耗尽
  // 修复：用增量 token（totalTokens - prevCumulativeTokens）传给 recordCycle
  let prevCumulativeTokens = 0;

  logger.info(`启动 PRD 核心优化循环，goal=${config.goalId}，maxCycles=${config.maxCycles}`);

  // Phase 1: 目标 → PRD（一次性，调 awkn-prd 技能）
  logger.info('Phase 1: 目标 → PRD');
  const prdResult = await callSkill('awkn-prd', config.originalGoal, config.cwd);
  const prd = prdResult.text;
  totalTokens += prdResult.tokens;
  logger.info(`PRD 生成完成，${prd.length} 字符`);

  let cycle = 0;
  let lastConsistency = 0;
  let lastUncovered: string[] = [];

  // Phase 2: PRD 一致性循环
  while (cycle < config.maxCycles) {
    cycle++;
    const goal = gm.read(config.goalId);
    if (!goal) {
      return { achieved: false, cycles: cycle, consistency: 0, prd, uncovered: [], totalTokens, reason: `goal ${config.goalId} 不存在` };
    }
    if (goal.state !== 'active') {
      return { achieved: false, cycles: cycle, consistency: lastConsistency, prd, uncovered: lastUncovered, totalTokens, reason: `goal state=${goal.state}` };
    }

    logger.info(`--- Cycle ${cycle}/${config.maxCycles} ---`);

    // Phase 2a: PRD → 执行计划（调 awkn-spec）
    const uncoveredHint = lastUncovered.length > 0
      ? `\n\n上一轮未覆盖的需求（请针对性补全）：\n${lastUncovered.join('\n')}`
      : '';
    const planResult = await callSkill('awkn-spec', `基于以下 PRD 生成执行计划：\n${prd}${uncoveredHint}`, config.cwd);
    const plan = planResult.text;
    totalTokens += planResult.tokens;

    // Phase 2b: 计划 → 工程文档（调 awkn-工程文档）
    const docsResult = await callSkill('awkn-工程文档', `基于以下执行计划生成工程文档：\n${plan}`, config.cwd);
    const docs = docsResult.text;
    totalTokens += docsResult.tokens;

    // Phase 2c: 自评 PRD 一致性（确定性算法）
    const consistency = evaluatePrdConsistency(prd, [plan, docs]);
    lastConsistency = consistency.consistency;
    lastUncovered = consistency.uncovered.map((u) => `${u.id}: ${u.text}`);

    logger.info(`PRD 一致性 ${(consistency.consistency * 100).toFixed(0)}%，未覆盖 ${consistency.uncovered.length} 项`);

    // 调 awkn-审核 做独立审查
    const reviewResult = await callSkill('awkn-审核', `审查以下计划与文档是否符合 PRD：\n${prd}\n---\n${plan}\n---\n${docs}`, config.cwd);
    totalTokens += reviewResult.tokens;
    const reviewVerdict = parseReviewVerdict(reviewResult.text);

    // M3 进阶-9：用增量 token 调 recordCycle（避免双计）
    // M3 进阶-15（2026-07-23）：recordCycle 必须在 budgetGate 之前
    //   原版：先 budgetGate 后 recordCycle → budgetGate 评估时本轮 token 还没累加到
    //   goal.budget.consumed → 误判 budget 未超限 → 假成功（与 M3 进阶-9 同类"假达停止条件"）
    //   修复：recordCycle 移到 budgetGate 之前，让 budgetGate 能拿到本轮真实消耗
    const incrementalTokens = totalTokens - prevCumulativeTokens;
    prevCumulativeTokens = totalTokens;
    gm.recordCycle(config.goalId, incrementalTokens, 0);

    // Phase 2d: 检查 budget（此时本轮 token 已 recordCycle，budgetGate 能拿到真实累计）
    const budgetResult = await budgetGate({ cwd: config.cwd, goalId: config.goalId });

    // M3 进阶-17：记录失败到 corrections-ledger（自进化闭环入口）
    // - budgetGate 失败 → recordGateFailures（GateResult 格式）
    // - PRD 一致性失败 → 手动 record（非 GateResult 格式）
    // - awkn-审核 未通过 → 手动 record（非 GateResult 格式）
    recordGateFailures(config.goalId, [budgetResult]);
    if (!consistency.passed) {
      try {
        getCorrectionsLedger().record({
          goalId: config.goalId,
          source: 'prd_consistency',
          severity: 'error',
          errorText: `PRD 一致性未通过: ${(consistency.consistency * 100).toFixed(0)}%, 未覆盖 ${consistency.uncovered.length} 项`,
        });
      } catch (e) {
        logger.warn(`Failed to record prd_consistency correction: ${String(e)}`);
      }
    }
    if (reviewVerdict !== 'PASS') {
      try {
        getCorrectionsLedger().record({
          goalId: config.goalId,
          source: 'reviewGate',
          severity: 'error',
          errorText: `awkn-审核 未通过: verdict=${reviewVerdict}`,
        });
      } catch (e) {
        logger.warn(`Failed to record reviewGate correction: ${String(e)}`);
      }
    }

    // 3 项停止条件评估
    const achieved = consistency.passed && reviewVerdict === 'PASS' && budgetResult.passed;

    if (achieved) {
      gm.updateGoal(config.goalId, { state: 'achieved' }, 'model');
      logger.info(`PRD 核心循环达成，共 ${cycle} 轮，一致性 ${(consistency.consistency * 100).toFixed(0)}%`);

      // Phase 3: 复盘（调 awkn-复盘总结）
      await callSkill('AWKN 复盘总结', `PRD 核心优化循环完成，一致性 ${(consistency.consistency * 100).toFixed(0)}%，共 ${cycle} 轮`, config.cwd);

      return {
        achieved: true, cycles: cycle,
        consistency: consistency.consistency, prd,
        uncovered: lastUncovered, totalTokens,
      };
    }

    // 未达标，继续下一轮
    logger.info(`Cycle ${cycle} 未达标：一致性=${consistency.passed}, 审核=${reviewVerdict}, budget=${budgetResult.passed}`);
  }

  logger.warn(`PRD 核心循环达到最大循环数 ${config.maxCycles}，未达成`);
  return {
    achieved: false, cycles: cycle,
    consistency: lastConsistency, prd,
    uncovered: lastUncovered, totalTokens,
    reason: `达到最大循环数 ${config.maxCycles}`,
  };
}
