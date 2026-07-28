/**
 * LegacyGoalManagerAdapter (R2 Shadow Integration Phase 4c)
 *
 * 从 Engine v2 运行时数据中推断 GoalJudgement（后置分析器）。
 *
 * Engine v2 hook 点：
 * - agent-loop.ts runL2(): goalManager.updateGoal(goalId, { state: 'achieved' }, 'model')
 * - Engine v2 没有"显式 GoalJudge"，Goal state 由模型直接标记
 *
 * Adapter 推断策略：
 * - 如果 goal.state === 'achieved'：verdict='ACHIEVED'，从 goal.hao[] 构造 acceptanceResults
 *   - 每个 passed hao → 一个 ObjectRef
 *   - 如果没有 passed hao，verdict='UNKNOWN'（无法确认 achieved 的依据）
 * - 如果 goal.state === 'budget_limited'：verdict='BLOCKED'
 * - 如果 goal.state === 'paused'：verdict='UNKNOWN'
 * - 如果 goal.state === 'active'/'unmet'：根据 gateResults 推断
 *   - 全 PASS → ACHIEVED
 *   - 有 FAIL → NOT_ACHIEVED
 *   - 有 BLOCKED → BLOCKED
 *   - 无 gateResults → UNKNOWN
 *
 * 注意：这是"后置推断"，不是真正的 GoalJudge。
 * Legacy Adapter 输出自己的合约 LegacyGoalAdaptation（不是 GoalJudgement），
 * 因为 Engine v2 没有 GoalSpec / evidenceRecords / acceptanceEvaluations 等数据。
 * Shadow Diff 会比较 LegacyGoalAdaptation.inferredVerdict 与真实 GoalJudgement.verdict。
 */

import type { GoalState } from '../goal/goal-state.js';
import type { GoalJudgement } from '../contracts/goal.js';
import type { GateResult } from '../gates/quality-gates.js';
import type { LegacyAdapterContext, EngineV2GoalSnapshot } from './types.js';

export type LegacyGoalInferredVerdict = GoalJudgement['verdict'];

export type LegacyGoalInferredFrom =
  | 'goal_state_achieved'
  | 'goal_state_budget_limited'
  | 'goal_state_paused'
  | 'goal_state_active'
  | 'goal_state_unmet'
  | 'gate_results';

export interface LegacyGoalAdaptation {
  /** Adapter 合约版本 */
  readonly schema: 'awkn-legacy-goal-adaptation/v1';
  readonly goalId: string;
  readonly runId: string;
  /** 推断的 verdict（与 GoalJudgement.verdict 同枚举） */
  readonly inferredVerdict: LegacyGoalInferredVerdict;
  /** 推断来源 */
  readonly inferredFrom: LegacyGoalInferredFrom;
  /** 推断原因码（用于 Shadow Diff） */
  readonly reasonCodes: readonly string[];
  /** 已通过的 hao 数（用于 Shadow Diff 精度比较） */
  readonly passedHaoCount: number;
  /** 总 hao 数 */
  readonly totalHaoCount: number;
  /** 引用的 gateResults 数量（0 表示未使用 gateResults 推断） */
  readonly gateResultsUsed: number;
  /** Engine v2 期望的 judge version（用于 Shadow Diff 比较） */
  readonly expectedJudgeVersion: string;
  /** Adapter 版本 */
  readonly adapterVersion: 'awkn-legacy-goal-adapter/v1';
  /** 推断时间 */
  readonly adaptedAt: string;
}

function verdictFromGoalState(state: GoalState): {
  verdict: LegacyGoalInferredVerdict;
  from: LegacyGoalInferredFrom;
  reasonCodes: string[];
} {
  switch (state) {
    case 'achieved':
      return {
        verdict: 'ACHIEVED',
        from: 'goal_state_achieved',
        reasonCodes: ['GOAL_STATE_ACHIEVED'],
      };
    case 'budget_limited':
      return {
        verdict: 'BLOCKED',
        from: 'goal_state_budget_limited',
        reasonCodes: ['GOAL_STATE_BUDGET_LIMITED'],
      };
    case 'paused':
      return {
        verdict: 'UNKNOWN',
        from: 'goal_state_paused',
        reasonCodes: ['GOAL_STATE_PAUSED'],
      };
    case 'active':
      // active 需要看 gateResults 进一步推断
      return {
        verdict: 'UNKNOWN',
        from: 'goal_state_active',
        reasonCodes: ['GOAL_STATE_ACTIVE_PENDING_GATES'],
      };
    case 'unmet':
      return {
        verdict: 'NOT_ACHIEVED',
        from: 'goal_state_unmet',
        reasonCodes: ['GOAL_STATE_UNMET'],
      };
    default:
      return {
        verdict: 'UNKNOWN',
        from: 'goal_state_active',
        reasonCodes: [`UNKNOWN_GOAL_STATE:${state}`],
      };
  }
}

function verdictFromGateResults(gateResults: readonly GateResult[]): {
  verdict: LegacyGoalInferredVerdict;
  reasonCodes: string[];
} {
  if (gateResults.length === 0) {
    return { verdict: 'UNKNOWN', reasonCodes: ['NO_GATE_RESULTS'] };
  }
  const allPassed = gateResults.every((r) => r.passed);
  if (allPassed) {
    return { verdict: 'ACHIEVED', reasonCodes: ['ALL_GATES_PASSED'] };
  }
  // 有未通过的 gate → NOT_ACHIEVED（GateResult 无 severity 字段，无法区分 BLOCKED）
  const failedGateNames = gateResults.filter((r) => !r.passed).map((r) => r.name);
  return {
    verdict: 'NOT_ACHIEVED',
    reasonCodes: ['GATE_FAIL_DETECTED', `FAILED_GATES:${failedGateNames.join(',')}`],
  };
}

export function adaptLegacyGoalManager(
  snapshot: EngineV2GoalSnapshot,
  ctx: LegacyAdapterContext,
): LegacyGoalAdaptation {
  const { goal, runId, gateResults, judgeVersion } = snapshot;
  const now = ctx.clock();
  const passedHaoCount = goal.hao.filter((h) => h.passed).length;
  const totalHaoCount = goal.hao.length;

  const stateInference = verdictFromGoalState(goal.state);

  // 如果 goal.state === 'achieved'，但 hao 全部未通过，无法确认依据 → UNKNOWN
  if (stateInference.from === 'goal_state_achieved' && passedHaoCount === 0 && totalHaoCount > 0) {
    return {
      schema: 'awkn-legacy-goal-adaptation/v1',
      goalId: goal.id,
      runId,
      inferredVerdict: 'UNKNOWN',
      inferredFrom: 'goal_state_achieved',
      reasonCodes: ['GOAL_STATE_ACHIEVED_BUT_NO_PASSED_HAO'],
      passedHaoCount,
      totalHaoCount,
      gateResultsUsed: 0,
      expectedJudgeVersion: judgeVersion,
      adapterVersion: 'awkn-legacy-goal-adapter/v1',
      adaptedAt: now,
    };
  }

  // 如果 goal.state === 'active'，用 gateResults 推断
  if (stateInference.from === 'goal_state_active') {
    const gateInference = verdictFromGateResults(gateResults);
    return {
      schema: 'awkn-legacy-goal-adaptation/v1',
      goalId: goal.id,
      runId,
      inferredVerdict: gateInference.verdict,
      inferredFrom: 'gate_results',
      reasonCodes: [...stateInference.reasonCodes, ...gateInference.reasonCodes],
      passedHaoCount,
      totalHaoCount,
      gateResultsUsed: gateResults.length,
      expectedJudgeVersion: judgeVersion,
      adapterVersion: 'awkn-legacy-goal-adapter/v1',
      adaptedAt: now,
    };
  }

  // 其他状态：直接用 stateInference
  return {
    schema: 'awkn-legacy-goal-adaptation/v1',
    goalId: goal.id,
    runId,
    inferredVerdict: stateInference.verdict,
    inferredFrom: stateInference.from,
    reasonCodes: stateInference.reasonCodes,
    passedHaoCount,
    totalHaoCount,
    gateResultsUsed: 0,
    expectedJudgeVersion: judgeVersion,
    adapterVersion: 'awkn-legacy-goal-adapter/v1',
    adaptedAt: now,
  };
}

// 引入 judgeVersion 以保留接口（未来 Shadow Diff 可能用到）
void 0 as unknown as string; // placeholder to ensure judgeVersion import is used
// 注意：judgeVersion 参数当前未使用，保留接口以便未来扩展
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function _judgeVersionPlaceholder(judgeVersion: string): void {
  void judgeVersion;
}
