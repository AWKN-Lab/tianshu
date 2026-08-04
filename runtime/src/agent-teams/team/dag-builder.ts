/**
 * AgentTeams — M2.2 dag-builder
 *
 * 影响层级 [M]：依 PersonaRole.collaboration.upstream/downstream（吸收映射规则 1）
 * 或 team 显式 edges 生成 Task DAG。环依赖 → 抛错（异常契约）。
 *
 * 边语义：from=上游必须先完成 → to=下游。
 * 自动推导规则（无显式 edges 时）：
 *   - worker B 的 persona.upstream 含 worker A 的 personaId → A→B
 *   - worker A 的 persona.downstream 含 worker B 的 personaId → A→B
 *   - review-chain 模式：全部非审查 Worker → 每个审查 Worker（审查岗消费全量产物）
 */
import type { TeamDef, TeamEdge } from './types.js';
import type { PersonaRole } from '../persona/types.js';

export interface TeamDag {
  edges: TeamEdge[];
  /** 拓扑波次：同波次节点无依赖可并行 */
  waves: string[][];
}

/** Kahn 拓扑排序分波；环依赖抛错 */
export function topoWaves(workerIds: string[], edges: TeamEdge[]): string[][] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of workerIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    adj.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const waves: string[][] = [];
  let frontier = workerIds.filter((id) => (inDegree.get(id) ?? 0) === 0).sort();
  const visited = new Set<string>();

  while (frontier.length > 0) {
    waves.push([...frontier]);
    frontier.forEach((id) => visited.add(id));
    const next = new Set<string>();
    for (const id of frontier) {
      for (const to of adj.get(id) ?? []) {
        inDegree.set(to, (inDegree.get(to) ?? 0) - 1);
        if ((inDegree.get(to) ?? 0) === 0 && !visited.has(to)) next.add(to);
      }
    }
    frontier = [...next].sort();
  }

  if (visited.size !== workerIds.length) {
    const cyclic = workerIds.filter((id) => !visited.has(id));
    throw new Error(`[dag-builder] 环依赖，涉及 Worker：${cyclic.join(', ')}`);
  }
  return waves;
}

/** 去重边 */
function dedupeEdges(edges: TeamEdge[]): TeamEdge[] {
  const seen = new Set<string>();
  const out: TeamEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}->${e.to}`;
    if (!seen.has(key) && e.from !== e.to) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/**
 * 构建团队 DAG。
 * @param team 团队定义
 * @param personaOf workerId → PersonaRole（用于 collaboration 推导）
 */
export function buildTeamDag(team: TeamDef, personaOf: (workerId: string) => PersonaRole | undefined): TeamDag {
  const workerIds = team.workers.map((w) => w.workerId);
  const personaIdByWorker = new Map(team.workers.map((w) => [w.workerId, w.personaId]));
  let edges: TeamEdge[];

  if (team.edges && team.edges.length > 0) {
    edges = dedupeEdges(team.edges);
  } else {
    edges = [];
    const reviewerIds = new Set(team.workers.filter((w) => w.isReviewer).map((w) => w.workerId));
    for (const w of team.workers) {
      // review-chain：审查岗入边由下方规则保证（产出→审查），不参与 collaboration 推导，防环
      if (team.mode === 'review-chain' && reviewerIds.has(w.workerId)) continue;
      const p = personaOf(w.workerId);
      if (!p?.collaboration) continue;
      for (const other of team.workers) {
        if (other.workerId === w.workerId) continue;
        // review-chain：指向审查岗的 collaboration 边由规则覆盖，跳过
        if (team.mode === 'review-chain' && reviewerIds.has(other.workerId)) continue;
        const otherPersonaId = personaIdByWorker.get(other.workerId);
        // w 的 upstream 含 other 的 persona → other→w
        if (p.collaboration.upstream.includes(otherPersonaId ?? '')) {
          edges.push({ from: other.workerId, to: w.workerId });
        }
        // w 的 downstream 含 other 的 persona → w→other
        if (p.collaboration.downstream.includes(otherPersonaId ?? '')) {
          edges.push({ from: w.workerId, to: other.workerId });
        }
      }
    }
    // review-chain：全部产出 Worker → 审查 Worker（独立审查岗消费全量）
    if (team.mode === 'review-chain') {
      const reviewers = team.workers.filter((w) => w.isReviewer);
      const producers = team.workers.filter((w) => !w.isReviewer);
      for (const r of reviewers) {
        for (const p of producers) {
          edges.push({ from: p.workerId, to: r.workerId });
        }
      }
    }
    edges = dedupeEdges(edges);
  }

  const waves = topoWaves(workerIds, edges);
  return { edges, waves };
}
