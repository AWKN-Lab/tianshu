/**
 * Stage Orchestrator — 协调工作项内的 Stage 执行
 *
 * 构建 StageGraph，创建 StageRun，驱动其生命周期：
 * READY → ASSIGNED → RUNNING → PRODUCED → PASSED / FAILED。
 *
 * 职责：
 *   - initializeStages: 从模板构建图并为每个节点创建 READY 状态的 StageRun
 *   - getReadyStages: 解析依赖满足、可被分配的 READY StageRun
 *   - startStage: 将 StageRun 从 READY 推进到 ASSIGNED → RUNNING
 *   - completeStage: 通过 stage-governor 迁移到 PASSED，解析后继阶段
 *   - failStage: 通过 stage-governor 迁移到 FAILED（或 ROLLED_BACK 当超过最大重试）
 *   - isWorkItemComplete: 判断所有必选阶段是否均已 PASSED
 *   - getWorkItemStages: 按 stageType 排序返回工作项全部 StageRun
 *
 * 对应契约: contracts/workflow-v2.ts
 * 遵循模式: src/workflow/stage-store.ts
 */
import {
  STAGE_TERMINAL_STATES,
  type AgentInstanceV2,
  type AgentProfileV2,
  type StageGraph,
  type StageRunState,
  type StageWorkItemType,
  type WorkflowStageRun,
  type WorkflowStageType,
} from '../contracts/workflow-v2.js';
import { transaction } from '../store/db.js';
import { transitionStageState } from '../governor/stage-governor.js';
import {
  buildStageGraph,
  isStageOptional,
  resolveNextStages,
  resolveReadyStages,
} from './stage-graph.js';
import {
  assignStageRun,
  createStageRun,
  getStageRun,
  getStageRunsByWorkItem,
  updateStageRunState,
} from './stage-store.js';

// ─── 公共类型 ─────────────────────────────────────────────

export interface OrchestratorConfig {
  readonly missionId: string;
  readonly workItemType: StageWorkItemType;
  readonly workItemId: string;
  readonly requiredProfileId: string;
  readonly authorizationEnvelopeId: string;
  readonly frozenInputHash: string;
  readonly frozenSourceSha?: string;
}

export interface StageExecutionResult {
  readonly stageRunId: string;
  readonly stageType: WorkflowStageType;
  readonly state: StageRunState;
  readonly outputReceiptId?: string;
}

// ─── 初始化 ───────────────────────────────────────────────

/**
 * 根据模板为工作项初始化所有 StageRun（初始状态 READY）。
 *
 * 从 buildStageGraph 构建图，为每个节点调用 createStageRun。
 * 使用确定性 idempotencyKey（mission:workItemType:workItemId:stageType），
 * 重复初始化会因 UNIQUE 约束抛出错误，实现幂等控制。
 */
export function initializeStages(config: OrchestratorConfig): WorkflowStageRun[] {
  const graph: StageGraph = buildStageGraph(
    config.missionId,
    config.workItemType,
    config.workItemId,
    config.requiredProfileId,
    config.frozenSourceSha,
  );

  return transaction((): WorkflowStageRun[] => {
    const runs: WorkflowStageRun[] = [];
    for (const node of graph.nodes) {
      const idempotencyKey = `init:${config.missionId}:${config.workItemType}:${config.workItemId}:${node.stageType}`;
      const run = createStageRun(
        config.missionId,
        config.workItemType,
        config.workItemId,
        node.stageType,
        config.requiredProfileId,
        config.frozenInputHash,
        config.authorizationEnvelopeId,
        [],
        idempotencyKey,
      );
      runs.push(run);
    }
    return runs;
  });
}

// ─── 就绪解析 ─────────────────────────────────────────────

/**
 * 获取工作项下所有依赖已满足、可被分配的 READY StageRun。
 *
 * 判定逻辑：
 *   1. 入口阶段（无入边，由 resolveReadyStages 给出）始终就绪。
 *   2. 非入口阶段检查每条入边的前置条件：
 *      - on_pass: 前置必须 PASSED
 *      - always:  前置必须处于终态
 *      - on_fail: 前置必须 FAILED
 *      - not_required: 不构成依赖
 */
export function getReadyStages(
  missionId: string,
  workItemType: StageWorkItemType,
  workItemId: string,
): WorkflowStageRun[] {
  const allRuns = getStageRunsByWorkItem(workItemType, workItemId).filter(
    (r) => r.missionId === missionId,
  );
  const readyRuns = allRuns.filter((r) => r.state === 'READY');
  if (readyRuns.length === 0) return [];

  const graph: StageGraph = buildStageGraph(
    missionId,
    workItemType,
    workItemId,
    readyRuns[0].requiredProfileId,
  );

  const entryStages = new Set(resolveReadyStages(graph));
  const passedStageTypes = new Set(
    allRuns.filter((r) => r.state === 'PASSED').map((r) => r.stageType),
  );
  const terminalStageTypes = new Set(
    allRuns.filter((r) => STAGE_TERMINAL_STATES.has(r.state)).map((r) => r.stageType),
  );

  return readyRuns.filter((run) => {
    if (entryStages.has(run.stageType)) return true;
    const incomingEdges = graph.edges.filter((e) => e.to === run.stageType);
    if (incomingEdges.length === 0) return true;
    return incomingEdges.every((edge) => {
      if (edge.condition === 'on_pass') {
        return passedStageTypes.has(edge.from);
      }
      if (edge.condition === 'always') {
        return terminalStageTypes.has(edge.from);
      }
      if (edge.condition === 'on_fail') {
        return allRuns.some((r) => r.stageType === edge.from && r.state === 'FAILED');
      }
      // not_required 或其它条件：不构成阻塞依赖
      return true;
    });
  });
}

// ─── 生命周期驱动 ─────────────────────────────────────────

/**
 * 将 StageRun 从 READY 推进到 ASSIGNED → RUNNING。
 *
 * 仅允许 READY 状态的 StageRun 启动；其它状态返回 undefined。
 * assignStageRun 写入 actor 与租约，随后 updateStageRunState 迁移到 RUNNING。
 */
export function startStage(
  stageRunId: string,
  actorId: string,
  leaseExpiresAt: string,
): WorkflowStageRun | undefined {
  const run = getStageRun(stageRunId);
  if (!run || run.state !== 'READY') return undefined;

  return transaction((): WorkflowStageRun | undefined => {
    assignStageRun(stageRunId, actorId, leaseExpiresAt);
    updateStageRunState(stageRunId, 'RUNNING', actorId);
    return getStageRun(stageRunId);
  });
}

/**
 * 以 PASSED 状态完成 StageRun。
 *
 * 通过 stage-governor 执行终态迁移（含分离策略、receipt 校验等），
 * 迁移成功后解析直接后继阶段（on_pass 边的目标）。
 */
export function completeStage(
  stageRunId: string,
  actorInstance: AgentInstanceV2,
  actorProfile: AgentProfileV2,
  triggerReceiptId: string,
  priorInstances: AgentInstanceV2[],
  priorProfiles: AgentProfileV2[],
  outputReceiptId: string,
  idempotencyKey: string,
): { success: boolean; reason?: string; nextStages?: WorkflowStageType[] } {
  const run = getStageRun(stageRunId);
  if (!run) {
    return { success: false, reason: `stage run not found: ${stageRunId}` };
  }

  const result = transitionStageState({
    stageRunId,
    toState: 'PASSED',
    actorInstance,
    actorProfile,
    triggerReceiptId,
    priorInstances,
    priorProfiles,
    outputReceiptId,
    idempotencyKey,
  });
  if (!result.success) {
    return { success: false, reason: result.reason };
  }

  const graph: StageGraph = buildStageGraph(
    run.missionId,
    run.workItemType,
    run.workItemId,
    run.requiredProfileId,
    run.frozenSourceSha,
  );
  const nextStages = resolveNextStages(graph, run.stageType);
  return { success: true, nextStages };
}

/**
 * 以 FAILED 状态终止 StageRun。
 *
 * 若 attempt >= maxAttempts，迁移目标自动改为 ROLLED_BACK（不可重试）。
 * 否则通过 stage-governor 迁移到 FAILED。
 */
export function failStage(
  stageRunId: string,
  actorInstance: AgentInstanceV2,
  actorProfile: AgentProfileV2,
  triggerReceiptId: string,
  priorInstances: AgentInstanceV2[],
  priorProfiles: AgentProfileV2[],
  idempotencyKey: string,
): { success: boolean; reason?: string; newState?: StageRunState } {
  const run = getStageRun(stageRunId);
  if (!run) {
    return { success: false, reason: `stage run not found: ${stageRunId}` };
  }

  const targetState: StageRunState =
    run.attempt >= actorProfile.maxAttempts ? 'ROLLED_BACK' : 'FAILED';

  const result = transitionStageState({
    stageRunId,
    toState: targetState,
    actorInstance,
    actorProfile,
    triggerReceiptId,
    priorInstances,
    priorProfiles,
    idempotencyKey,
  });

  return {
    success: result.success,
    reason: result.reason,
    newState: result.newState,
  };
}

// ─── 查询 ─────────────────────────────────────────────────

/**
 * 判断工作项是否完成：所有非可选阶段均为 PASSED。
 *
 * 可选阶段（isStageOptional）可处于任意状态，不阻断完成判定。
 */
export function isWorkItemComplete(
  missionId: string,
  workItemType: StageWorkItemType,
  workItemId: string,
): boolean {
  const runs = getStageRunsByWorkItem(workItemType, workItemId).filter(
    (r) => r.missionId === missionId,
  );
  if (runs.length === 0) return false;

  const graph: StageGraph = buildStageGraph(
    missionId,
    workItemType,
    workItemId,
    runs[0].requiredProfileId,
  );

  return runs.every((run) => {
    if (isStageOptional(graph, run.stageType)) return true;
    return run.state === 'PASSED';
  });
}

/**
 * 获取工作项的全部 StageRun，按 stageType 字母序排列。
 */
export function getWorkItemStages(
  missionId: string,
  workItemType: StageWorkItemType,
  workItemId: string,
): WorkflowStageRun[] {
  return getStageRunsByWorkItem(workItemType, workItemId)
    .filter((r) => r.missionId === missionId)
    .sort((a, b) => a.stageType.localeCompare(b.stageType));
}
