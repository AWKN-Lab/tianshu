/**
 * AgentTeams — M2.5 brainstorm-cards（collaborationMode=brainstorm）
 *
 * 影响层级 [C]：吸收自 awkn-agent 的卡片式多角色脑暴编排协议（非前端功能）：
 *   diverge（发散）→ converge（投票收敛 TopN）→ challenge（质疑）→ expand（扩展）
 * 卡片与投票结果落 C4 ArtifactBus 工件；challenge 由 verifier/socrates 承接。
 *
 * 异常契约：无卡片可收敛 → 回退 diverge 重试一轮；仍无卡片 → 抛错。
 * LLM 输出协议：要求返回 JSON（{cards:[...]} 或 {topIds:[...]}），解析失败有确定性回退。
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { TeamWorkerDef, WorkerExecutor } from './types.js';

export interface BrainstormCard {
  id: string;
  title: string;
  rationale: string;
  /** 收敛投票数 */
  votes: number;
  proposer: string;
}

export interface BrainstormResult {
  mission: string;
  cards: BrainstormCard[];
  topCards: BrainstormCard[];
  challenges: string[];
  phases: string[];
}

export interface BrainstormOptions {
  mission: string;
  workers: TeamWorkerDef[];
  /** personaId → 中文名 */
  personaName: (personaId: string) => string;
  executor: WorkerExecutor;
  /** 卡片工件目录 */
  artifactDir: string;
  topN?: number;
  /** diverge 最大重试轮数（无卡片可收敛时回退） */
  maxDivergeRounds?: number;
}

/** 从 LLM 文本中提取首个 JSON 对象/数组（支持 ```json 围栏） */
export function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1]);
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const starts = [firstBrace, firstBracket].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close) {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

function parseCards(raw: unknown, proposer: string, idBase: string): BrainstormCard[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray(raw) ? raw : (raw as { cards?: unknown[] }).cards;
  if (!Array.isArray(list)) return [];
  const out: BrainstormCard[] = [];
  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    if (!title) continue;
    out.push({
      id: `${idBase}-${i + 1}`,
      title,
      rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
      votes: 0,
      proposer,
    });
  }
  return out;
}

async function runPhase(
  opts: BrainstormOptions,
  worker: TeamWorkerDef,
  phaseLabel: string,
  taskPrompt: string,
): Promise<string> {
  const result = await opts.executor({
    workerId: `${worker.workerId}~${phaseLabel}`,
    personaId: worker.personaId,
    personaName: opts.personaName(worker.personaId),
    capability: worker.capability,
    task: taskPrompt,
    mission: opts.mission,
    upstreamArtifacts: [],
    artifactDir: opts.artifactDir,
    isReviewer: false,
  });
  return result.text;
}

/** 执行完整脑暴协议 */
export async function runBrainstorm(opts: BrainstormOptions): Promise<BrainstormResult> {
  if (opts.workers.length === 0) throw new Error('[brainstorm] 至少需要 1 个 Worker 参与脑暴');
  const topN = opts.topN ?? 3;
  const maxRounds = opts.maxDivergeRounds ?? 2;
  const phases: string[] = [];
  let cards: BrainstormCard[] = [];

  // ── 1. diverge（发散）：每个视角产出候选卡 ─────────────
  let round = 0;
  while (cards.length === 0 && round < maxRounds) {
    round++;
    phases.push(`diverge#${round}`);
    for (const worker of opts.workers) {
      const prompt = [
        `头脑风暴·发散阶段（第 ${round} 轮）。主题：${opts.mission}`,
        `请以「${opts.personaName(worker.personaId)}」视角提出 2-4 个创新方案卡片。`,
        '只输出 JSON，格式：{"cards":[{"title":"简短方案名","rationale":"一句话理由"}]}',
        round > 1 ? '上一轮未产出有效卡片，请确保输出合法 JSON。' : '',
      ].join('\n');
      const text = await runPhase(opts, worker, 'diverge', prompt);
      cards.push(...parseCards(extractJson(text), worker.workerId, `${worker.workerId}`));
    }
  }
  if (cards.length === 0) {
    throw new Error('[brainstorm] diverge 两轮均无卡片可收敛，协议回退失败');
  }

  // ── 2. converge（投票收敛 TopN）─────────────────────────
  phases.push('converge');
  const lead = opts.workers[0]!;
  const cardListText = cards.map((c) => `- [${c.id}] ${c.title}（${c.proposer}）：${c.rationale}`).join('\n');
  const convergePrompt = [
    `头脑风暴·收敛阶段。主题：${opts.mission}`,
    '候选卡片：',
    cardListText,
    `请投票收敛出 Top ${topN}。只输出 JSON：{"topIds":["..."]}`,
  ].join('\n');
  const convergeText = await runPhase(opts, lead, 'converge', convergePrompt);
  const convergeJson = extractJson(convergeText) as { topIds?: unknown[] } | null;
  const topIds = Array.isArray(convergeJson?.topIds) ? (convergeJson.topIds.filter((x) => typeof x === 'string') as string[]) : [];

  let topCards = topIds
    .map((id) => cards.find((c) => c.id === id))
    .filter((c): c is BrainstormCard => c !== undefined)
    .slice(0, topN);
  if (topCards.length === 0) {
    // 确定性回退：按提出顺序取 TopN
    topCards = cards.slice(0, topN);
  }
  for (const c of topCards) c.votes += 1;

  // ── 3. challenge（质疑）：verifier/socrates 承接 ─────────
  phases.push('challenge');
  const challenger =
    opts.workers.find((w) => w.personaId === 'verifier' || w.personaId === 'socrates') ??
    opts.workers[opts.workers.length - 1]!;
  const challengePrompt = [
    `头脑风暴·质疑阶段。主题：${opts.mission}`,
    '收敛后的 Top 卡片：',
    topCards.map((c) => `- [${c.id}] ${c.title}：${c.rationale}`).join('\n'),
    `请以「${opts.personaName(challenger.personaId)}」视角逐卡质疑（假设/风险/边界）。`,
    '只输出 JSON：{"challenges":["质疑1","质疑2"]}',
  ].join('\n');
  const challengeText = await runPhase(opts, challenger, 'challenge', challengePrompt);
  const challengeJson = extractJson(challengeText) as { challenges?: unknown[] } | null;
  const challenges = Array.isArray(challengeJson?.challenges)
    ? (challengeJson.challenges.filter((x) => typeof x === 'string') as string[])
    : [challengeText.slice(0, 500)];

  // ── 4. expand（扩展）：吸收质疑后的终版卡 ────────────────
  phases.push('expand');
  const expandPrompt = [
    `头脑风暴·扩展阶段。主题：${opts.mission}`,
    'Top 卡片：',
    topCards.map((c) => `- [${c.id}] ${c.title}：${c.rationale}`).join('\n'),
    '质疑意见：',
    challenges.map((c) => `- ${c}`).join('\n'),
    '请吸收质疑、扩展完善，输出终版卡片。只输出 JSON：{"cards":[{"title":"...","rationale":"..."}]}',
  ].join('\n');
  const expandText = await runPhase(opts, lead, 'expand', expandPrompt);
  const expanded = parseCards(extractJson(expandText), lead.workerId, 'final');

  const result: BrainstormResult = {
    mission: opts.mission,
    cards,
    topCards: expanded.length > 0 ? expanded.slice(0, topN) : topCards,
    challenges,
    phases,
  };

  // 卡片落 C4 工件
  mkdirSync(opts.artifactDir, { recursive: true });
  writeFileSync(join(opts.artifactDir, 'cards.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  return result;
}
