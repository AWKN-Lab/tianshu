/**
 * AgentTeams — M2.1 team-schema 数据契约
 *
 * 影响层级 [M]：C2 团队编排的数据事实源。
 * 提取自 AgentTeams-main 的 Team/Worker/Human 资源语义（编排契约重实现，不含 K8s）。
 * collaborationMode 四模式 = swarm 三模式（sequential/parallel/review-chain）+ 脑暴（brainstorm）。
 */

export type CollaborationMode = 'sequential' | 'parallel' | 'review-chain' | 'brainstorm';

/** team-loop 状态机：pending→dispatching→running→gating→summarizing→done/failed */
export type TeamRunStatus = 'pending' | 'dispatching' | 'running' | 'gating' | 'summarizing' | 'done' | 'failed' | 'cancelled';

export interface TeamWorkerDef {
  /** Worker 实例 id（team 内唯一） */
  workerId: string;
  /** 人格库 id（agents/personas/<id>.json） */
  personaId: string;
  /** capability 工种骨架（capabilities/project 环节 id），可选 */
  capability?: string;
  /** 该 Worker 的任务描述 */
  task: string;
  /** 独立审查 Worker（不被被审环节驱动，审查岗） */
  isReviewer?: boolean;
}

export interface TeamEdge {
  /** 上游 workerId（必须先完成） */
  from: string;
  /** 下游 workerId */
  to: string;
}

export interface TeamGateDef {
  /** 挂在哪个 workerId 完成后 */
  after: string;
  /** gate 类型（approval=人工拍板） */
  kind: 'approval';
  label?: string;
}

export interface TeamDef {
  schema: 'awkn-team/v1';
  teamId: string;
  /** 使命描述 */
  mission: string;
  mode: CollaborationMode;
  workers: TeamWorkerDef[];
  /** 显式 DAG 边；缺省时由 persona.collaboration 自动推导 */
  edges?: TeamEdge[];
  /** human-in-the-loop 介入点 */
  gates?: TeamGateDef[];
}

// ─── 运行时状态 ─────────────────────────────────────────

export type WorkerNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface WorkerNodeResult {
  workerId: string;
  status: WorkerNodeStatus;
  /** 工件相对路径（C4 ArtifactBus） */
  artifactPath?: string;
  /** 审查 Worker 的裁决（VERDICT: PASS|FAIL） */
  verdict?: 'PASS' | 'FAIL' | null;
  /** 输出摘要（截断） */
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
}

export interface TeamRunState {
  schema: 'awkn-team-run/v1';
  runId: string;
  teamId: string;
  mission: string;
  mode: CollaborationMode;
  status: TeamRunStatus;
  createdAt: string;
  updatedAt: string;
  /** 当前挂起 gate（gating 状态时） */
  pendingGate?: { after: string; label?: string };
  /** 已批准的 gate.after workerId 集合（跨进程恢复用） */
  approvedGates: string[];
  /** 人工介入指令（intervene 注入，供 Manager 汇总消费） */
  directives: string[];
  workers: WorkerNodeResult[];
  summary?: string;
}

/** Worker 执行器输入（M3 WorkerRuntime 接口契约） */
export interface WorkerTaskInput {
  workerId: string;
  personaId: string;
  personaName: string;
  capability?: string;
  task: string;
  mission: string;
  /** 上游工件绝对路径（只读所需） */
  upstreamArtifacts: string[];
  /** 本 Worker 工件输出目录 */
  artifactDir: string;
  isReviewer: boolean;
}

/** Worker 执行器输出 */
export interface WorkerTaskOutput {
  /** 最终文本输出 */
  text: string;
  /** 写出的工件文件名（相对 artifactDir） */
  artifacts?: string[];
}

/** 可注入的 Worker 执行器（默认 AgentLoop 实现；测试可 stub） */
export type WorkerExecutor = (input: WorkerTaskInput) => Promise<WorkerTaskOutput>;
