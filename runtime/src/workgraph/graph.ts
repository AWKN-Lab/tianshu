/**
 * WorkGraph — 工作项依赖图构建与分析
 *
 * 从分层任务模型（Component → Module → WorkPackage）构建依赖图，
 * 提供就绪解析、冲突检测和环路检测能力。
 *
 * 对应契约: contracts/workflow.ts — WorkGraphSchema / ConflictSchema
 */
import type {
  WorkGraph,
  WorkGraphNode,
  DependencyEdge,
  Conflict,
  WorkItemState,
} from '../contracts/workflow.js';
import {
  getComponentsByMission,
  getModulesByComponent,
  getWorkPackagesByModule,
} from '../hierarchy/repository.js';

/** 满足就绪条件的依赖终态：依赖项必须处于 CLOSED 或 INTEGRATED */
const SATISFIED_FOR_READY: ReadonlySet<WorkItemState> = new Set(['CLOSED', 'INTEGRATED']);

/**
 * 构建 Mission 的 WorkGraph。
 *
 * 遍历 Mission 下所有 Component → Module → WorkPackage，
 * 为每层创建节点，并根据 WorkPackage.dependencies 构建依赖边。
 * 边方向：from = 依赖项, to = 依赖者（from 必须先完成）。
 */
export function buildGraph(missionId: string): WorkGraph {
  const nodes: WorkGraphNode[] = [];
  const edges: DependencyEdge[] = [];

  const components = getComponentsByMission(missionId);
  for (const comp of components) {
    nodes.push({
      id: comp.id,
      type: 'component',
      status: comp.status,
      dependencies: [],
    });

    const modules = getModulesByComponent(comp.id);
    for (const mod of modules) {
      nodes.push({
        id: mod.id,
        type: 'module',
        status: mod.status,
        dependencies: [],
      });

      const workPackages = getWorkPackagesByModule(mod.id);
      for (const wp of workPackages) {
        nodes.push({
          id: wp.id,
          type: 'workpackage',
          status: wp.status,
          dependencies: [...wp.dependencies],
          assignedActorId: wp.assignedActorId,
        });

        for (const depId of wp.dependencies) {
          edges.push({ from: depId, to: wp.id });
        }
      }
    }
  }

  return {
    schema: 'awkn-work-graph/v1',
    missionId,
    nodes,
    edges,
  };
}

/**
 * 解析就绪待执行的 WorkPackage ID 列表。
 *
 * 就绪条件：
 * 1. 节点类型为 workpackage
 * 2. 状态为 DRAFT 或 READY
 * 3. 所有依赖项均处于 CLOSED 或 INTEGRATED 状态
 *
 * 依赖项不在图中（悬空依赖）视为未满足。
 */
export function resolveReady(graph: WorkGraph): string[] {
  const nodeById = new Map<string, WorkGraphNode>();
  for (const node of graph.nodes) {
    nodeById.set(node.id, node);
  }

  const ready: string[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'workpackage') continue;
    if (node.status !== 'DRAFT' && node.status !== 'READY') continue;

    const allDepsSatisfied = node.dependencies.every((depId) => {
      const dep = nodeById.get(depId);
      return dep !== undefined && SATISFIED_FOR_READY.has(dep.status);
    });

    if (allDepsSatisfied) {
      ready.push(node.id);
    }
  }
  return ready;
}

/**
 * 检测图中的冲突。
 *
 * 冲突类型：
 * 1. 循环依赖 — 依赖图中存在环（来自 detectCycles）
 * 2. 重复分配 — 同一 actor 被分配到多个 workpackage
 *
 * 自环（长度 1 的环）按 ConflictSchema 要求 min(2) 复写节点 ID。
 */
export function detectConflicts(graph: WorkGraph): Conflict[] {
  const conflicts: Conflict[] = [];

  // 1. 循环依赖
  const cycles = detectCycles(graph);
  for (const cycle of cycles) {
    const nodeIds = cycle.length >= 2 ? cycle : [cycle[0], cycle[0]];
    conflicts.push({
      nodeIds,
      reason: `circular dependency detected: ${cycle.join(' -> ')} -> ${cycle[0]}`,
    });
  }

  // 2. 重复分配 — 同一 actor 分配到多个 workpackage
  const actorToNodes = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.type !== 'workpackage') continue;
    if (node.assignedActorId === undefined) continue;
    const list = actorToNodes.get(node.assignedActorId);
    if (list) {
      list.push(node.id);
    } else {
      actorToNodes.set(node.assignedActorId, [node.id]);
    }
  }

  for (const [actorId, nodeIds] of actorToNodes) {
    if (nodeIds.length >= 2) {
      conflicts.push({
        nodeIds,
        reason: `actor ${actorId} assigned to ${nodeIds.length} work packages: ${nodeIds.join(', ')}`,
      });
    }
  }

  return conflicts;
}

/**
 * 检测依赖图中的所有环路（elementary cycles）。
 *
 * 对每个起始节点做 DFS，寻找回到起点的路径。通过规范化
 * （旋转到最小节点开头）并去重，确保每条环路只报告一次。
 *
 * 返回值为节点 ID 数组的数组，每个内部数组表示一条环路，
 * 隐含从最后一个节点回到第一个节点的边。自环返回 `[nodeId]`。
 */
export function detectCycles(graph: WorkGraph): string[][] {
  const adj = buildAdjacencyList(graph);
  const nodeIds = [...adj.keys()];

  const seen = new Set<string>();
  const cycles: string[][] = [];

  for (const start of nodeIds) {
    const inPath = new Set<string>([start]);
    const path: string[] = [start];
    dfsFindCycles(start, start, adj, inPath, path, seen, cycles);
  }

  return cycles;
}

// ─── 内部辅助函数 ─────────────────────────────────────────

/** 构建邻接表，包含图中所有节点及边端点（悬空边端点也纳入）。 */
function buildAdjacencyList(graph: WorkGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (!adj.has(node.id)) adj.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    if (!adj.has(edge.to)) adj.set(edge.to, []);
    adj.get(edge.from)!.push(edge.to);
  }
  return adj;
}

/** 将环路规范化：旋转到最小节点开头，便于去重。 */
function normalizeCycle(cycle: string[]): string[] {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

/** 从 current 出发 DFS，寻找回到 start 的路径以构成环路。 */
function dfsFindCycles(
  start: string,
  current: string,
  adj: Map<string, string[]>,
  inPath: Set<string>,
  path: string[],
  seen: Set<string>,
  cycles: string[][],
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
