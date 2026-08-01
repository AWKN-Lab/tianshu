/**
 * awkn-local-action-runner — CLI 命令实现
 *
 * 用法：
 *   awkn-action-runner run --pipeline cicd [--trigger manual] [--cwd .]
 *   awkn-action-runner daemon [--cwd .]
 *   awkn-action-runner hook install [--hook post-commit] [--pipeline cicd]
 *   awkn-action-runner report --last
 *   awkn-action-runner list
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRuntimeEnv } from '../config/runtime-env.js';
import { getDb } from '../store/db.js';
import { loadPipeline, listPipelines } from './loader.js';
import { runPipeline } from './runner.js';
import { installGitHook, setupCronTrigger, setupWatchTrigger } from './trigger.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('ActionCLI');

function getArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

function resolveActionsDir(cwd: string): string {
  return resolve(cwd, '.awkn', 'actions');
}

export async function actionMain(argv: string[]): Promise<void> {
  const command = argv[0];
  const args = argv.slice(1);

  // 初始化引擎环境
  loadRuntimeEnv();
  getDb();

  switch (command) {
    case 'run': {
      const cwd = getArg(args, '--cwd') ?? process.cwd();
      const pipelineName = getArg(args, '--pipeline') ?? 'cicd';
      const trigger = getArg(args, '--trigger') ?? 'manual';

      // 防循环触发
      if (process.env.AWKN_ACTION_RUNNING === '1') {
        logger.info('Already running (AWKN_ACTION_RUNNING=1), skipping.');
        return;
      }
      process.env.AWKN_ACTION_RUNNING = '1';

      try {
        const actionsDir = resolveActionsDir(cwd);
        const pipeline = loadPipeline(actionsDir, pipelineName);
        const result = await runPipeline(pipeline, { cwd, trigger });

        console.log('');
        console.log(`${result.status === 'passed' ? '✅' : '❌'} Pipeline "${result.pipelineName}" ${result.status.toUpperCase()}`);
        console.log(`   Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
        console.log(`   Run ID:   ${result.runId}`);
        if (result.reportPath) console.log(`   Report:   ${result.reportPath}`);

        process.exitCode = result.status === 'passed' ? 0 : 1;
      } finally {
        delete process.env.AWKN_ACTION_RUNNING;
      }
      break;
    }

    case 'daemon': {
      const cwd = getArg(args, '--cwd') ?? process.cwd();
      const pipelineName = getArg(args, '--pipeline') ?? 'cicd';
      const actionsDir = resolveActionsDir(cwd);
      const pipeline = loadPipeline(actionsDir, pipelineName);

      console.log(`Daemon started for pipeline "${pipelineName}". Press Ctrl+C to stop.`);

      if (pipeline.trigger.cron) {
        setupCronTrigger(pipeline.trigger.cron, pipelineName, () => {
          runPipeline(pipeline, { cwd, trigger: 'cron' }).catch((err) =>
            logger.error(`Cron pipeline failed: ${String(err)}`),
          );
        });
        console.log(`  Cron: ${pipeline.trigger.cron}`);
      }

      if (pipeline.trigger.watchPaths && pipeline.trigger.watchPaths.length > 0) {
        setupWatchTrigger(pipeline.trigger.watchPaths, cwd, () => {
          runPipeline(pipeline, { cwd, trigger: 'watch' }).catch((err) =>
            logger.error(`Watch pipeline failed: ${String(err)}`),
          );
        });
        console.log(`  Watch: ${pipeline.trigger.watchPaths.join(', ')}`);
      }

      if (!pipeline.trigger.cron && (!pipeline.trigger.watchPaths || pipeline.trigger.watchPaths.length === 0)) {
        console.log('  No triggers configured. Use "run" command for manual execution.');
      }

      // 保持进程活跃
      await new Promise(() => { /* never resolves */ });
      break;
    }

    case 'hook': {
      const subcommand = args[0];
      if (subcommand !== 'install') {
        console.log('Usage: awkn-action-runner hook install [--hook post-commit] [--pipeline cicd]');
        return;
      }
      const cwd = getArg(args, '--cwd') ?? process.cwd();
      const hook = getArg(args, '--hook') ?? 'post-commit';
      const pipelineName = getArg(args, '--pipeline') ?? 'cicd';
      const hookPath = installGitHook(cwd, hook, pipelineName);
      console.log(`✅ Git hook installed: ${hookPath}`);
      break;
    }

    case 'report': {
      const cwd = getArg(args, '--cwd') ?? process.cwd();
      const reportsDir = resolve(cwd, 'reports');
      if (!existsSync(reportsDir)) {
        console.log('No reports directory found.');
        return;
      }
      const files = readdirSync(reportsDir).filter((f) => f.endsWith('.md')).sort().reverse();
      if (files.length === 0) {
        console.log('No reports found.');
        return;
      }
      const target = getArg(args, '--last') !== undefined || args.includes('--last')
        ? files[0]
        : files[0];
      console.log(readFileSync(resolve(reportsDir, target!), 'utf-8'));
      break;
    }

    case 'list': {
      const cwd = getArg(args, '--cwd') ?? process.cwd();
      const actionsDir = resolveActionsDir(cwd);
      const pipelines = listPipelines(actionsDir);
      if (pipelines.length === 0) {
        console.log(`No pipelines found in ${actionsDir}`);
      } else {
        console.log('Available pipelines:');
        for (const p of pipelines) console.log(`  - ${p}`);
      }
      break;
    }

    default:
      console.log(`awkn-action-runner — 本地 CI/CD Pipeline Runner

Usage:
  awkn-action-runner run [--pipeline <name>] [--trigger <type>] [--cwd <dir>]
  awkn-action-runner daemon [--pipeline <name>] [--cwd <dir>]
  awkn-action-runner hook install [--hook <name>] [--pipeline <name>]
  awkn-action-runner report [--last]
  awkn-action-runner list

Commands:
  run       执行一次 Pipeline
  daemon    常驻模式（cron + watch 触发）
  hook      安装/管理 git hook
  report    查看报告
  list      列出可用 Pipeline
`);
  }
}

// ─── 直接运行入口（bin/awkn-action-runner.js 通过 tsx 执行本文件） ───
const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  actionMain(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
