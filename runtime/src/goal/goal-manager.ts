/**
 * Goal 管理器 — 从 awkn-agent 抽取 + SQLite 持久化改造
 *
 * 来源：awkn-agent/src/workflow/goal/goal-manager.ts
 * 改动：
 *   1. logger 换成本地 logger
 *   2. goals Map → SQLite goals 表（启动时加载到内存缓存，写时同步落盘）
 *   3. auditLog → SQLite loop_state 表（简化：只用内存 auditLog，不持久化）
 *
 * L2 Goal-based 循环的核心管理器：
 * - create: 创建目标（含 hao 验收条件 + 默认预算）
 * - updateGoal: 模型可调（只允许改 hao 或标记 achieved）
 * - pauseGoal/resumeGoal: 用户独占
 * - autoPauseIfBudgetLimited: 系统级，预算耗尽自动转 budget_limited
 * - recordCycle: 记录每轮 token/时长消耗
 * - checkDone: 确定性完成度验证
 */

import { createLogger } from '../core/logger.js';
import { queryAll, queryRun } from '../store/db.js';
import type { GoalRow } from '../store/schema.js';
import {
  canTransition,
  checkBudget,
  checkDone,
  defaultBudget,
  type Budget,
  type DoneEvidence,
  type DoneResult,
  type Goal,
  type GoalEvent,
  type GoalState,
  type HaoItem,
} from './goal-state.js';

const logger = createLogger('GoalManager');

/** 审计日志条目 */
interface AuditEntry {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

// ─── SQLite 序列化/反序列化 ────────────────────────────────────────

function goalToRow(goal: Goal): Omit<GoalRow, 'created_at' | 'updated_at'> & { created_at: string; updated_at: string } {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    state: goal.state,
    owner: goal.owner,
    hao: JSON.stringify(goal.hao),
    kan: goal.kan ?? null,
    buzuo: goal.buzuo ?? null,
    budget: goal.budget ? JSON.stringify(goal.budget) : null,
    history: JSON.stringify(goal.history),
    milestones: goal.milestones ? JSON.stringify(goal.milestones) : null,
    target_date: goal.targetDate ?? null,
    created_at: goal.createdAt,
    updated_at: goal.updatedAt,
  };
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    state: row.state as GoalState,
    owner: row.owner,
    hao: JSON.parse(row.hao) as HaoItem[],
    kan: row.kan ?? undefined,
    buzuo: row.buzuo ?? undefined,
    budget: row.budget ? (JSON.parse(row.budget) as Budget) : undefined,
    history: JSON.parse(row.history) as GoalEvent[],
    milestones: row.milestones ? JSON.parse(row.milestones) : undefined,
    targetDate: row.target_date ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── GoalManager ──────────────────────────────────────────────────

export class GoalManager {
  private goals: Map<string, Goal> = new Map();
  private auditLog: AuditEntry[] = [];
  private loaded = false;

  /** 启动时从 SQLite 加载所有 goal 到内存 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const rows = queryAll<GoalRow>('SELECT * FROM goals');
      for (const row of rows) {
        this.goals.set(row.id, rowToGoal(row));
      }
      logger.info(`Loaded ${rows.length} goal(s) from SQLite`);
    } catch (err) {
      logger.error('Failed to load goals from SQLite', { error: String(err) });
    }
  }

  /** 持久化 goal 到 SQLite */
  private persist(goal: Goal): void {
    const row = goalToRow(goal);
    queryRun(
      `INSERT OR REPLACE INTO goals
        (id, title, description, state, owner, hao, kan, buzuo, budget, history, milestones, target_date, created_at, updated_at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.title, row.description, row.state, row.owner,
        row.hao, row.kan, row.buzuo, row.budget, row.history,
        row.milestones, row.target_date, row.created_at, row.updated_at,
      ],
    );
  }

  create(goal: Omit<Goal, 'id' | 'createdAt' | 'updatedAt' | 'state' | 'history'> & { hao?: HaoItem[] }): Goal {
    this.ensureLoaded();
    const id = `goal_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = new Date().toISOString();
    const hao = goal.hao ?? [{ description: goal.description, passed: false }];
    const newGoal: Goal = {
      ...goal,
      id,
      state: 'active',
      hao,
      createdAt: now,
      updatedAt: now,
      history: [{ ts: now, from: null, to: 'active', reason: 'created', actor: 'model' }],
      budget: goal.budget ?? defaultBudget(),
    };
    this.goals.set(id, newGoal);
    this.persist(newGoal);
    this._audit('create_goal', { id, title: goal.title }, true);
    return newGoal;
  }

  read(id: string): Goal | undefined {
    this.ensureLoaded();
    return this.goals.get(id);
  }

  /** 模型可调: 更新目标 — 只允许改 hao 或标记 achieved */
  updateGoal(
    id: string,
    patch: { hao?: HaoItem[]; state?: 'achieved'; reason?: string },
    actor: 'model' | 'user' = 'model',
  ): Goal | null {
    this.ensureLoaded();
    const goal = this.goals.get(id);
    if (!goal) {
      this._audit('update_goal', { id }, false, 'Goal not found');
      return null;
    }

    // 终态不可再改
    if (goal.state === 'achieved' || goal.state === 'unmet') {
      this._audit('update_goal', { id }, false, `Goal already ${goal.state}`);
      return null;
    }

    // 权限硬边界: 模型只能标记 achieved
    if (patch.state !== undefined && patch.state !== 'achieved' && actor === 'model') {
      this._audit('update_goal', { id, patch }, false, `Model cannot set state to '${patch.state}' (user-only)`);
      return null;
    }

    const prev = goal.state;

    if (patch.hao !== undefined) {
      goal.hao = patch.hao;
    }

    // M3 进阶-10（2026-07-23）：标记 achieved 必须检查 canTransition
    // 原版：直接 goal.state = 'achieved'，不检查 canTransition
    // 问题：GOAL_TRANSITIONS 明确限制 paused/budget_limited 不能直接转 achieved
    //   - paused → achieved：模型绕过用户暂停，标记完成（违反用户意图）
    //   - budget_limited → achieved：模型绕过 budgetGate 预算约束，标记完成
    //     （让 budgetGate 的"假失败"判定失效 → 又一个"假达停止条件"假成功方向实例）
    // 修复：检查 canTransition，不合法时返回 null（与 pauseGoal/resumeGoal 一致）
    if (patch.state === 'achieved') {
      if (!canTransition(goal.state, 'achieved')) {
        this._audit(
          'update_goal',
          { id, patch },
          false,
          `Cannot transition from '${goal.state}' to 'achieved' (state machine violation)`,
        );
        return null;
      }
      goal.state = 'achieved';
    }

    goal.updatedAt = new Date().toISOString();
    goal.history.push({
      ts: goal.updatedAt,
      from: prev,
      to: goal.state,
      reason: patch.reason ?? `${actor} update`,
      actor,
    });

    this.persist(goal);
    this._audit('update_goal', { id, patch }, true);
    return goal;
  }

  /** 用户独占: 暂停目标 */
  pauseGoal(id: string, reason = 'user paused'): Goal | null {
    this.ensureLoaded();
    const goal = this.goals.get(id);
    if (!goal) return null;
    if (!canTransition(goal.state, 'paused')) return null;

    const prev = goal.state;
    goal.state = 'paused';
    goal.updatedAt = new Date().toISOString();
    goal.history.push({ ts: goal.updatedAt, from: prev, to: 'paused', reason, actor: 'user' });
    this.persist(goal);
    this._audit('pause_goal', { id }, true);
    return goal;
  }

  /** 用户独占: 恢复目标 */
  resumeGoal(id: string, reason = 'user resumed'): Goal | null {
    this.ensureLoaded();
    const goal = this.goals.get(id);
    if (!goal) return null;
    if (!canTransition(goal.state, 'active')) return null;

    const prev = goal.state;
    goal.state = 'active';
    goal.updatedAt = new Date().toISOString();
    goal.history.push({ ts: goal.updatedAt, from: prev, to: 'active', reason, actor: 'user' });
    this.persist(goal);
    this._audit('resume_goal', { id }, true);
    return goal;
  }

  /** 系统级: 预算耗尽自动转 budget_limited */
  autoPauseIfBudgetLimited(id: string): { changed: boolean; goal: Goal | null } {
    this.ensureLoaded();
    const goal = this.goals.get(id);
    if (!goal) return { changed: false, goal: null };
    if (!goal.budget) return { changed: false, goal };

    if (goal.state === 'achieved' || goal.state === 'unmet') {
      return { changed: false, goal };
    }

    const status = checkBudget(goal);
    if (status.exceeded && goal.state !== 'budget_limited') {
      // M3 进阶-22（2026-07-23）：必须检查 canTransition
      //   原版：直接 goal.state = 'budget_limited'，不检查状态机
      //   问题：GOAL_TRANSITIONS['paused'] = ['active', 'unmet']，不含 budget_limited
      //     → paused 的 goal 被系统级预算覆盖，违反用户暂停意图
      //     → 与 M3 进阶-10 updateGoal 绕过状态机同类（直接设 state 不查 canTransition）
      //     → 违反 "State transitions must use the state machine" 约束
      //   修复：检查 canTransition，不合法时跳过（保持原状态，用户意图优先于系统预算）
      if (!canTransition(goal.state, 'budget_limited')) {
        logger.warn(
          `Cannot auto-pause: transition '${goal.state}' → 'budget_limited' not allowed by state machine (user intent takes priority)`,
        );
        return { changed: false, goal };
      }
      const prev = goal.state;
      goal.state = 'budget_limited';
      goal.updatedAt = new Date().toISOString();
      goal.history.push({
        ts: goal.updatedAt,
        from: prev,
        to: 'budget_limited',
        reason: `budget exceeded (${(status.maxUsage * 100).toFixed(1)}% on ${status.tightest})`,
        actor: 'system',
      });
      this.persist(goal);
      this._audit('auto_pause_budget', { id }, true);
      return { changed: true, goal };
    }
    return { changed: false, goal };
  }

  /** 记录一次 cycle 消耗 */
  recordCycle(id: string, tokens: number, durationMs: number): Goal | null {
    this.ensureLoaded();
    const goal = this.goals.get(id);
    if (!goal) return null;

    // M3 进阶-23（2026-07-23）：非 active 的 goal 不记录消耗（防御性 fail-closed）
    //   原版：不检查 goal.state，即使 paused/achieved/unmet/budget_limited 仍记录消耗
    //   问题：
    //     - paused：用户暂停后循环不应运行，若调用方 bug 导致仍调 recordCycle，会累加消耗
    //       → autoPauseIfBudgetLimited 可能把非法状态转换（M3 进阶-22 已修，但根因是 recordCycle 不该被调用）
    //     - achieved/unmet：终态 goal 不应再消耗 token
    //     - budget_limited：已超限的 goal 不应继续累加（应在 active 转 budget_limited 时停止）
    //   修复：只有 active 的 goal 才记录消耗，其他状态 warn + 跳过
    if (goal.state !== 'active') {
      logger.warn(
        `recordCycle called on non-active goal (state=${goal.state}, id=${id}), skipping — caller should not invoke recordCycle for non-active goals`,
      );
      return goal;
    }

    if (!goal.budget) goal.budget = defaultBudget();
    if (!goal.budget.consumed) goal.budget.consumed = { cycles: 0, tokens: 0, durationMs: 0 };

    goal.budget.consumed.cycles += 1;
    goal.budget.consumed.tokens += tokens;
    goal.budget.consumed.durationMs += durationMs;
    goal.updatedAt = new Date().toISOString();

    this.persist(goal);

    // 自动检查预算
    this.autoPauseIfBudgetLimited(id);
    return goal;
  }

  /** 验证完成度 */
  checkDone(id: string, evidence: DoneEvidence): DoneResult | null {
    this.ensureLoaded();
    const goal = this.goals.get(id);
    if (!goal) return null;
    const result = checkDone(goal, evidence);
    this._audit('check_done', { id, passCount: result.passCount, totalCount: result.totalCount }, true);
    return result;
  }

  /** 获取预算状态 */
  getBudgetStatus(id: string): ReturnType<typeof checkBudget> | null {
    this.ensureLoaded();
    const goal = this.goals.get(id);
    if (!goal) return null;
    return checkBudget(goal);
  }

  delete(id: string): boolean {
    this.ensureLoaded();
    this._audit('clear_goal', { id }, true);
    queryRun('DELETE FROM goals WHERE id = ?', [id]);
    return this.goals.delete(id);
  }

  list(filter?: { owner?: string; state?: GoalState }): Goal[] {
    this.ensureLoaded();
    let goals = Array.from(this.goals.values());
    if (filter?.owner) goals = goals.filter((g) => g.owner === filter.owner);
    if (filter?.state) goals = goals.filter((g) => g.state === filter.state);
    return goals;
  }

  /** 获取审计日志 */
  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }

  private _audit(tool: string, args: Record<string, unknown>, ok: boolean, error?: string): void {
    this.auditLog.push({ ts: new Date().toISOString(), tool, args, ok, error });
  }
}

// Singleton
let manager: GoalManager | null = null;

export function getGoalManager(): GoalManager {
  if (!manager) manager = new GoalManager();
  return manager;
}

export function resetGoalManager(): void {
  manager = null;
}
