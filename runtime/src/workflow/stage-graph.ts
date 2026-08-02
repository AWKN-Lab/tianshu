/**
 * StageGraph 构建与查询
 *
 * 从标准模板构建 StageGraph，提供就绪解析、后继解析、
 * 环路检测与依赖查询能力。
 *
 * StageGraph 是一个 DAG：边 from → to 表示 from 必须先通过，
 * to 才能开始。条件 'on_pass' 表示 from 通过后触发 to；
 * 'always' 表示无论 from 结果如何都触发 to。
 *
 * 对应契约: contracts/workflow-v2.ts — StageGraph / StageNode / StageEdge
 */
import type {
  StageGraph,
  StageNode,
  StageWorkItemType,
  WorkflowStageType,
} from '../contracts/workflow-v2.js';
import { getTemplateForWorkItemType } from './stage-template.js';

/**
 * 从工作项类型对应的标准模板构建 StageGraph。
 *
 * 为模板中的每个 stage 创建 StageNode，填入 workItemId 与 requiredProfileId，
 * 并复制模板的 edges。可选传入 frozenSourceSha 固定源码快照。
 */
export function buildStageGraph(
  missionId: string,
  workItemType: StageWorkItemType,
  workItemId: string,
  requiredProfileId: string,
  frozenSourceSha?: string,
): StageGraph {
  const template = getTemplateForWorkItemType(workItemType);
  const nodes: StageNode[] = template.stages.map((stage) => ({
    stageType: stage.stageType,
    workItemType,
    workItemId,
    requiredProfileId,
    optional: stage.optional,
  }));
  return {
    schema: 'awkn-stage-graph/v1',
    missionId,
    nodes,
    edges: template.edges.map((edge) => ({ ...edge })),
    frozenSourceSha,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 解析图中处于 READY 状态的 stage 类型列表。
 *
 * READY 定义：无入边（on_pass / always），即无未满足的前置依赖。
 * 这是 StageGraph 的入口节点集合。
 */
export function resolveReadyStages(graph: StageGraph): WorkflowStageType[] {
  const hasIncoming = new Set<WorkflowStageType>();
  for (const edge of graph.edges) {
    if (edge.condition === 'on_pass' || edge.condition === 'always') {
      hasIncoming.add(edge.to);
    }
  }
  return graph.nodes
    .map((node) => node.stageType)
    .filter((stageType) => !hasIncoming.has(stageType));
}

/**
 * 解析给定 stage 通过后变为 READY 的 stage 类型列表。
 *
 * 返回 completedStageType 的 on_pass 直接后继。
 * 对于多前驱 stage，调用方需通过 getStageDependencies 确认
 * 所有前置依赖均已满足。
 */
export function resolveNextStages(
  graph: StageGraph,
  completedStageType: WorkflowStageType,
): WorkflowStageType[] {
  const result: WorkflowStageType[] = [];
  const seen = new Set<WorkflowStageType>();
  for (const edge of graph.edges) {
    if (edge.from !== completedStageType) continue;
    if (edge.condition !== 'on_pass') continue;
    if (seen.has(edge.to)) continue;
    seen.add(edge.to);
    result.push(edge.to);
  }
  return result;
}

/**
 * 检测 StageGraph 中的所有环路（elementary cycles）。
 *
 * 对每个起始节点做 DFS，寻找回到起点的路径。通过规范化
 * （旋转到最小节点开头）并去重，确保每条环路只报告一次。
 *
 * 返回值为 stage 类型数组的数组，每个内部数组表示一条环路，
 * 隐含从最后一个节点回到第一个节点的边。
 */
export function detectStageCycles(graph: StageGraph): WorkflowStageType[][] {
  const adj = buildAdjacencyList(graph);
  const seen = new Set<string>();
  const cycles: WorkflowStageType[][] = [];

  for (const start of adj.keys()) {
    const inPath = new Set<WorkflowStageType>([start]);
    const path: WorkflowStageType[] = [start];
    dfsFindCycles(start, start, adj, inPath, path, seen, cycles);
  }

  return cycles;
}

/**
 * 返回给定 stage 的所有前置依赖 stage 类型（传递闭包）。
 *
 * 遍历 on_pass 边的逆向图，收集所有必须先通过的阶段。
 */
export function getStageDependencies(
  graph: StageGraph,
  stageType: WorkflowStageType,
): WorkflowStageType[] {
  const predecessors = new Map<WorkflowStageType, Set<WorkflowStageType>>();
  for (const node of graph.nodes) {
    predecessors.set(node.stageType, new Set());
  }
  for (const edge of graph.edges) {
    if (edge.condition === 'on_pass') {
      predecessors.get(edge.to)?.add(edge.from);
    }
  }

  const dependencies = new Set<WorkflowStageType>();
  const queue: WorkflowStageType[] = [...(predecessors.get(stageType) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (dependencies.has(current)) continue;
    dependencies.add(current);
    for (const pred of predecessors.get(current) ?? []) {
      if (!dependencies.has(pred)) {
        queue.push(pred);
      }
    }
  }

  return [...dependencies];
}

/**
 * 判断给定 stage 是否标记为可选。
 *
 * 可选 stage 可被调度层跳过；跳过后其后继的依赖解析
 * 由调度层负责处理。
 */
export function isStageOptional(
  graph: StageGraph,
  stageType: WorkflowStageType,
): boolean {
  const node = graph.nodes.find((n) => n.stageType === stageType);
  return node?.optional ?? false;
}

// ─── 内部辅助函数 ─────────────────────────────────────────

/** 构建邻接表，包含图中所有节点及边端点。 */
function buildAdjacencyList(graph: StageGraph): Map<WorkflowStageType, WorkflowStageType[]> {
  const adj = new Map<WorkflowStageType, WorkflowStageType[]>();
  for (const node of graph.nodes) {
    if (!adj.has(node.stageType)) adj.set(node.stageType, []);
  }
  for (const edge of graph.edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    if (!adj.has(edge.to)) adj.set(edge.to, []);
    adj.get(edge.from)!.push(edge.to);
  }
  return adj;
}

/** 将环路规范化：旋转到最小节点开头，便于去重。 */
function normalizeCycle(cycle: WorkflowStageType[]): WorkflowStageType[] {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

/** 从 current 出发 DFS，寻找回到 start 的路径以构成环路。 */
function dfsFindCycles(
  start: WorkflowStageType,
  current: WorkflowStageType,
  adj: Map<WorkflowStageType, WorkflowStageType[]>,
  inPath: Set<WorkflowStageType>,
  path: WorkflowStageType[],
  seen: Set<string>,
  cycles: WorkflowStageType[][],
): void {
  for (const next of adj.get(current) ?? []) {
    if (next === start) {
      const normalized = normalizeCycle([...path]);
      const key = normalized.join('|');
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(normalized);
      }
    } else if (!inPath.has(next)) {
      path.push(next);
      inPath.add(next);
      dfsFindCycles(start, next, adj, inPath, path, seen, cycles);
      path.pop();
      inPath.delete(next);
    }
  }
}
