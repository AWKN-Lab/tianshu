/**
 * AgentTeams — M5.2 heartbeat（Worker 心跳 + 超时回收）
 *
 * 影响层级 [M]：C5 活性检测。Worker 执行期间周期性 touch；
 * 超过 timeoutMs 未 touch → reap() 判为超时，编排侧标记 failed 并回收。
 * 时钟可注入（测试用）。
 */

export interface HeartbeatEntry {
  lastBeatAt: number;
  startedAt: number;
}

export class HeartbeatMonitor {
  private beats = new Map<string, HeartbeatEntry>();

  constructor(
    private readonly timeoutMs: number = 30 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Worker 开始执行 */
  start(key: string): void {
    const t = this.now();
    this.beats.set(key, { lastBeatAt: t, startedAt: t });
  }

  /** 心跳更新 */
  touch(key: string): void {
    const entry = this.beats.get(key);
    if (entry) entry.lastBeatAt = this.now();
    else this.start(key);
  }

  /** Worker 结束，清理 */
  stop(key: string): void {
    this.beats.delete(key);
  }

  /** 是否超时 */
  isExpired(key: string): boolean {
    const entry = this.beats.get(key);
    if (!entry) return false;
    return this.now() - entry.lastBeatAt > this.timeoutMs;
  }

  /** 回收：返回已超时的 key 并从监控中移除 */
  reap(): string[] {
    const expired: string[] = [];
    for (const key of [...this.beats.keys()]) {
      if (this.isExpired(key)) {
        expired.push(key);
        this.beats.delete(key);
      }
    }
    return expired;
  }

  active(): string[] {
    return [...this.beats.keys()];
  }
}
