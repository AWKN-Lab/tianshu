/**
 * AgentTeams — M2.1 team-schema（接口部分）
 *
 * 影响层级 [M]：team.json 校验门禁。
 * 校验规则：workerId 唯一、edges/gates 引用的 workerId 必须存在、
 * 审查岗 Worker 必须显式标 isReviewer。
 */
import { z } from 'zod';
import type { TeamDef } from './types.js';

export const teamWorkerSchema = z
  .object({
    workerId: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/i),
    personaId: z.string().min(1),
    capability: z.string().optional(),
    task: z.string().min(1),
    isReviewer: z.boolean().optional(),
  })
  .strict();

export const teamSchema = z
  .object({
    schema: z.literal('awkn-team/v1'),
    teamId: z.string().min(1),
    mission: z.string().min(1),
    mode: z.enum(['sequential', 'parallel', 'review-chain', 'brainstorm']),
    workers: z.array(teamWorkerSchema).min(1),
    edges: z.array(z.object({ from: z.string(), to: z.string() }).strict()).optional(),
    gates: z.array(z.object({ after: z.string(), kind: z.literal('approval'), label: z.string().optional() }).strict()).optional(),
  })
  .strict();

/**
 * 校验 team 定义（schema + 语义引用完整性）。
 * @throws 引用悬空 / workerId 重复时抛错
 */
export function validateTeam(raw: unknown): TeamDef {
  const team = teamSchema.parse(raw) as TeamDef;
  const ids = new Set<string>();
  for (const w of team.workers) {
    if (ids.has(w.workerId)) throw new Error(`[team-schema] workerId 重复：${w.workerId}`);
    ids.add(w.workerId);
  }
  for (const e of team.edges ?? []) {
    if (!ids.has(e.from)) throw new Error(`[team-schema] edge.from 悬空：${e.from}`);
    if (!ids.has(e.to)) throw new Error(`[team-schema] edge.to 悬空：${e.to}`);
    if (e.from === e.to) throw new Error(`[team-schema] edge 自环：${e.from}`);
  }
  for (const g of team.gates ?? []) {
    if (!ids.has(g.after)) throw new Error(`[team-schema] gate.after 悬空：${g.after}`);
  }
  return team;
}
