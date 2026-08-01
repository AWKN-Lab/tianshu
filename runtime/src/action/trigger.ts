/**
 * awkn-local-action-runner — 触发层
 *
 * git hook / cron / watch / manual。
 * cron 复用 cron-parser（已有依赖），watch 用 Node 内置 fs.watch。
 */

import { watch, writeFileSync, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { createLogger } from '../core/logger.js';

const logger = createLogger('ActionTrigger');

export interface TriggerHandle {
  stop(): void;
}

/** cron 定时触发 */
export function setupCronTrigger(
  cronExpr: string,
  pipelineName: string,
  onTrigger: () => void,
): TriggerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped) return;
    try {
      const next = CronExpressionParser.parse(cronExpr).next();
      const delay = next.getTime() - Date.now();
      if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) {
        timer = setTimeout(() => {
          logger.info(`Cron trigger: ${pipelineName}`);
          onTrigger();
          scheduleNext(); // 调度下一次
        }, delay);
      }
    } catch (err) {
      logger.error(`Invalid cron expression "${cronExpr}": ${String(err)}`);
    }
  };

  scheduleNext();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** 文件监听触发（fs.watch，2s 防抖） */
export function setupWatchTrigger(
  paths: string[],
  cwd: string,
  onTrigger: () => void,
): TriggerHandle {
  const watchers: FSWatcher[] = [];
  let debounce: ReturnType<typeof setTimeout> | null = null;

  for (const p of paths) {
    try {
      const resolved = resolve(cwd, p);
      const w = watch(resolved, { recursive: true }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          logger.info(`Watch trigger: ${p} changed`);
          onTrigger();
        }, 2000);
      });
      watchers.push(w);
    } catch (err) {
      logger.warn(`Cannot watch "${p}": ${String(err)}`);
    }
  }

  return {
    stop: () => {
      if (debounce) clearTimeout(debounce);
      for (const w of watchers) w.close();
    },
  };
}

/** 安装 git hook（写 .git/hooks/<hook> 脚本） */
export function installGitHook(cwd: string, hook: string, pipelineName: string): string {
  const hookPath = resolve(cwd, '.git', 'hooks', hook);
  // 防循环：AWKN_ACTION_RUNNING=1 时跳过
  const script = [
    '#!/bin/sh',
    '# Installed by awkn-action-runner',
    'if [ "$AWKN_ACTION_RUNNING" = "1" ]; then exit 0; fi',
    `node runtime/bin/awkn-action-runner.js run --pipeline ${pipelineName} --trigger git-hook`,
    '',
  ].join('\n');

  writeFileSync(hookPath, script, { mode: 0o755 });
  logger.info(`Git hook installed: ${hookPath}`);
  return hookPath;
}
