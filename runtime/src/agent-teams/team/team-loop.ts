/**
 * AgentTeams — M2.3 team-loop（C2 TeamOrchestrator 状态机）
 *
 * 影响层级 [C]：C2 接口契约 team.start(mission,teamId) / team.status(runId) / team.intervene(runId,directive) 的实现。
 *
 * 状态机：pending → dispatching → running → (gating ⇄ resume) → summarizing → done / failed
 * 四模式：sequential（顺序）/ parallel（波次并行）/ review-chain（审查回灌）/ brainstorm（脑暴卡片协议）
 *
 * 持久化：runtime/data/team-runs/<runId>/{team.json, run.json} —— 引擎重启可恢复。
 * 审查岗独立性：isReviewer Worker 不被被审环节驱动（DAG 由 dag-builder 保证方向）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../core/logger.js';
import { validateTeam } from './team-schema.js';
import { buildTeamDag } from './dag-builder.js';
import { runBrainstorm } from './brainstorm.js';
import { getPersonaRegistry } from '../persona/registry.js';
import { getArtifactStore, ArtifactStore } from '../artifacts/artifact-store.js';
import { CollabEventLog } from '../artifacts/collab-event-log.js';
import { nextPendingGate } from '../gates/gate-hook.js';
import { HeartbeatMonitor } from '../gates/heartbeat.js';
import { createDefaultExecutor } from '../worker/executor.js';
import type { LlmProvider } from '../../llm/types.js';
import type {
  TeamDef,
  TeamRunState,
  WorkerExecutor,
  WorkerNodeResult,
  WorkerTaskInput,
} from './types.js';

const logger = createLogger('TeamLoop');

function defaultRunRoot(): string {
  if (process.env.AWKN_TEAM_RUN_ROOT) return resolve(process.env.AWKN_TEAM_RUN_ROOT);
  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = resolve(here, '..', '..', '..');
  return join(runtimeRoot, 'data', 'team-runs');
}

export interface TeamLoopOptions {
  /** 可注入执行器（测试 stub）；缺省 AgentLoop 实现 */
  executor?: WorkerExecutor;
  artifacts?: ArtifactStore;
  runRoot?: string;
  cwd?: string;
  capabilitiesRoot?: string;
  heartbeat?: HeartbeatMonitor;
  /** Worker 默认 maxTurns */
  maxTurns?: number;
  /** Worker LLM provider；缺省 opencode（不走 trae 桥接），失败经 LlmRouter fallback 到 minimax */
  provider?: LlmProvider;
}

export class TeamLoop {
  private readonly artifacts: ArtifactStore;
  private readonly log: CollabEventLog;

  constructor(private readonly opts: TeamLoopOptions = {}) {
    this.artifacts = opts.artifacts ?? getArtifactStore();
    this.log = new CollabEventLog(this.artifacts);
  }

  private runRoot(): string {
    return this.opts.runRoot ?? defaultRunRoot();
  }

  private runDir(runId: string): string {
    return join(this.runRoot(), runId);
  }

  private persistRun(state: TeamRunState): void {
    const dir = this.runDir(state.runId);
    mkdirSync(dir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    writeFileSync(join(dir, 'run.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  private persistTeam(runId: string, team: TeamDef): void {
    const dir = this.runDir(runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'team.json'), `${JSON.stringify(team, null, 2)}\n`, 'utf-8');
  }

  /** team.start(mission, teamId)：校验→组队→执行（遇 gate 暂停返回） */
  async start(teamRaw: unknown): Promise<TeamRunState> {
    const team = validateTeam(teamRaw);
    const runId = randomUUID();
    const now = new Date().toISOString();
    this.persistTeam(runId, team);

    const state: TeamRunState = {
      schema: 'awkn-team-run/v1',
      runId,
      teamId: team.teamId,
      mission: team.mission,
      mode: team.mode,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      approvedGates: [],
      directives: [],
      workers: team.workers.map((w) => ({ workerId: w.workerId, status: 'pending' as const })),
    };
    this.persistRun(state);
    this.log.append(team.mission, { runId, type: 'team_started', payload: { teamId: team.teamId, mode: team.mode, workerCount: team.workers.length } });

    return this.execute(state, team);
  }

  /** team.status(runId) */
  status(runId: string): TeamRunState | null {
    const file = join(this.runDir(runId), 'run.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8')) as TeamRunState;
  }

  /** 列出全部 run（按创建时间倒序） */
  list(): Array<{ runId: string; teamId: string; status: string; updatedAt: string }> {
    const root = this.runRoot();
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((d) => statSync(join(root, d)).isDirectory())
      .map((d) => this.status(d))
      .filter((s): s is TeamRunState => s !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => ({ runId: s.runId, teamId: s.teamId, status: s.status, updatedAt: s.updatedAt }));
  }

  /** team.intervene(runId, directive)：人工介入。gating 时 = 批准 gate 并恢复 */
  async intervene(runId: string, directive?: string): Promise<TeamRunState> {
    const state = this.status(runId);
    if (!state) throw new Error(`[team-loop] run 不存在：${runId}`);
    if (directive) {
      state.directives.push(directive);
      this.log.append(state.mission, { runId, type: 'intervention', payload: { directive } });
    }
    if (state.status !== 'gating') {
      this.persistRun(state);
      return state;
    }
    // 批准当前 gate 并恢复
    if (state.pendingGate) {
      state.approvedGates.push(state.pendingGate.after);
      this.log.append(state.mission, { runId, type: 'gate_resumed', payload: { after: state.pendingGate.after } });
      state.pendingGate = undefined;
    }
    const team = this.loadTeam(runId);
    if (!team) throw new Error(`[team-loop] team 定义丢失：${runId}`);
    state.status = 'running';
    return this.execute(state, team);
  }

  /** 取消 run */
  cancel(runId: string): TeamRunState {
    const state = this.status(runId);
    if (!state) throw new Error(`[team-loop] run 不存在：${runId}`);
    if (state.status !== 'done' && state.status !== 'failed' && state.status !== 'cancelled') {
      state.status = 'cancelled';
      this.persistRun(state);
    }
    return state;
  }

  private loadTeam(runId: string): TeamDef | null {
    const file = join(this.runDir(runId), 'team.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8')) as TeamDef;
  }

  // ─── 执行引擎 ────────────────────────────────────────────

  private getExecutor(): WorkerExecutor {
    if (this.opts.executor) return this.opts.executor;
    return createDefaultExecutor({
      cwd: this.opts.cwd ?? process.cwd(),
      maxTurns: this.opts.maxTurns,
      heartbeat: this.opts.heartbeat,
      capabilitiesRoot: this.opts.capabilitiesRoot,
      provider: this.opts.provider,
    });
  }

  private personaOf(team: TeamDef) {
    const registry = getPersonaRegistry();
    return (workerId: string) => {
      const w = team.workers.find((x) => x.workerId === workerId);
      return w ? registry.get(w.personaId) : undefined;
    };
  }

  private async execute(state: TeamRunState, team: TeamDef): Promise<TeamRunState> {
    state.status = 'dispatching';
    this.persistRun(state);

    try {
      if (team.mode === 'brainstorm') {
        state.status = 'running';
        this.persistRun(state);
        await this.runBrainstormMode(state, team);
      } else {
        const dag = buildTeamDag(team, this.personaOf(team)); // 环依赖 → 抛错
        state.status = 'running';
        this.persistRun(state);

        if (team.mode === 'sequential') {
          const order = dag.waves.flat();
          for (const workerId of order) {
            const gated = await this.runWorkerAndGate(state, team, [workerId]);
            if (gated) return state;
            if ((state.status as string) === 'failed') return state;
          }
        } else {
          // parallel / review-chain：波次并行
          for (const wave of dag.waves) {
            const gated = await this.runWorkerAndGate(state, team, wave);
            if (gated) return state;
            if ((state.status as string) === 'failed') return state;
          }
        }

        // review-chain：审查结论回灌判定
        if (team.mode === 'review-chain') {
          const failed = this.applyReviewVerdicts(state, team);
          if (failed) {
            state.status = 'failed';
            this.persistRun(state);
            this.log.append(team.mission, { runId: state.runId, type: 'team_failed', payload: { reason: 'review-verdict-fail' } });
            return state;
          }
        }
      }

      // summarizing
      state.status = 'summarizing';
      this.persistRun(state);
      // brainstorm 模式已在 runBrainstormMode 写入脑暴摘要，不覆盖
      if (!state.summary) state.summary = this.buildSummary(state, team);
      state.status = 'done';
      this.persistRun(state);
      this.log.append(team.mission, { runId: state.runId, type: 'team_done' });
      return state;
    } catch (err) {
      state.status = 'failed';
      state.summary = `执行失败：${err instanceof Error ? err.message : String(err)}`;
      this.persistRun(state);
      this.log.append(team.mission, { runId: state.runId, type: 'team_failed', payload: { error: String(err) } });
      return state;
    }
  }

  /** 执行一波 Worker；完成后检查 gate。返回 true 表示已挂起 gating */
  private async runWorkerAndGate(state: TeamRunState, team: TeamDef, wave: string[]): Promise<boolean> {
    const executor = this.getExecutor();
    const results = await Promise.all(wave.map((workerId) => this.runWorker(state, team, workerId, executor)));
    for (const r of results) {
      const node = state.workers.find((w) => w.workerId === r.workerId);
      if (node) Object.assign(node, r);
    }
    this.persistRun(state);

    if (results.some((r) => r.status === 'failed')) {
      state.status = 'failed';
      state.summary = `Worker 执行失败：${results.filter((r) => r.status === 'failed').map((r) => r.workerId).join(', ')}`;
      this.persistRun(state);
      return false;
    }

    // gate 检查
    const completed = new Set(state.workers.filter((w) => w.status === 'done').map((w) => w.workerId));
    const gate = nextPendingGate(team, completed, new Set(state.approvedGates));
    if (gate) {
      state.status = 'gating';
      state.pendingGate = { after: gate.after, label: gate.label };
      this.persistRun(state);
      this.log.append(team.mission, { runId: state.runId, type: 'gate_waiting', payload: { after: gate.after, label: gate.label } });
      return true;
    }
    return false;
  }

  /** 单 Worker 执行（人格注入 + 工件 + 事件） */
  private async runWorker(
    state: TeamRunState,
    team: TeamDef,
    workerId: string,
    executor: WorkerExecutor,
  ): Promise<WorkerNodeResult> {
    const worker = team.workers.find((w) => w.workerId === workerId)!;
    const existing = state.workers.find((w) => w.workerId === workerId);
    if (existing?.status === 'done') return existing; // 恢复时跳过已完成

    const persona = getPersonaRegistry().get(worker.personaId);
    const startedAt = new Date().toISOString();
    const start = Date.now();
    this.log.append(team.mission, { runId: state.runId, type: 'worker_dispatched', workerId, payload: { personaId: worker.personaId, persona: persona?.name } });

    // 上游工件：DAG 入边对应 Worker 的主工件
    const upstreamArtifacts: string[] = [];
    for (const other of state.workers) {
      if (other.workerId === workerId || other.status !== 'done') continue;
      const primary = this.artifacts.primaryArtifact(team.mission, other.workerId);
      if (primary) upstreamArtifacts.push(primary);
    }

    const input: WorkerTaskInput = {
      workerId,
      personaId: worker.personaId,
      personaName: persona?.name ?? worker.personaId,
      capability: worker.capability,
      task: worker.task,
      mission: team.mission,
      upstreamArtifacts,
      artifactDir: this.artifacts.workerDir(team.mission, workerId),
      isReviewer: worker.isReviewer ?? false,
    };

    try {
      const out = await executor(input);
      const verdict = input.isReviewer ? this.readVerdict(team.mission, workerId) : undefined;
      if (input.isReviewer) {
        this.log.append(team.mission, { runId: state.runId, type: 'verdict', workerId, payload: { verdict } });
      }
      this.artifacts.write(team.mission, workerId, 'output.md', out.text.slice(0, 20000));
      this.log.append(team.mission, { runId: state.runId, type: 'worker_done', workerId, payload: { durationMs: Date.now() - start } });
      return {
        workerId,
        status: 'done',
        artifactPath: this.artifacts.primaryArtifact(team.mission, workerId) ?? undefined,
        verdict: input.isReviewer ? verdict ?? null : undefined,
        summary: out.text.slice(0, 500),
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Worker ${workerId} failed: ${msg}`);
      this.log.append(team.mission, { runId: state.runId, type: 'worker_failed', workerId, payload: { error: msg } });
      return { workerId, status: 'failed', error: msg, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - start };
    }
  }

  private readVerdict(mission: string, workerId: string): 'PASS' | 'FAIL' | null {
    try {
      const files = this.artifacts.listWorkerArtifacts(mission, workerId);
      const verdictFile = files.find((f) => f.endsWith('verdict.json'));
      if (!verdictFile) return null;
      const record = JSON.parse(readFileSync(verdictFile, 'utf-8')) as { verdict: 'PASS' | 'FAIL' | null };
      return record.verdict;
    } catch {
      return null;
    }
  }

  /** review-chain 裁决聚合：任一 FAIL/无效 → 失败（结论回灌进 summary） */
  private applyReviewVerdicts(state: TeamRunState, team: TeamDef): boolean {
    const reviewers = team.workers.filter((w) => w.isReviewer);
    if (reviewers.length === 0) return false;
    let failed = false;
    for (const r of reviewers) {
      const node = state.workers.find((w) => w.workerId === r.workerId);
      const verdict = node?.verdict ?? this.readVerdict(team.mission, r.workerId);
      if (node) node.verdict = verdict ?? null;
      if (verdict !== 'PASS') failed = true;
    }
    return failed;
  }

  private async runBrainstormMode(state: TeamRunState, team: TeamDef): Promise<void> {
    const executor = this.getExecutor();
    const registry = getPersonaRegistry();
    const artifactDir = join(this.artifacts.missionDir(team.mission), '_brainstorm');
    const started = Date.now();
    state.workers.forEach((w) => {
      w.status = 'running';
      w.startedAt = new Date().toISOString();
    });
    this.persistRun(state);

    const result = await runBrainstorm({
      mission: team.mission,
      workers: team.workers,
      personaName: (id) => registry.get(id)?.name ?? id,
      executor,
      artifactDir,
    });
    this.log.append(team.mission, {
      runId: state.runId,
      type: 'brainstorm_phase',
      payload: { phases: result.phases, cardCount: result.cards.length, topCount: result.topCards.length },
    });

    state.workers.forEach((w) => {
      w.status = 'done';
      w.finishedAt = new Date().toISOString();
      w.durationMs = Date.now() - started;
      w.artifactPath = join(artifactDir, 'cards.json');
    });
    state.summary = `脑暴完成：${result.cards.length} 候选卡 → Top ${result.topCards.length}：${result.topCards
      .map((c) => c.title)
      .join(' / ')}`;
  }

  private buildSummary(state: TeamRunState, team: TeamDef): string {
    const lines: string[] = [];
    lines.push(`# 团队汇总 — ${team.teamId}`);
    lines.push('');
    lines.push(`使命：${team.mission}`);
    lines.push(`模式：${team.mode}`);
    lines.push('');
    for (const w of state.workers) {
      const def = team.workers.find((d) => d.workerId === w.workerId);
      const personaName = def ? getPersonaRegistry().get(def.personaId)?.name ?? def.personaId : '?';
      const verdictText = w.verdict !== undefined ? `（VERDICT: ${w.verdict ?? 'INVALID'}）` : '';
      lines.push(`## ${w.workerId}（${personaName}）— ${w.status}${verdictText}`);
      if (w.summary) lines.push(w.summary.slice(0, 300));
      if (w.artifactPath) lines.push(`工件：${w.artifactPath}`);
      lines.push('');
    }
    if (state.directives.length > 0) {
      lines.push('## 人工介入指令');
      for (const d of state.directives) lines.push(`- ${d}`);
    }
    return lines.join('\n');
  }
}

let singleton: TeamLoop | null = null;

export function getTeamLoop(opts?: TeamLoopOptions): TeamLoop {
  if (!singleton) singleton = new TeamLoop(opts);
  return singleton;
}

/** team.* 接口契约门面 */
export const team = {
  start: (teamDef: unknown): Promise<TeamRunState> => getTeamLoop().start(teamDef),
  status: (runId: string): TeamRunState | null => getTeamLoop().status(runId),
  intervene: (runId: string, directive?: string): Promise<TeamRunState> => getTeamLoop().intervene(runId, directive),
};
