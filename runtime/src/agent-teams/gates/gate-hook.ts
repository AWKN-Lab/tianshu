/**
 * AgentTeams — M5.1 gate-hook（human-in-the-loop 介入点）
 *
 * 影响层级 [M]：关键 gate（批准/部署/拍板）在指定 Worker 完成后暂停 run，
 * 等待用户通过 team.intervene(runId, directive) 批准后恢复。
 * 提取自 AgentTeams-main 的 Human CRD 语义（编排契约重实现，不含 Matrix IM）。
 *
 * 状态由 TeamRunState.pendingGate + approvedGates 持久化，跨进程可恢复。
 */
import type { TeamDef, TeamGateDef } from '../team/types.js';

/**
 * 找到下一个应触发且尚未批准的 gate。
 * @param team 团队定义
 * @param completedWorkers 已完成（done）的 workerId 集合
 * @param approvedGates 已批准的 gate.after 集合
 */
export function nextPendingGate(
  team: TeamDef,
  completedWorkers: ReadonlySet<string>,
  approvedGates: ReadonlySet<string>,
): TeamGateDef | null {
  for (const gate of team.gates ?? []) {
    if (completedWorkers.has(gate.after) && !approvedGates.has(gate.after)) {
      return gate;
    }
  }
  return null;
}

/** gate 是否全部放行（run 可继续到 summarizing） */
export function allGatesCleared(
  team: TeamDef,
  completedWorkers: ReadonlySet<string>,
  approvedGates: ReadonlySet<string>,
): boolean {
  return nextPendingGate(team, completedWorkers, approvedGates) === null;
}
