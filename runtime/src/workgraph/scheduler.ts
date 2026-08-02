/**
 * WorkGraph 调度器 — 选择就绪且未分配的工作包执行
 *
 * 基于依赖图状态，选择最多 maxConcurrent 个可立即执行的工作包。
 *
 * 对应契约: contracts/workflow.ts — WorkGraphSchema
 */
import type {
  WorkGraph,
  WorkGraphNode,
  WorkItemState,
  WorkPackage,
} from '../contracts/workflow.js';

/** 阻塞依赖的异常状态：依赖项处于这些状态时，依赖者视为被阻塞 */
const BLOCKING_STATES: ReadonlySet<WorkItemState> = new Set(['BLOCKED', 'FAILED', 'CANCELLED']);

/**
 * 调度下一批可执行的 WorkPackage。
 *
 * 返回最多 maxConcurrent 个满足以下条件的 workpackage ID：
 * 1. 节点类型为 workpackage
 * 2. 状态为 DRAFT 或 READY
 * 3. 尚未被分配（assignedActorId 为空）
 * 4. 所有依赖项均已 CLOSED（比 resolveReady 更严格，不接受 INTEGRATED）
 *
 * 悬空依赖（不在图中）视为未满足，不会被调度。
 */
export function scheduleNext(graph: WorkGraph, maxConcurrent: number): string[] {
  if (maxConcurrent <= 0) return [];

  const nodeById = new Map<string, WorkGraphNode>();
  for (const node of graph.nodes) {
    nodeById.set(node.id, node);
  }

  const scheduled: string[] = [];
  for (const node of graph.nodes) {
    if (scheduled.length >= maxConcurrent) break;
    if (node.type !== 'workpackage') continue;
    if (node.status !== 'DRAFT' && node.status !== 'READY') continue;
    if (node.assignedActorId !== undefined) continue;

    const allDepsClosed = node.dependencies.every((depId) => {
      const dep = nodeById.get(depId);
      return dep !== undefined && dep.status === 'CLOSED';
    });

    if (allDepsClosed) {
      scheduled.push(node.id);
    }
  }
  return scheduled;
}

/**
 * 判断 WorkPackage 是否被阻塞。
 *
 * 当任一依赖项处于 BLOCKED、FAILED 或 CANCELLED 状态时，该 workpackage 被视为阻塞。
 * 依赖项不在图中（悬空依赖）不视为阻塞——它只是尚未就绪。
 */
export function isBlocked(wp: WorkPackage, graph: WorkGraph): boolean {
  const nodeById = new Map<string, WorkGraphNode>();
  for (const node of graph.nodes) {
    nodeById.set(node.id, node);
  }

  for (const depId of wp.dependencies) {
    const dep = nodeById.get(depId);
    if (dep !== undefined && BLOCKING_STATES.has(dep.status)) {
      return true;
    }
  }
  return false;
}
