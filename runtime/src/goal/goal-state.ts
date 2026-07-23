/**
 * Goal 状态定义 — 从 awkn-agent 抽取（零依赖）
 *
 * 来源：awkn-agent/src/workflow/goal/goal-state.ts
 * 改动：无（直接复用）
 *
 * L2 Goal-based 循环的核心数据结构：
 * - Goal: 目标（含 hao 验收条件 + budget 3维预算 + history 状态变更历史）
 * - HaoItem: 可验证标准项（"好"的标准）
 * - Budget: 3 维预算（cycles / tokens / durationMs）
 * - checkDone: 完成度验证（确定性，非描述性）
 */

export type GoalState =
  | 'active'
  | 'paused'
  | 'achieved'
  | 'unmet'
  | 'budget_limited';

/** 预算接口 — 3 维度 */
export interface Budget {
  maxCycles: number;       // 默认 50
  maxTokens: number;       // 默认 5_000_000
  maxDurationMs: number;   // 默认 24h
  warningAt: number;       // 默认 0.8
  consumed?: BudgetConsumed;
}

export interface BudgetConsumed {
  cycles: number;
  tokens: number;
  durationMs: number;
}

/** 单条状态变更事件 */
export interface GoalEvent {
  ts: string;
  from: GoalState | null;
  to: GoalState;
  reason: string;
  actor: 'model' | 'user' | 'system';
}

/** 可验证标准项 */
export interface HaoItem {
  description: string;
  passed: boolean;
  proof?: string;
}

/** 完成验证证据 */
export interface DoneEvidence {
  items: Array<{
    hao: string;
    pass: boolean;
    proof?: string;
  }>;
}

/** 完成验证结果 */
export interface DoneResult {
  done: boolean;
  passCount: number;
  totalCount: number;
  details: Array<{ hao: string; pass: boolean; proof?: string }>;
  suggestion: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  state: GoalState;
  owner: string;
  createdAt: string;
  updatedAt: string;
  targetDate?: string;
  /** 好: 可验证标准 (借鉴 Mavis goal/kan/buzuo/hao) */
  hao: HaoItem[];
  /** 看: 重点文件/模块 */
  kan?: string;
  /** 不做: 边界/禁区 */
  buzuo?: string;
  /** 3 维预算 */
  budget?: Budget;
  /** 状态变更历史 */
  history: GoalEvent[];
  milestones?: Array<{ id: string; title: string; completed: boolean }>;
}

/** 模型可调的操作 (权限硬边界) */
export const MODEL_ALLOWED_OPS = [
  'get_goal',
  'create_goal',
  'update_goal',
  'check_done',
] as const;

/** 用户独占操作 */
export const USER_ONLY_OPS = [
  'clear_goal',
  'pause_goal',
  'resume_goal',
  'transition:paused',
  'transition:active',
  'transition:unmet',
] as const;

export const GOAL_TRANSITIONS: Record<GoalState, GoalState[]> = {
  active: ['paused', 'achieved', 'unmet', 'budget_limited'],
  paused: ['active', 'unmet'],
  achieved: [],
  unmet: ['active'],
  budget_limited: ['active', 'unmet'],
};

export function canTransition(from: GoalState, to: GoalState): boolean {
  return GOAL_TRANSITIONS[from].includes(to);
}

/** 默认预算 */
export function defaultBudget(): Budget {
  return {
    maxCycles: 50,
    maxTokens: 5_000_000,
    maxDurationMs: 24 * 60 * 60 * 1000,
    warningAt: 0.8,
    consumed: { cycles: 0, tokens: 0, durationMs: 0 },
  };
}

/** 检查预算状态 */
export function checkBudget(goal: Goal): {
  ok: boolean;
  warning: boolean;
  exceeded: boolean;
  maxUsage: number;
  tightest: 'cycles' | 'tokens' | 'duration';
  suggestedAction: 'continue' | 'warn_and_continue' | 'pause';
} {
  const b = goal.budget;
  if (!b) {
    return { ok: true, warning: false, exceeded: false, maxUsage: 0, tightest: 'cycles', suggestedAction: 'continue' };
  }

  // M3 进阶-16（2026-07-23）：防御性检查 — budget 字段不完整时 fail-closed
  //   原版：直接 c.tokens / b.maxTokens，若 maxTokens 是 undefined/0 → NaN/Infinity
  //     NaN >= 1.0 → false → exceeded=false → budgetGate passed=true → 假成功
  //     Infinity >= 1.0 → true → exceeded=true（正确，但 maxUsage=Infinity 显示 NaN%）
  //   场景：用户传错格式的 budget（如 max: { tokens: 100 } 而非 maxTokens: 100）
  //   修复：字段缺失或非正数时 fail-closed（exceeded=true, maxUsage=Infinity），让 budgetGate 拒绝通过
  //   原则：预算约束是安全接口，必须 fail-closed（宁可误判超限停循环，不可误判未超限放行）
  if (
    !Number.isFinite(b.maxCycles) || b.maxCycles <= 0 ||
    !Number.isFinite(b.maxTokens) || b.maxTokens <= 0 ||
    !Number.isFinite(b.maxDurationMs) || b.maxDurationMs <= 0
  ) {
    return {
      ok: false,
      warning: false,
      exceeded: true,
      maxUsage: Infinity,
      tightest: 'tokens',
      suggestedAction: 'pause',
    };
  }

  const c = b.consumed ?? { cycles: 0, tokens: 0, durationMs: 0 };
  const u1 = c.cycles / b.maxCycles;
  const u2 = c.tokens / b.maxTokens;
  const u3 = c.durationMs / b.maxDurationMs;
  const maxUsage = Math.max(u1, u2, u3);

  let tightest: 'cycles' | 'tokens' | 'duration' = 'cycles';
  if (u2 >= u1 && u2 >= u3) tightest = 'tokens';
  else if (u3 >= u1 && u3 >= u2) tightest = 'duration';

  const exceeded = maxUsage >= 1.0;
  const warning = !exceeded && maxUsage >= b.warningAt;

  let suggestedAction: 'continue' | 'warn_and_continue' | 'pause' = 'continue';
  if (exceeded) suggestedAction = 'pause';
  else if (warning) suggestedAction = 'warn_and_continue';

  return { ok: !exceeded, warning, exceeded, maxUsage, tightest, suggestedAction };
}

/** 验证完成度 */
export function checkDone(goal: Goal, evidence: DoneEvidence): DoneResult {
  const details: DoneResult['details'] = goal.hao.map((h) => {
    const matched = evidence.items.find((e) => e.hao === h.description);
    return {
      hao: h.description,
      pass: matched ? matched.pass : false,
      proof: matched?.proof,
    };
  });

  const passCount = details.filter((d) => d.pass).length;
  const totalCount = details.length;
  const done = passCount === totalCount;

  let suggestion: string;
  if (done) {
    suggestion = 'All criteria met, can mark as achieved';
  } else if (passCount === 0) {
    suggestion = 'No criteria passed yet, continue working';
  } else {
    const failed = details.filter((d) => !d.pass).map((d) => d.hao);
    suggestion = `Still need: ${failed.join('; ')}`;
  }

  return { done, passCount, totalCount, details, suggestion };
}
