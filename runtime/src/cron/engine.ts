import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CronExpressionParser } from 'cron-parser';
import { createLogger } from '../core/logger.js';
import { queryAll, queryRun } from '../store/db.js';
import type { CronJobRow } from '../store/schema.js';
import type { CronActionSnapshot } from './action-executor.js';
import { CronWorker } from './worker.js';
import { CronWorkStore } from './work-store.js';

const logger = createLogger('CronEngine');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTEXT_DIR = resolve(__dirname, '..', '..', 'data', 'cron-contexts');

export interface ContextSnapshot {
  jobId: string;
  runAt: number;
  result: 'success' | 'failed' | 'skipped';
  summary: string;
  context: Record<string, unknown>;
}

export class CronEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private workerInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  // M3 进阶-11: in-flight 跟踪 — 防止 checkAll 重复触发同一 job（兜底轮询场景）
  private inFlight: Set<string> = new Set();
  private readonly worker = new CronWorker();
  private readonly workStore = new CronWorkStore();

  saveContext(snapshot: ContextSnapshot): void {
    try {
      mkdirSync(CONTEXT_DIR, { recursive: true });
      writeFileSync(resolve(CONTEXT_DIR, `${snapshot.jobId}.jsonl`), `${JSON.stringify(snapshot)}\n`, { flag: 'a' });
    } catch { /* context evidence is fail-open */ }
  }

  restoreContext(jobId: string): ContextSnapshot | null {
    try {
      const path = resolve(CONTEXT_DIR, `${jobId}.jsonl`);
      if (!existsSync(path)) return null;
      const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.length > 0 ? JSON.parse(lines.at(-1)!) as ContextSnapshot : null;
    } catch {
      return null;
    }
  }

  restoreAllContexts(): Map<string, ContextSnapshot> {
    const result = new Map<string, ContextSnapshot>();
    for (const job of queryAll<CronJobRow>('SELECT * FROM cron_jobs WHERE enabled = 1')) {
      const context = this.restoreContext(job.id);
      if (context) result.set(job.id, context);
    }
    return result;
  }

  start(): void {
    if (this.running) return;
    if (process.env.AWKN_DISABLE_CRON === '1' || process.env.AWKN_DB_PATH === ':memory:') {
      logger.info('CronEngine disabled for isolated/test runtime');
      return;
    }
    this.running = true;
    this.workStore.recoverExpired();
    this.scheduleAll();
    this.checkInterval = setInterval(() => this.checkAll(), 60_000);
    this.workerInterval = setInterval(() => {
      void this.worker.pollOnce().catch((err) => logger.error(`Cron worker poll failed: ${String(err)}`));
    }, 2_000);
  }

  stop(): void {
    this.running = false;
    if (this.checkInterval) clearInterval(this.checkInterval);
    if (this.workerInterval) clearInterval(this.workerInterval);
    this.checkInterval = null;
    this.workerInterval = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  reloadFromDb(): void { this.scheduleAll(); }
  getNextRun(cronExpr: string): string | null {
    try { return CronExpressionParser.parse(cronExpr).next().toISOString(); } catch { return null; }
  }

  async triggerJob(jobId: string): Promise<{ ok: boolean; durationMs: number; error?: string }> {
    const job = queryAll<CronJobRow>('SELECT * FROM cron_jobs WHERE id = ?', [jobId])[0];
    if (!job) throw new Error('job not found');
    const started = Date.now();
    const item = this.enqueueJob(job, `manual:${job.id}:${randomUUID()}`);
    const result = await this.worker.processById(item.id);
    this.saveContext({
      jobId,
      runAt: started,
      result: result.ok ? 'success' : 'failed',
      summary: result.ok ? 'manual trigger succeeded' : String(result.error).slice(0, 200),
      context: { workItemId: item.id, idempotencyKey: item.idempotency_key },
    });
    return { ...result, durationMs: Date.now() - started };
  }

  private scheduleAll(): void {
    for (const job of queryAll<CronJobRow>('SELECT * FROM cron_jobs WHERE enabled = 1')) this.scheduleJob(job);
  }

  private scheduleJob(job: CronJobRow): void {
    if (!this.running) return;
    const existing = this.timers.get(job.id);
    if (existing) clearTimeout(existing);
    this.timers.delete(job.id);
    try {
      const nextDate = CronExpressionParser.parse(job.cron_expr).next();
      const nextIso = nextDate.toISOString();
      queryRun('UPDATE cron_jobs SET next_run_at = ?, updated_at = ? WHERE id = ?', [nextIso, new Date().toISOString(), job.id]);
      const delay = nextDate.getTime() - Date.now();
      if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
        const timer = setTimeout(async () => {
          if (!this.running) return;
          const latest = queryAll<CronJobRow>('SELECT * FROM cron_jobs WHERE id = ? AND enabled = 1', [job.id])[0];
          if (!latest) return;
          void this.executeJob(latest);
          this.scheduleJob(latest);
        }, delay);
        this.timers.set(job.id, timer);
      }
    } catch {
      queryRun('UPDATE cron_jobs SET next_run_at = NULL WHERE id = ?', [job.id]);
    }
  }

  // M3 进阶-11: executeJob — in-flight 跟踪防止重复入队
  // fire-and-forget: 调用方不 await，但 inFlight Set 保证同一 job 不会被并发触发
  private async executeJob(job: CronJobRow): Promise<void> {
    this.inFlight.add(job.id);
    try {
      this.enqueueJob(job, `${job.id}:${job.next_run_at ?? new Date().toISOString()}`);
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  private enqueueJob(job: CronJobRow, idempotencyKey: string) {
    const payload = JSON.parse(job.action_payload || '{}') as Record<string, unknown>;
    const snapshot: CronActionSnapshot = {
      actionType: job.action_type as CronActionSnapshot['actionType'],
      payload,
      workspaceRoot: typeof payload.workspaceRoot === 'string' ? payload.workspaceRoot : undefined,
    };
    return this.workStore.enqueue({
      jobId: job.id,
      idempotencyKey,
      payload: snapshot as unknown as Record<string, unknown>,
      maxAttempts: Number(payload.maxAttempts ?? 3),
    });
  }

  private checkAll(): void {
    const now = Date.now();
    for (const job of queryAll<CronJobRow>('SELECT * FROM cron_jobs WHERE enabled = 1')) {
      if (this.inFlight.has(job.id)) continue;
      if (!job.next_run_at) continue;
      if (new Date(job.next_run_at).getTime() <= now) {
        void this.executeJob(job);
        this.scheduleJob(job);
      }
    }
  }
}

let instance: CronEngine | null = null;
export function getCronEngine(): CronEngine {
  if (!instance) instance = new CronEngine();
  return instance;
}
export function startCronEngine(): CronEngine {
  const engine = getCronEngine();
  engine.start();
  return engine;
}
export function stopCronEngine(): void {
  instance?.stop();
  instance = null;
}
