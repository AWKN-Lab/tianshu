/**
 * Hermes CLI Port — Hermes CLI 调用的抽象接口
 *
 * Spiral 5: 吸收 Hermes 思想（独立 Profile、持久任务、heartbeat、reclaim、dead-letter）。
 * Hermes 是基于 shell 脚本的 agent 系统，不修改/不安装/不依赖。
 *
 * 本接口定义了 HermesWorkerProvider 与 Hermes CLI 之间的边界：
 * - 缺少机器可读输出时保持 SHADOW/QUARANTINED
 * - 上游 Hermes 稳定 CLI 能力可用后可切换到 enforce
 *
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 5
 */

/**
 * Hermes 任务规格 — 映射到 Hermes 的 spawn 请求。
 */
export interface HermesTaskSpec {
  readonly profileName: string;
  readonly prompt: string;
  readonly workspacePath: string;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly idempotencyKey: string;
}

/**
 * Hermes 任务状态。
 */
export type HermesTaskState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'reclaimed'
  | 'dead_lettered';

/**
 * Hermes 任务运行记录。
 */
export interface HermesRunRecord {
  readonly hermesRunId: string;
  readonly state: HermesTaskState;
  readonly lastHeartbeatAt: string;
  readonly profileName: string;
  readonly outputSnippet?: string;
  readonly errorMessage?: string;
}

/**
 * Hermes dead-letter 条目。
 */
export interface HermesDeadLetterEntry {
  readonly hermesRunId: string;
  readonly reason: string;
  readonly deadLetteredAt: string;
  readonly originalPrompt: string;
  readonly lastOutput?: string;
}

/**
 * Hermes CLI Port — 抽象 Hermes CLI 的调用边界。
 *
 * 实现方可以是：
 * 1. StubHermesCliPort — SHADOW 模式桩实现（默认）
 * 2. ShellHermesCliPort — 真实调用 Hermes shell 脚本（需 Hermes 已安装）
 *
 * 工程文档约束：D:\Downloads\oh-my-hermes-main 不被修改、不被安装、不成为依赖。
 */
export interface HermesCliPort {
  /** 探测 Hermes CLI 是否可用（机器可读输出） */
  probe(): Promise<{ available: boolean; version?: string; machineReadable: boolean }>;

  /** 启动 Hermes 任务 */
  spawn(spec: HermesTaskSpec): Promise<{ hermesRunId: string; spawnedAt: string }>;

  /** 查看任务状态 */
  inspect(hermesRunId: string): Promise<HermesRunRecord>;

  /** 心跳检测 */
  heartbeat(hermesRunId: string): Promise<{ alive: boolean; observedAt: string }>;

  /** 回收任务（reclaim） */
  reclaim(hermesRunId: string, reason: string): Promise<{ reclaimed: boolean; reclaimedAt: string }>;

  /** 收集任务结果 */
  collect(hermesRunId: string): Promise<{ conclusion: 'SUCCESS' | 'FAILURE' | 'PARTIAL'; output: string; evidence: string[] }>;

  /** 查询 dead-letter 条目 */
  listDeadLetters(limit?: number): Promise<HermesDeadLetterEntry[]>;
}

/**
 * StubHermesCliPort — SHADOW 模式桩实现
 *
 * Hermes CLI 不可用时的默认实现。所有操作返回占位结果，
 * 不真正调用任何外部进程。供 HermesWorkerProvider 在 SHADOW 模式下使用。
 */
export class StubHermesCliPort implements HermesCliPort {
  private readonly runs = new Map<string, HermesRunRecord>();
  private readonly deadLetters: HermesDeadLetterEntry[] = [];

  async probe(): Promise<{ available: boolean; version?: string; machineReadable: boolean }> {
    return { available: false, machineReadable: false };
  }

  async spawn(spec: HermesTaskSpec): Promise<{ hermesRunId: string; spawnedAt: string }> {
    const hermesRunId = `hermes-stub-${spec.idempotencyKey}`;
    const spawnedAt = new Date().toISOString();
    this.runs.set(hermesRunId, {
      hermesRunId,
      state: 'running',
      lastHeartbeatAt: spawnedAt,
      profileName: spec.profileName,
    });
    return { hermesRunId, spawnedAt };
  }

  async inspect(hermesRunId: string): Promise<HermesRunRecord> {
    const record = this.runs.get(hermesRunId);
    if (!record) {
      return {
        hermesRunId,
        state: 'pending',
        lastHeartbeatAt: new Date().toISOString(),
        profileName: 'unknown',
      };
    }
    return record;
  }

  async heartbeat(hermesRunId: string): Promise<{ alive: boolean; observedAt: string }> {
    const observedAt = new Date().toISOString();
    const record = this.runs.get(hermesRunId);
    return { alive: record?.state === 'running', observedAt };
  }

  async reclaim(hermesRunId: string, _reason: string): Promise<{ reclaimed: boolean; reclaimedAt: string }> {
    const record = this.runs.get(hermesRunId);
    if (record) {
      this.runs.set(hermesRunId, { ...record, state: 'reclaimed' });
    }
    return { reclaimed: true, reclaimedAt: new Date().toISOString() };
  }

  async collect(hermesRunId: string): Promise<{ conclusion: 'SUCCESS' | 'FAILURE' | 'PARTIAL'; output: string; evidence: string[] }> {
    const record = this.runs.get(hermesRunId);
    if (record) {
      this.runs.set(hermesRunId, { ...record, state: 'completed' });
    }
    return {
      conclusion: 'SUCCESS',
      output: '[hermes-stub] SHADOW mode placeholder output',
      evidence: [],
    };
  }

  async listDeadLetters(limit: number = 50): Promise<HermesDeadLetterEntry[]> {
    return this.deadLetters.slice(0, limit);
  }

  /** 测试辅助：注入 dead-letter 条目 */
  _injectDeadLetter(entry: HermesDeadLetterEntry): void {
    this.deadLetters.push(entry);
  }
}
