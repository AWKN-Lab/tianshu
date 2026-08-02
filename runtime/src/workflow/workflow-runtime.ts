/**
 * Workflow Runtime — 工作流执行顶层入口
 *
 * 跨工作项协调 Stage 执行，提供 Mission 级别的启动、状态查询、
 * 阻塞恢复与取消能力。
 *
 * 职责：
 *   - startWorkflow: 初始化 Mission 级阶段（PRODUCT_AUTHOR → … → PLAN_REVIEW），
 *     并对首个就绪阶段发起 best-effort 分配。
 *   - getWorkflowStatus: 按 state 统计 Mission 下全部 StageRun。
 *   - initializeWorkItemStages: 为指定工作项（workpackage / module / component）初始化阶段。
 *   - resumeWorkflow: 解除依赖已满足的 BLOCKED 阶段，将其恢复为 READY。
 *   - cancelWorkflow: 将所有非终态阶段标记为 ROLLED_BACK。
 *
 * 对应契约: contracts/workflow-v2.ts
 * 遵循模式: src/workflow/stage-store.ts, src/workflow/stage-orchestrator.ts
 */
import { attemptAssignment } from '../worker/assignment-service.js';
import {
  STAGE_TERMINAL_STATES,
  type AgentInstanceV2,
  type AgentProfileV2,
  type StageWorkItemType,
  type WorkflowStageRun,
} from '../contracts/workflow-v2.js';
import { transaction } from '../store/db.js';
import { buildStageGraph } from './stage-graph.js';
import { getReadyStages, initializeStages } from './stage-orchestrator.js';
import { getBlockedStageRuns, getStageRunsByMission, updateStageRunState } from './stage-store.js';

// ─── 公共类型 ─────────────────────────────────────────────

export interface WorkflowStartParams {
  readonly missionId: string;
  readonly authorizationEnvelopeId: string;
  readonly frozenInputHash: string;
  readonly frozenSourceSha?: string;
}

export interface WorkflowStatus {
  readonly missionId: string;
  readonly totalStages: number;
  readonly passedStages: number;
  readonly failedStages: number;
  readonly blockedStages: number;
  readonly readyStages: number;
  readonly runningStages: number;
  readonly isComplete: boolean;
}

// ─── 启动 ─────────────────────────────────────────────────

/**
 * 为 Mission 启动新工作流。
 *
 * 使用 MISSION_INIT 模板初始化阶段（workItemType='mission', workItemId=missionId），
 * 随后对首个就绪阶段发起 best-effort 分配（attemptAssignment 为异步，此处 fire-and-forget）。
 *
 * requiredProfileId 使用占位值 'mission-init'；assignment-service 在精确匹配失败时
 * 会按 stageType（specialty）回退到活跃 Profile 匹配。
 */
export function startWorkflow(params: WorkflowStartParams): {
  success: boolean;
  missionInitStages?: WorkflowStageRun[];
  reason?: string;
} {
  try {
    const stages = initializeStages({
      missionId: params.missionId,
      workItemType: 'mission',
      workItemId: params.missionId,
      requiredProfileId: 'mission-init',
      authorizationEnvelopeId: params.authorizationEnvelopeId,
      frozenInputHash: params.frozenInputHash,
      frozenSourceSha: params.frozenSourceSha,
    });

    // Best-effort: 对首个就绪阶段发起异步分配（不阻塞启动返回）。
    const readyStages = getReadyStages(params.missionId, 'mission', params.missionId);
    if (readyStages.length > 0) {
      const priorInstances: AgentInstanceV2[] = [];
      const priorProfiles: AgentProfileV2[] = [];
      void attemptAssignment(
        readyStages[0],
        priorInstances,
        priorProfiles,
        params.authorizationEnvelopeId,
      );
    }

    return { success: true, missionInitStages: stages };
  } catch (err) {
    return {
      success: false,
      reason: `failed to start workflow: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── 状态查询 ─────────────────────────────────────────────

/**
 * 获取 Mission 的工作流状态汇总。
 *
 * 按 StageRunState 统计各状态数量；isComplete 为 true 当且仅当
 * 存在阶段记录且无 READY / RUNNING / BLOCKED / FAILED 阶段。
 */
export function getWorkflowStatus(missionId: string): WorkflowStatus {
  const runs = getStageRunsByMission(missionId);

  let passedStages = 0;
  let failedStages = 0;
  let blockedStages = 0;
  let readyStages = 0;
  let runningStages = 0;

  for (const run of runs) {
    switch (run.state) {
      case 'PASSED':
        passedStages++;
        break;
      case 'FAILED':
        failedStages++;
        break;
      case 'BLOCKED':
        blockedStages++;
        break;
      case 'READY':
        readyStages++;
        break;
      case 'RUNNING':
        runningStages++;
        break;
      // ASSIGNED / PRODUCED / RETRYING / ROLLED_BACK / QUARANTINED 不计入专项统计
    }
  }

  const isComplete =
    runs.length > 0 &&
    failedStages === 0 &&
    blockedStages === 0 &&
    readyStages === 0 &&
    runningStages === 0;

  return {
    missionId,
    totalStages: runs.length,
    passedStages,
    failedStages,
    blockedStages,
    readyStages,
    runningStages,
    isComplete,
  };
}

// ─── 工作项阶段初始化 ─────────────────────────────────────

/**
 * 为 Mission 内的特定工作项（workpackage / module / component）初始化阶段。
 *
 * 直接委托给 stage-orchestrator.initializeStages。
 */
export function initializeWorkItemStages(
  missionId: string,
  workItemType: StageWorkItemType,
  workItemId: string,
  requiredProfileId: string,
  authorizationEnvelopeId: string,
  frozenInputHash: string,
  frozenSourceSha?: string,
): WorkflowStageRun[] {
  return initializeStages({
    missionId,
    workItemType,
    workItemId,
    requiredProfileId,
    authorizationEnvelopeId,
    frozenInputHash,
    frozenSourceSha,
  });
}

// ─── 恢复 ─────────────────────────────────────────────────

/**
 * 恢复阻塞或停滞的工作流。
 *
 * 遍历 BLOCKED 阶段，对每个阶段构建 StageGraph 并检查其 on_pass 前置
 * 是否在同一工作项内均已 PASSED。满足条件则恢复为 READY。
 */
export function resumeWorkflow(missionId: string): { success: boolean; reason?: string } {
  const blocked = getBlockedStageRuns(missionId);
  if (blocked.length === 0) {
    return { success: true };
  }

  return transaction((): { success: boolean; reason?: string } => {
    const allRuns = getStageRunsByMission(missionId);

    for (const run of blocked) {
      const passedInWorkItem = new Set(
        allRuns
          .filter(
            (r) =>
              r.workItemType === run.workItemType &&
              r.workItemId === run.workItemId &&
              r.state === 'PASSED',
          )
          .map((r) => r.stageType),
      );

      const graph = buildStageGraph(
        run.missionId,
        run.workItemType,
        run.workItemId,
        run.requiredProfileId,
        run.frozenSourceSha,
      );
      const predecessors = graph.edges
        .filter((e) => e.to === run.stageType && e.condition === 'on_pass')
        .map((e) => e.from);

      if (predecessors.every((p) => passedInWorkItem.has(p))) {
        updateStageRunState(run.stageRunId, 'READY');
      }
    }

    return { success: true };
  });
}

// ─── 取消 ─────────────────────────────────────────────────

/**
 * 取消工作流：将所有非终态阶段标记为 ROLLED_BACK。
 *
 * 终态阶段（PASSED / FAILED / ROLLED_BACK / QUARANTINED）保持不变。
 * 返回被取消（迁移到 ROLLED_BACK）的阶段数量。
 */
export function cancelWorkflow(missionId: string): { success: boolean; cancelledCount: number } {
  return transaction((): { success: boolean; cancelledCount: number } => {
    const runs = getStageRunsByMission(missionId);
    let cancelledCount = 0;
    for (const run of runs) {
      if (!STAGE_TERMINAL_STATES.has(run.state)) {
        updateStageRunState(run.stageRunId, 'ROLLED_BACK');
        cancelledCount++;
      }
    }
    return { success: true, cancelledCount };
  });
}
