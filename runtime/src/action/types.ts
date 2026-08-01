/**
 * awkn-local-action-runner — 类型定义
 *
 * Pipeline / Job / Step 的 zod schema + 运行时状态类型。
 * 对标 qoder-action action.yml，但简化为本地可用子集。
 */

import { z } from 'zod';

// ─── Step 定义（YAML/JSON 解析后） ───────────────────────────────

export const ShellStepSchema = z.object({
  name: z.string(),
  type: z.literal('shell'),
  command: z.string(),
  cwd: z.string().optional(),
  timeout: z.number().optional().default(300),
  condition: z.enum(['always', 'on-success', 'on-failure']).optional().default('on-success'),
});

export const AgentStepSchema = z.object({
  name: z.string(),
  type: z.literal('agent'),
  agent: z.object({
    name: z.enum(['tianhuo', 'cicd-tester', 'custom']),
    prompt: z.string(),
    systemPromptPath: z.string().optional(),
    maxTurns: z.number().optional().default(10),
  }),
  condition: z.enum(['always', 'on-success', 'on-failure']).optional().default('on-success'),
});

export const GateStepSchema = z.object({
  name: z.string(),
  type: z.literal('gate'),
  gates: z.array(z.enum([
    'typecheck', 'test', 'lint', 'review', 'security', 'verification', 'budget',
  ])),
  condition: z.enum(['always', 'on-success', 'on-failure']).optional().default('on-success'),
});

export const StepSchema = z.discriminatedUnion('type', [
  ShellStepSchema,
  AgentStepSchema,
  GateStepSchema,
]);

// ─── Job / Pipeline 定义 ─────────────────────────────────────────

export const JobSchema = z.object({
  name: z.string().optional(),
  needs: z.array(z.string()).optional().default([]),
  timeout: z.number().optional().default(600),
  condition: z.string().optional(),
  steps: z.array(StepSchema),
});

export const TriggerSchema = z.object({
  manual: z.boolean().optional().default(true),
  cron: z.string().optional(),
  gitHook: z.enum(['post-commit', 'post-merge', 'pre-push']).optional(),
  watchPaths: z.array(z.string()).optional(),
  branches: z.array(z.string()).optional().default(['main']),
});

export const PipelineSchema = z.object({
  name: z.string(),
  trigger: TriggerSchema.optional().default({}),
  env: z.record(z.string()).optional().default({}),
  jobs: z.record(JobSchema),
});

export type ShellStepDef = z.infer<typeof ShellStepSchema>;
export type AgentStepDef = z.infer<typeof AgentStepSchema>;
export type GateStepDef = z.infer<typeof GateStepSchema>;
export type StepDef = z.infer<typeof StepSchema>;
export type JobDef = z.infer<typeof JobSchema>;
export type TriggerDef = z.infer<typeof TriggerSchema>;
export type PipelineDef = z.infer<typeof PipelineSchema>;

// ─── 运行时状态 ──────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type JobStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type PipelineStatus = 'pending' | 'running' | 'passed' | 'failed';

export interface StepResult {
  name: string;
  type: 'shell' | 'agent' | 'gate';
  status: StepStatus;
  output: string;
  durationMs: number;
  exitCode?: number;
  agentSummary?: string;
  gateResults?: Array<{ name: string; passed: boolean; details?: string }>;
}

export interface JobResult {
  jobId: string;
  name: string;
  status: JobStatus;
  steps: StepResult[];
  durationMs: number;
}

export interface PipelineResult {
  pipelineName: string;
  runId: string;
  status: PipelineStatus;
  jobs: JobResult[];
  trigger: string;
  commitSha: string;
  branch: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  reportPath?: string;
}
