import { createLogger } from '../core/logger.js';
import { ack, claimDue, nack, type QueueItem } from '../store/queue.js';

const logger = createLogger('AsyncWorker');

export interface WorkerHandler {
  (item: QueueItem): Promise<void> | void;
}

export interface WorkerHandle {
  stop(): void;
  running(): boolean;
}

export interface AsyncWorkerOptions {
  queueName: string;
  handler: WorkerHandler;
  owner?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  batch?: number;
  retryDelayMs?: number;
}

export function startAsyncWorker(options: AsyncWorkerOptions): WorkerHandle {
  const owner = options.owner ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  let stopped = false;
  let polling = false;

  const tick = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const items = claimDue(options.queueName, owner, {
        leaseMs: options.leaseMs,
        batch: options.batch,
      });
      for (const item of items) {
        if (stopped) break;
        try {
          await options.handler(item);
          ack(item.id);
        } catch (err) {
          logger.warn(`Queue item ${item.id} failed: ${String(err)}`);
          nack(item.id, err, { retryDelayMs: options.retryDelayMs });
        }
      }
    } catch (err) {
      logger.error(`Async worker poll failed: ${String(err)}`);
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  interval.unref();
  void tick();

  return {
    stop(): void {
      stopped = true;
      clearInterval(interval);
    },
    running(): boolean {
      return !stopped;
    },
  };
}
