/**
 * awkn-local-action-runner — 核心 Runner
 *
 * 编排 jobs/steps，写入 EventStore，调用 AgentLoop / quality-gates。
 * 对标 qoder-action main.ts，但 Agent 跑在本地。
 */

import { getEventStore } from '../workflow/event-store.js';
import { createLogger } from '../core/logger.js';
import { redactText } from '../core/redaction.js';
import { acquireGlobalPipelineLock, acquirePipelineSlot, releaseGlobalPipelineLock, withPipelineMutex } from './run-guard.js';
import type {
  PipelineDef,
  JobDef,
  PipelineResult,
  JobResult,
  StepResult,
} from './types.js';
import { runShellStep } from './steps/shell-step.js';
import { runAgentStep } from './steps/agent-step.js';
import { runGateStep } from './steps/gate-step.js';
import { generateReport } from './reporter.js';
import { getGitContext } from './git-auto.js';
import { setStatusCheck } from './github-api.js';

const logger = createLogger('ActionRunner');

export interface RunPipelineOptions {
  cwd: string;
  trigger: string;
  /** 跳过报告生成（测试用） */
  skipReport?: boolean;
  /** 跳过 GitHub status check（测试用） */
  skipGithub?: boolean;
}

/** 执行完整 Pipeline（进程内互斥 + 同 SHA 去重 + 并发锁） */
export async function runPipeline(
  pipeline: PipelineDef,
  opts: RunPipelineOptions,
): Promise<PipelineResult> {
  return withPipelineMutex(pipeline.name, () => runPipelineUnlocked(pipeline, opts));
}

async function runPipelineUnlocked(
  pipeline: PipelineDef,
  opts: RunPipelineOptions,
): Promise<PipelineResult> {
  const store = getEventStore();
  const git = await getGitContext(opts.cwd);
  const startedAt = new Date().toISOString();
  const pipelineStarted = Date.now();

  logger.info(`Pipeline "${pipeline.name}" started (trigger=${opts.trigger}, sha=${git.shortSha})`);

  // 1. 运行守卫：同 SHA 旧 run 取消 + 并发锁 + 全局 pipeline 互斥
  const slot = acquirePipelineSlot(store, `action:${pipeline.name}`, git.sha);
  const globalLockOwner = `pipeline:${pipeline.name}:${git.shortSha}`;
  const globalLocked = slot.decision === 'proceed' && acquireGlobalPipelineLock(store, globalLockOwner);
  if (slot.decision === 'busy' || !globalLocked) {
    logger.warn(
      slot.decision === 'busy'
        ? `Pipeline "${pipeline.name}" rejected: another active run (${slot.activeRunId}) is in progress`
        : `Pipeline "${pipeline.name}" rejected: global pipeline lock held by another run`,
    );
    const result: PipelineResult = {
      pipelineName: pipeline.name,
      runId: slot.decision === 'busy' ? slot.activeRunId : '',
      status: 'failed',
      jobs: [],
      trigger: opts.trigger,
      commitSha: git.sha,
      branch: git.branch,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
    };
    if (!opts.skipReport) {
      try {
        result.reportPath = generateReport(result, opts.cwd);
      } catch (err) {
        logger.warn(`Report generation failed: ${String(err)}`);
      }
    }
    return result;
  }
  if (slot.cancelled.length > 0) {
    logger.info(`Pipeline "${pipeline.name}": superseded stale runs ${slot.cancelled.join(', ')}`);
  }

  // 2. 创建 EventStore Run
  const run = store.createRun({
    workflowName: `action:${pipeline.name}`,
    payload: { trigger: opts.trigger, commitSha: git.sha, branch: git.branch },
  });
  store.transitionRun(run.id, 'running');

  try {
    return await runJobs(store, pipeline, opts, run.id, git, { startedAt, pipelineStarted });
  } finally {
    releaseGlobalPipelineLock(store, globalLockOwner);
  }
}

async function runJobs(
  store: ReturnType<typeof getEventStore>,
  pipeline: PipelineDef,
  opts: RunPipelineOptions,
  runId: string,
  git: { sha: string; shortSha: string; branch: string },
  timing: { startedAt: string; pipelineStarted: number },
): Promise<PipelineResult> {
  const jobResults: JobResult[] = [];
  const jobStatuses = new Map<string, 'passed' | 'failed' | 'skipped'>();
  const sortedJobs = topologicalSort(pipeline.jobs);

  // 3. 逐 job 执行
  for (const [jobId, job] of sortedJobs) {
    // 检查 needs 依赖
    const depsOk = job.needs.every((dep) => jobStatuses.get(dep) === 'passed');
    if (!depsOk && job.needs.length > 0) {
      jobStatuses.set(jobId, 'skipped');
      jobResults.push({ jobId, name: job.name ?? jobId, status: 'skipped', steps: [], durationMs: 0 });
      logger.info(`Job "${jobId}" skipped (dependency not met)`);
      continue;
    }

    // 检查 condition
    if (job.condition && !evaluateCondition(job.condition, jobStatuses)) {
      jobStatuses.set(jobId, 'skipped');
      jobResults.push({ jobId, name: job.name ?? jobId, status: 'skipped', steps: [], durationMs: 0 });
      logger.info(`Job "${jobId}" skipped (condition: ${job.condition})`);
      continue;
    }

    logger.info(`Job "${jobId}" running...`);
    const jobResult = await runJob(store, runId, jobId, job, opts.cwd);
    jobResults.push(jobResult);
    jobStatuses.set(jobId, jobResult.status === 'passed' ? 'passed' : 'failed');
    logger.info(`Job "${jobId}" ${jobResult.status} (${(jobResult.durationMs / 1000).toFixed(1)}s)`);
  }

  // 4. 判定 Pipeline 状态
  const allPassed = jobResults.every((j) => j.status === 'passed' || j.status === 'skipped');
  store.transitionRun(runId, allPassed ? 'succeeded' : 'failed', {
    jobs: jobResults.map((j) => ({ id: j.jobId, status: j.status })),
  });

  const result: PipelineResult = {
    pipelineName: pipeline.name,
    runId,
    status: allPassed ? 'passed' : 'failed',
    jobs: jobResults,
    trigger: opts.trigger,
    commitSha: git.sha,
    branch: git.branch,
    startedAt: timing.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - timing.pipelineStarted,
  };

  // 5. 生成报告
  if (!opts.skipReport) {
    try {
      result.reportPath = generateReport(result, opts.cwd);
    } catch (err) {
      logger.warn(`Report generation failed: ${String(err)}`);
    }
  }

  // 6. GitHub status check（fail-open）
  if (!opts.skipGithub) {
    await setStatusCheck(
      opts.cwd,
      git.sha,
      allPassed ? 'success' : 'failure',
      `awkn-local/${pipeline.name}`,
      allPassed ? 'All jobs passed' : 'One or more jobs failed',
    );
  }

  logger.info(`Pipeline "${pipeline.name}" ${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`);
  return result;
}

// ─── 内部函数 ────────────────────────────────────────────────────

async function runJob(
  store: ReturnType<typeof getEventStore>,
  runId: string,
  jobId: string,
  job: JobDef,
  cwd: string,
): Promise<JobResult> {
  const jobStarted = Date.now();
  const stepResults: StepResult[] = [];
  let jobFailed = false;

  for (const step of job.steps) {
    // 检查 step condition
    if (step.condition === 'on-failure' && !jobFailed) continue;
    if (step.condition === 'on-success' && jobFailed) continue;

    // 创建 EventStore step
    const esStep = store.createStep({
      runId,
      stepKey: `${jobId}:${step.name}`,
      stepType: step.type,
      payload: 'command' in step ? { command: redactText(step.command) } : {},
    });
    store.transitionStep(esStep.id, 'running');

    let result: StepResult;
    switch (step.type) {
      case 'shell':
        result = await runShellStep(step, cwd);
        break;
      case 'agent':
        result = await runAgentStep(step, cwd);
        break;
      case 'gate':
        result = await runGateStep(step, cwd);
        break;
    }

    store.transitionStep(
      esStep.id,
      result.status === 'passed' ? 'succeeded' : 'failed',
      { output: redactText(result.output).slice(0, 2000) },
      result.status === 'failed' ? redactText(result.output).slice(0, 500) : undefined,
    );

    stepResults.push(result);
    if (result.status === 'failed') jobFailed = true;
  }

  return {
    jobId,
    name: job.name ?? jobId,
    status: jobFailed ? 'failed' : 'passed',
    steps: stepResults,
    durationMs: Date.now() - jobStarted,
  };
}

/** 简单拓扑排序：按 needs 依赖排序 */
function topologicalSort(jobs: Record<string, JobDef>): Array<[string, JobDef]> {
  const sorted: Array<[string, JobDef]> = [];
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const job = jobs[id];
    if (!job) return;
    for (const dep of job.needs) visit(dep);
    sorted.push([id, job]);
  };

  for (const id of Object.keys(jobs)) visit(id);
  return sorted;
}

/** 简单条件表达式：jobId == 'PASS' / jobId == 'FAIL' */
function evaluateCondition(condition: string, statuses: Map<string, string>): boolean {
  const match = condition.match(/^(\S+)\s*==\s*'(\w+)'$/);
  if (!match) return true; // 无法解析的条件默认通过
  const [, jobId, expected] = match;
  const actual = statuses.get(jobId!);
  return actual === expected!.toLowerCase();
}
