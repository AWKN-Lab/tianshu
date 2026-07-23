/**
 * Cron 调度引擎 — 从 awkn-agent 抽取 + 改造
 *
 * 来源：awkn-agent/src/cron/engine.ts
 * 改动：
 *   1. queryAll/queryRunImmediate 从 awkn-agent 的 db/database.js 换成本地 store/db.ts
 *   2. CONTEXT_DIR 路径改为 runtime/data/cron-contexts/
 *   3. logger 换成本地 logger
 *
 * 特性：
 * - cron 表达式调度（cron-parser）
 * - setTimeout 调度（24h 内的任务）
 * - 60s 兜底轮询（防止 setTimeout 漏触发）
 * - 上下文快照恢复（N6: 自动唤醒+上下文恢复）
 */

import { CronExpressionParser } from 'cron-parser';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../core/logger.js';
import { queryAll, queryRun, lastInsertRowid } from '../store/db.js';
import type { CronJobRow } from '../store/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger('CronEngine');

// ─── Context Snapshot (N6: 自动唤醒+上下文恢复) ────────────────────────

export interface ContextSnapshot {
  jobId: string;
  runAt: number;
  result: 'success' | 'failed' | 'skipped';
  summary: string;
  context: Record<string, unknown>;
}

// 修复（2026-07-23）：原版用 process.cwd() + 'runtime/data/'，但 cli.ts 从 runtime/ 跑
// 现改用 __dirname 推算：src/cron/engine.ts → 上溯 2 级到 runtime/，再加 data/cron-contexts/
const CONTEXT_DIR = resolve(__dirname, '..', '..', 'data', 'cron-contexts');

export class CronEngine {
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  // M3 进阶-11（2026-07-23）：in-flight 跟踪，防止 checkAll 兜底轮询重复触发同一 job
  // 原版：checkAll 中 executeJob 未 await，若 job 执行 > 60s（checkInterval），
  //   下一轮 checkAll 因 last_run_at 还没更新而重复触发同一 job
  private inFlight: Set<string> = new Set();

  // ─── N6: Context Snapshot ───────────────────────────────────────

  /** 保存执行上下文快照到 JSONL */
  saveContext(snapshot: ContextSnapshot): void {
    try {
      mkdirSync(CONTEXT_DIR, { recursive: true });
      const filePath = resolve(CONTEXT_DIR, `${snapshot.jobId}.jsonl`);
      const line = JSON.stringify(snapshot) + '\n';
      writeFileSync(filePath, line, { flag: 'a' });
    } catch {
      // 上下文保存失败不阻塞主流程
    }
  }

  /** 恢复最近一次执行上下文 */
  restoreContext(jobId: string): ContextSnapshot | null {
    try {
      const filePath = resolve(CONTEXT_DIR, `${jobId}.jsonl`);
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf-8').trim();
      if (!content) return null;
      const lines = content.split('\n').filter(Boolean);
      if (lines.length === 0) return null;
      return JSON.parse(lines[lines.length - 1]) as ContextSnapshot;
    } catch {
      return null;
    }
  }

  /** 启动时批量恢复所有活跃任务的上下文 */
  restoreAllContexts(): Map<string, ContextSnapshot> {
    const contexts = new Map<string, ContextSnapshot>();
    const jobs = queryAll<CronJobRow>(
      'SELECT * FROM cron_jobs WHERE enabled = 1',
    );
    for (const job of jobs) {
      const ctx = this.restoreContext(job.id);
      if (ctx) contexts.set(job.id, ctx);
    }
    return contexts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // N6: 启动时恢复所有活跃任务的上下文
    const contexts = this.restoreAllContexts();
    if (contexts.size > 0) {
      logger.info(`Restored context for ${contexts.size} job(s)`);
    }

    this.scheduleAll();
    this.checkInterval = setInterval(() => this.checkAll(), 60_000);
  }

  stop(): void {
    this.running = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    for (const [, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  reloadFromDb(): void {
    this.scheduleAll();
  }

  getNextRun(cronExpr: string): string | null {
    try {
      const interval = CronExpressionParser.parse(cronExpr);
      return interval.next().toISOString();
    } catch {
      return null;
    }
  }

  async triggerJob(
    jobId: string,
  ): Promise<{ ok: boolean; durationMs: number; error?: string }> {
    const rows = queryAll<CronJobRow>('SELECT * FROM cron_jobs WHERE id = ?', [
      jobId,
    ]);
    if (rows.length === 0) throw new Error('job not found');
    return this.executeJob(rows[0]);
  }

  private scheduleAll(): void {
    const jobs = queryAll<CronJobRow>(
      'SELECT * FROM cron_jobs WHERE enabled = 1',
    );
    for (const job of jobs) {
      this.scheduleJob(job);
    }
  }

  private scheduleJob(job: CronJobRow): void {
    // M3 进阶-29（2026-07-23）：stop() 后不再调度新 timer
    //   原版：scheduleJob 无 running 检查 → 若 job 正在执行时 stop() 被调用，
    //     executeJob 完成后会 scheduleJob 调度新 timer → 新 timer 加入 this.timers
    //     但 stop() 已 clear 了旧 timers → 新 timer 泄漏 → engine "假停止"
    //     （running=false 但 timer 仍在调度，job 仍会执行）
    //   场景：编程式用法 startCronEngine() → ... → stopCronEngine() → 继续其他工作
    //     当前 CLI 在 stop() 后立即 process.exit()，故未被触发（latent bug）
    //   修复：scheduleJob 开头检查 running，stop 后直接返回不调度
    //   原则：stop() 不仅要 clear 已注册的 timer，还要阻断 callback 中创建新 timer
    //         状态标志（running=false）必须能阻止后续调度，否则"状态不可见"
    if (!this.running) return;

    const existing = this.timers.get(job.id);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(job.id);
    }

    try {
      const interval = CronExpressionParser.parse(job.cron_expr);
      const nextDate = interval.next();
      const delay = nextDate.getTime() - Date.now();

      if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
        const timer = setTimeout(async () => {
          // M3 进阶-29：双重保险 — clearTimeout 无法取消已被事件循环拾取的回调
          //   若 stop() 在 clearTimeout 前一刻执行，回调仍会运行 → 此处再次拦截
          if (!this.running) return;
          await this.executeJob(job);
          const updated = queryAll<CronJobRow>(
            'SELECT * FROM cron_jobs WHERE id = ? AND enabled = 1',
            [job.id],
          );
          if (updated.length > 0) this.scheduleJob(updated[0]);
        }, delay);
        this.timers.set(job.id, timer);
      }

      queryRun('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?', [
        nextDate.toISOString(),
        job.id,
      ]);
    } catch {
      queryRun('UPDATE cron_jobs SET next_run_at = NULL WHERE id = ?', [
        job.id,
      ]);
    }
  }

  private async executeJob(
    job: CronJobRow,
  ): Promise<{ ok: boolean; durationMs: number; error?: string }> {
    // M3 进阶-11：标记 in-flight，防止 checkAll 兜底轮询重复触发
    this.inFlight.add(job.id);
    const startedAt = new Date().toISOString();
    const logId = this.insertLog(job.id, startedAt);

    try {
      const payload = JSON.parse(job.action_payload || '{}');
      let resultText = '';

      if (job.action_type === 'http' && payload.url) {
        const resp = await fetch(payload.url, {
          method: payload.method || 'GET',
          headers: payload.headers || {},
          body: payload.body ? JSON.stringify(payload.body) : undefined,
        });
        resultText = `HTTP ${resp.status}`;
      } else if (job.action_type === 'tool') {
        resultText = `tool:${payload.toolName || 'unknown'}`;
      } else if (job.action_type === 'script') {
        resultText = `script:${payload.command || 'unknown'}`;
      } else if (job.action_type === 'evolve') {
        // L3 自动触发自进化：pattern-detector 检测 → experience-writer 写草稿
        const { runEvolveOnce } = await import('../evolve/experience-writer.js');
        const result = await runEvolveOnce();
        resultText = `evolve: detected ${result.patterns.length} patterns, wrote ${result.writes.length} files`;
      } else {
        resultText = 'no-op';
      }

      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - new Date(startedAt).getTime();
      this.finishLog(logId, 'success', finishedAt, durationMs, resultText);
      this.updateJobAfterRun(job.id, finishedAt);

      // N6: 保存执行上下文
      this.saveContext({
        jobId: job.id,
        runAt: new Date(startedAt).getTime(),
        result: 'success',
        summary: resultText.slice(0, 200),
        context: { actionType: job.action_type, durationMs },
      });

      return { ok: true, durationMs };
    } catch (e) {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - new Date(startedAt).getTime();
      this.finishLog(
        logId,
        'error',
        finishedAt,
        durationMs,
        undefined,
        String((e as Error).message),
      );

      // N6: 保存失败上下文
      this.saveContext({
        jobId: job.id,
        runAt: new Date(startedAt).getTime(),
        result: 'failed',
        summary: String((e as Error).message).slice(0, 200),
        context: { actionType: job.action_type, error: String((e as Error).message) },
      });

      return { ok: false, durationMs, error: String((e as Error).message) };
    } finally {
      // M3 进阶-11：无论成功/失败都清除 in-flight 标记
      this.inFlight.delete(job.id);
    }
  }

  private insertLog(jobId: string, startedAt: string): number {
    queryRun(
      'INSERT INTO cron_run_log (job_id, status, started_at) VALUES (?, ?, ?)',
      [jobId, 'running', startedAt],
    );
    return lastInsertRowid();
  }

  private finishLog(
    logId: number,
    status: string,
    finishedAt: string,
    durationMs: number,
    resultText?: string,
    errorText?: string,
  ): void {
    queryRun(
      'UPDATE cron_run_log SET status = ?, finished_at = ?, duration_ms = ?, result_text = ?, error_text = ? WHERE id = ?',
      [
        status,
        finishedAt,
        durationMs,
        resultText ?? null,
        errorText ?? null,
        logId,
      ],
    );
  }

  private updateJobAfterRun(jobId: string, finishedAt: string): void {
    queryRun(
      'UPDATE cron_jobs SET last_run_at = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?',
      [finishedAt, finishedAt, jobId],
    );
  }

  private checkAll(): void {
    const now = Date.now();
    const jobs = queryAll<CronJobRow>(
      'SELECT * FROM cron_jobs WHERE enabled = 1',
    );
    for (const job of jobs) {
      if (!job.next_run_at) continue;
      // M3 进阶-11：跳过正在执行的 job，避免兜底轮询重复触发
      if (this.inFlight.has(job.id)) continue;
      const nextRun = new Date(job.next_run_at).getTime();
      if (
        nextRun <= now &&
        (!job.last_run_at || new Date(job.last_run_at).getTime() < nextRun)
      ) {
        this.executeJob(job);
      }
    }
  }
}

let instance: CronEngine | null = null;

export function getCronEngine(): CronEngine {
  if (!instance) {
    instance = new CronEngine();
  }
  return instance;
}

export function startCronEngine(): CronEngine {
  const engine = getCronEngine();
  engine.start();
  return engine;
}

export function stopCronEngine(): void {
  if (instance) {
    instance.stop();
    instance = null;
  }
}
