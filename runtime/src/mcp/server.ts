/**
 * awkn引擎 MCP Server
 *
 * 把引擎 7 大模块（goal/loop/hook/skill/cron/orchestrate/evolve）包装成 MCP tools，
 * 让 TRAE / Claude Code / Codex 等 IDE 通过 MCP 协议自动调用引擎能力。
 *
 * 传输：stdio（MCP 标准，IDE 原生支持）
 * 入口：runtime/bin/awkn-mcp-server.js → tsx 运行本文件
 *
 * 工具命名：awkn_<module>_<action>（如 awkn_goal_create）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRuntimeEnv } from '../config/runtime-env.js';
import type { LlmProvider } from '../llm/types.js';
import { getDb, closeDb } from '../store/db.js';
import { getGoalManager } from '../goal/goal-manager.js';
import { getSkillsManager } from '../skills/manager.js';
import { toolRegistry } from '../tools/registry.js';
import { builtinTools } from '../tools/builtin/index.js';
import { AgentLoop } from '../core/agent-loop.js';
import { hookManager } from '../core/hook-manager.js';
import type { HookPoint } from '../core/hook-types.js';
import { startWorkflow, getWorkflowStatus, resumeWorkflow, cancelWorkflow } from '../workflow/workflow-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 引擎初始化（与 cli.ts main() 一致） */
function initEngine(): void {
  loadRuntimeEnv();
  getDb();
  const skillsRoot =
    process.env.AWKN_SKILLS_ROOT ?? resolve(__dirname, '..', '..', '..', 'skills');
  const sm = getSkillsManager(skillsRoot);
  sm.loadAll();
  // 加载 capabilities/project/manifest.yaml(hash 校验失败会抛错)
  sm.loadCapabilities();
  for (const tool of builtinTools) {
    toolRegistry.register(tool);
  }
}

/** 把任意值序列化为 MCP text content */
function toText(data: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(data, null, 2) };
}

/** 工具执行错误结果（MCP 标准 isError） */
function toError(err: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

// ============================================================
// 创建 MCP Server
// ============================================================

const server = new McpServer(
  { name: 'awkn-engine', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'awkn引擎 — Loop Engineering L1-L4 runtime. ' +
      'Tools: goal(目标管理) / loop(循环执行) / skill(技能) / hook(事件) / cron(定时) / orchestrate(编排) / evolve(自进化). ' +
      '注意：loop.l1 / loop.l2 / orchestrate.* 会调用 LLM，可能耗时较长。',
  },
);

// ============================================================
// Goal 模块（6 tools）
// ============================================================

server.registerTool(
  'awkn_goal_create',
  {
    description: '创建 L2 目标（Goal-based loop 的停止条件由 hao 验收清单定义）',
    inputSchema: {
      title: z.string().describe('目标标题'),
      description: z.string().describe('目标描述'),
      hao: z.string().optional().describe('验收条件清单，逗号分隔（如 "tsc 0 错误,tests 0 fail"）'),
      owner: z.string().optional().describe('目标 owner，默认 user'),
    },
  },
  async (args: any) => {
    try {
      const gm = getGoalManager();
      const hao = args.hao
        ? args.hao.split(',').map((d: string) => ({ description: d.trim(), passed: false }))
        : [{ description: args.description, passed: false }];
      const goal = gm.create({
        title: args.title,
        description: args.description,
        owner: args.owner ?? 'user',
        hao,
      });
      return { content: [toText(goal)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_goal_list',
  {
    description: '列出目标（可按 owner / state 过滤）',
    inputSchema: {
      owner: z.string().optional(),
      state: z
        .enum(['active', 'achieved', 'unmet', 'paused', 'budget_limited'])
        .optional(),
    },
  },
  async (args: any) => {
    try {
      const goals = getGoalManager().list({ owner: args.owner, state: args.state });
      return { content: [toText(goals)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_goal_show',
  {
    description: '查看单个目标详情',
    inputSchema: { goalId: z.string().describe('目标 ID') },
  },
  async (args: any) => {
    try {
      const goal = getGoalManager().read(args.goalId);
      return { content: [toText(goal)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_goal_check_done',
  {
    description: '检查目标是否达成（用确定性证据，如 typecheck/tests 结果）',
    inputSchema: {
      goalId: z.string(),
      evidence: z.string().describe('JSON 格式的证据（如 {"tsc":"0 errors","tests":"96/96 pass"}）'),
    },
  },
  async (args: any) => {
    try {
      const evidence = JSON.parse(args.evidence);
      const result = getGoalManager().checkDone(args.goalId, evidence);
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_goal_pause',
  {
    description: '暂停目标（用户独占操作，系统不可覆盖）',
    inputSchema: {
      goalId: z.string(),
      reason: z.string().optional(),
    },
  },
  async (args: any) => {
    try {
      const goal = getGoalManager().pauseGoal(args.goalId, args.reason ?? 'paused via MCP');
      return { content: [toText(goal)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_goal_resume',
  {
    description: '恢复暂停的目标',
    inputSchema: {
      goalId: z.string(),
      reason: z.string().optional(),
    },
  },
  async (args: any) => {
    try {
      const goal = getGoalManager().resumeGoal(args.goalId, args.reason ?? 'resumed via MCP');
      return { content: [toText(goal)] };
    } catch (e) {
      return toError(e);
    }
  },
);

// ============================================================
// Loop 模块（4 tools）
// ============================================================

server.registerTool(
  'awkn_loop_l1',
  {
    description:
      '执行 L1 Turn-based ReAct 循环（单轮多步，默认 maxLoops=8）。调用 LLM，耗时可能较长。',
    inputSchema: {
      prompt: z.string().describe('任务提示词'),
    },
  },
  async (args: any) => {
    try {
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false });
      const result = await loop.runL1(args.prompt);
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_loop_l2',
  {
    description:
      '执行 L2 Goal-based 循环（多轮直到达成验收或耗尽预算）。调用 LLM，耗时可能很长。',
    inputSchema: {
      goalId: z.string().describe('目标 ID（需先 awkn_goal_create 创建）'),
      prompt: z.string().describe('任务提示词'),
      maxCycles: z.number().optional().describe('最大循环轮数，默认 50'),
    },
  },
  async (args: any) => {
    try {
      const loop = new AgentLoop({
        cwd: process.cwd(),
        enableL2: true,
        goalId: args.goalId,
        maxL2Cycles: args.maxCycles ?? 50,
      });
      const result = await loop.runL2(args.prompt);
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_loop_list_checkpoints',
  {
    description: '列出可恢复的 L1 checkpoint（断点恢复用）',
    inputSchema: {
      goal: z.string().optional().describe('按 goalId 过滤'),
    },
  },
  async (args: any) => {
    try {
      const { getLoopStateManager } = await import('../core/loop-state-manager.js');
      const list = getLoopStateManager().listResumable(args.goal);
      return { content: [toText({ count: list.length, checkpoints: list })] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_loop_clear_checkpoint',
  {
    description: '手动清除某 checkpoint（不再 resume）',
    inputSchema: { id: z.string() },
  },
  async (args: any) => {
    try {
      const { getLoopStateManager } = await import('../core/loop-state-manager.js');
      getLoopStateManager().clearCheckpoint(args.id, true, 'manual clear via MCP');
      return { content: [toText({ id: args.id, cleared: true })] };
    } catch (e) {
      return toError(e);
    }
  },
);

// ============================================================
// Skill 模块（3 tools）
// ============================================================

server.registerTool(
  'awkn_skill_list',
  {
    description: '列出所有已加载的技能',
    inputSchema: {},
  },
  async () => {
    try {
      const skills = getSkillsManager().getActiveSkills();
      return {
        content: [
          toText(
            skills.map((s) => ({
              name: s.name,
              version: s.version,
              description: s.description,
              triggers: s.triggers,
            })),
          ),
        ],
      };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_skill_match',
  {
    description: '根据用户输入匹配触发的技能',
    inputSchema: { userInput: z.string().describe('用户输入文本') },
  },
  async (args: any) => {
    try {
      const matched = getSkillsManager().matchTriggers(args.userInput);
      return {
        content: [
          toText(
            matched.map((s) => ({ name: s.name, description: s.description })),
          ),
        ],
      };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_skill_show',
  {
    description: '查看技能详情（含 prompt body）',
    inputSchema: { name: z.string().describe('技能名') },
  },
  async (args: any) => {
    try {
      const sm = getSkillsManager();
      const meta = sm.getSkill(args.name);
      const body = sm.getSkillBody(args.name);
      if (!meta) return toError(new Error(`Skill "${args.name}" not found`));
      return { content: [toText({ meta, body })] };
    } catch (e) {
      return toError(e);
    }
  },
);

// ============================================================
// Tianhuo 模块（3 tools）— 转发到 packages/awkn-engine-mcp 唯一路由实现
//
// 路由/推进的唯一实现源：packages/awkn-engine-mcp/runtime/src/capabilities/router.ts
// （TianhuoRouter：路线表 + SQLite 持久化 + 跨进程恢复 + 确定性 Gate + Review Receipt 门禁）。
// 根目录 runtime 不再维护任务分类与推进链路逻辑，以下三工具按 canonical 契约
// 动态复用该实现；若 packages 目录缺失，工具返回明确错误并提示使用 awkn-mcp-admin-server.js。
// ============================================================

const PACKAGE_CAPABILITIES_DIR = resolve(
  __dirname,
  '..', '..', '..',
  'packages', 'awkn-engine-mcp', 'runtime', 'src', 'capabilities',
);

let tianhuoRouter: unknown = null;

/** 懒加载 package 的 TianhuoRouter（含 CapabilityManager / AgentLoopPolicyManager） */
async function getTianhuoRouter(): Promise<{ start: any; advance: any; status: any }> {
  if (tianhuoRouter) return tianhuoRouter as { start: any; advance: any; status: any };
  const { CapabilityManager } = await import(pathToFileURL(resolve(PACKAGE_CAPABILITIES_DIR, 'manager.ts')).href);
  const { AgentLoopPolicyManager } = await import(pathToFileURL(resolve(PACKAGE_CAPABILITIES_DIR, 'agent-loop-policy.ts')).href);
  const { TianhuoRouter } = await import(pathToFileURL(resolve(PACKAGE_CAPABILITIES_DIR, 'router.ts')).href);
  const engineRoot = process.env.AWKN_ENGINE_ROOT ?? resolve(__dirname, '..', '..', '..');
  const capabilitiesRoot =
    process.env.AWKN_CAPABILITIES_ROOT ?? resolve(engineRoot, 'capabilities');
  const capabilities = new CapabilityManager(capabilitiesRoot);
  capabilities.loadAll();
  const policies = new AgentLoopPolicyManager(capabilitiesRoot, capabilities);
  tianhuoRouter = new TianhuoRouter(capabilities, policies);
  return tianhuoRouter as { start: any; advance: any; status: any };
}

server.registerTool(
  'awkn_tianhuo_start',
  {
    description:
      '启动天火项目工作流（转发 packages/awkn-engine-mcp TianhuoRouter）；返回 workflowId、首个能力卡、固定内容哈希与 AgentLoop 策略',
    inputSchema: {
      task: z.string().min(1).describe('用户原始任务，保留显式自主循环措辞'),
      projectPath: z.string().optional().describe('项目绝对路径，缺省为引擎根目录'),
      requestedCapability: z.string().optional().describe('用户显式指定的能力，如 engineer / @工程师'),
      mode: z.enum(['standard', 'preflight', 'production', 'autonomous']).optional(),
    },
  },
  async (args: any) => {
    try {
      const router = await getTianhuoRouter();
      const engineRoot = process.env.AWKN_ENGINE_ROOT ?? resolve(__dirname, '..', '..', '..');
      const result = router.start({
        task: args.task,
        projectPath: args.projectPath ?? engineRoot,
        requestedCapability: args.requestedCapability?.replace(/^@/, ''),
        mode: args.mode,
      });
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_tianhuo_advance',
  {
    description:
      '提交当前阶段的新鲜证据并推进（转发 packages/awkn-engine-mcp TianhuoRouter）；门禁不足时保持或暂停当前工作流',
    inputSchema: {
      workflowId: z.string().uuid().describe('awkn_tianhuo_start 返回的 workflowId'),
      status: z.string().describe('pass/success/completed 或 failed/blocked'),
      evidence: z.array(z.string()).min(1).describe('命令、测试、审核或哈希等新鲜证据'),
      artifacts: z.array(z.string()).optional(),
      gateResults: z.record(z.string()).optional(),
      reviewReceipt: z.record(z.unknown()).optional().describe('audit 阶段必填的完整 awkn-review-receipt/v1'),
    },
  },
  async (args: any) => {
    try {
      const router = await getTianhuoRouter();
      const result = router.advance(args);
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_tianhuo_status',
  {
    description:
      '查询或在引擎重启后恢复天火工作流（转发 packages/awkn-engine-mcp TianhuoRouter）；能力内容哈希变化时安全暂停',
    inputSchema: { workflowId: z.string().uuid().describe('awkn_tianhuo_start 返回的 workflowId') },
  },
  async (args: any) => {
    try {
      const router = await getTianhuoRouter();
      return { content: [toText(router.status(args.workflowId))] };
    } catch (e) {
      return toError(e);
    }
  },
);

// ============================================================
// Hook 模块（3 tools）
// ============================================================

server.registerTool(
  'awkn_hook_list',
  {
    description: '列出所有已注册的 hook',
    inputSchema: {},
  },
  async () => {
    try {
      return { content: [toText(hookManager.getHooks())] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_hook_trigger',
  {
    description: '触发指定生命周期的 hook',
    inputSchema: {
      point: z.string().describe('hook point（如 pre_tool_use / post_tool_use / session_stop）'),
      tool: z.string().optional().describe('工具名（pre_tool_use/post_tool_use 用）'),
      prompt: z.string().optional().describe('提示词'),
    },
  },
  async (args: any) => {
    try {
      const results = await hookManager.trigger(args.point as never, {
        point: args.point as HookPoint,
        toolName: args.tool,
        prompt: args.prompt,
      });
      return { content: [toText(results)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_hook_register',
  {
    description: '注册 command 类型 hook（function 类型只能编程式注册）',
    inputSchema: {
      point: z.string().describe('hook point'),
      command: z.string().describe('要执行的命令'),
      id: z.string().optional().describe('hook ID（不传自动生成）'),
    },
  },
  async (args: any) => {
    try {
      hookManager.register({
        id: args.id ?? `mcp-${args.point}-${Date.now()}`,
        point: args.point as HookPoint,
        type: 'command',
        command: args.command,
        timeout: 30000,
      });
      return {
        content: [toText({ registered: true, point: args.point, command: args.command })],
      };
    } catch (e) {
      return toError(e);
    }
  },
);

// ============================================================
// Cron 模块（7 tools）
// ============================================================

server.registerTool(
  'awkn_cron_add',
  {
    description: '添加定时任务',
    inputSchema: {
      name: z.string(),
      cron: z.string().describe('cron 表达式（如 "0 */6 * * *" 每6小时）'),
      type: z.enum(['http', 'tool', 'script', 'evolve']),
      payload: z.string().describe('JSON 格式的 payload'),
    },
  },
  async (args: any) => {
    try {
      const { getCronJobsManager } = await import('../cron/jobs-manager.js');
      const payload = JSON.parse(args.payload) as Record<string, unknown>;
      const job = getCronJobsManager().add({
        name: args.name,
        cronExpr: args.cron,
        actionType: args.type,
        actionPayload: payload,
      });
      return { content: [toText(job)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_cron_list',
  {
    description: '列出定时任务',
    inputSchema: { enabledOnly: z.boolean().optional() },
  },
  async (args: any) => {
    try {
      const { getCronJobsManager } = await import('../cron/jobs-manager.js');
      const jobs = getCronJobsManager().list({ enabledOnly: args.enabledOnly ?? false });
      return { content: [toText(jobs)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_cron_show',
  {
    description: '查看定时任务详情',
    inputSchema: { jobId: z.string() },
  },
  async (args: any) => {
    try {
      const { getCronJobsManager } = await import('../cron/jobs-manager.js');
      const job = getCronJobsManager().read(args.jobId);
      if (!job) return toError(new Error(`Job not found: ${args.jobId}`));
      return { content: [toText(job)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_cron_remove',
  {
    description: '删除定时任务',
    inputSchema: { jobId: z.string() },
  },
  async (args: any) => {
    try {
      const { getCronJobsManager } = await import('../cron/jobs-manager.js');
      const result = getCronJobsManager().remove(args.jobId);
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_cron_enable',
  {
    description: '启用定时任务',
    inputSchema: { jobId: z.string() },
  },
  async (args: any) => {
    try {
      const { getCronJobsManager } = await import('../cron/jobs-manager.js');
      const job = getCronJobsManager().setEnabled(args.jobId, true);
      return { content: [toText(job)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_cron_disable',
  {
    description: '禁用定时任务',
    inputSchema: { jobId: z.string() },
  },
  async (args: any) => {
    try {
      const { getCronJobsManager } = await import('../cron/jobs-manager.js');
      const job = getCronJobsManager().setEnabled(args.jobId, false);
      return { content: [toText(job)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_cron_trigger',
  {
    description: '手动触发定时任务（不等 cron 调度）',
    inputSchema: { jobId: z.string() },
  },
  async (args: any) => {
    try {
      const { getCronEngine } = await import('../cron/engine.js');
      const result = await getCronEngine().triggerJob(args.jobId);
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

// ============================================================
// Orchestrate 模块（2 tools）
// ============================================================

server.registerTool(
  'awkn_orchestrate_tianhuo_cicd',
  {
    description:
      '天火-CICD 多 agent 编排循环（天火执行 + cicd-tester 审查）。调用 LLM，耗时很长。',
    inputSchema: {
      goal: z.string().describe('目标 ID'),
      task: z.string().describe('任务提示词'),
      maxCycles: z.number().optional().describe('最大循环轮数，默认 10'),
      tianhuoProvider: z.enum(['trae', 'codex', 'minimax']).optional(),
      cicdProvider: z.enum(['trae', 'codex', 'minimax']).optional(),
    },
  },
  async (args: any) => {
    try {
      const { runTianhuoCicdLoop } = await import('../orchestrator/tianhuo-cicd-loop.js');
      const result = await runTianhuoCicdLoop({
        cwd: process.cwd(),
        goalId: args.goal,
        taskPrompt: args.task,
        maxCycles: args.maxCycles ?? 10,
        tianhuoPromptPath: 'agents/tianhuo/agent.prompt',
        cicdTesterPromptPath: 'agents/cicd-tester/agent.prompt',
        tianhuoProvider: (args.tianhuoProvider as LlmProvider) ?? 'trae',
        cicdTesterProvider: (args.cicdProvider as LlmProvider) ?? 'codex',
        maxTurnsPerCycle: 8,
      });
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_orchestrate_prd_centric',
  {
    description: 'PRD 中心化循环（围绕原始目标迭代执行）。调用 LLM，耗时很长。',
    inputSchema: {
      goal: z.string().describe('目标 ID'),
      task: z.string().describe('原始目标描述'),
      maxCycles: z.number().optional().describe('最大循环轮数，默认 5'),
    },
  },
  async (args: any) => {
    try {
      const { runPrdCentricLoop } = await import('../orchestrator/prd-centric-loop.js');
      const result = await runPrdCentricLoop({
        cwd: process.cwd(),
        goalId: args.goal,
        originalGoal: args.task,
        maxCycles: args.maxCycles ?? 5,
      });
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

// ============================================================
// Evolve 模块（6 tools）
// ============================================================

server.registerTool(
  'awkn_evolve_detect',
  {
    description: '检测重复错误模式并写经验文件（自进化闭环）',
    inputSchema: {},
  },
  async () => {
    try {
      const { getPatternDetector } = await import('../evolve/pattern-detector.js');
      const { writeAllExperiences } = await import('../evolve/experience-writer.js');
      const patterns = getPatternDetector().detect();
      if (patterns.length === 0) {
        return { content: [toText({ patterns: [], message: '无重复模式' })] };
      }
      const writes = writeAllExperiences(patterns);
      return { content: [toText({ patterns, writes })] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_evolve_list',
  {
    description: '列出 corrections-ledger 最近记录',
    inputSchema: {
      source: z.string().optional(),
      goalId: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().optional().describe('默认 50'),
      sinceHours: z.number().optional(),
    },
  },
  async (args: any) => {
    try {
      const { getCorrectionsLedger } = await import('../evolve/corrections-ledger.js');
      const rows = getCorrectionsLedger().list({
        source: args.source,
        goalId: args.goalId,
        status: args.status,
        sinceHours: args.sinceHours,
        limit: args.limit ?? 50,
      });
      return { content: [toText(rows)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_evolve_resolve',
  {
    description: '标记某条 correction 为已解决',
    inputSchema: {
      id: z.string(),
      resolution: z.string(),
      experienceId: z.string().optional(),
    },
  },
  async (args: any) => {
    try {
      const { getCorrectionsLedger } = await import('../evolve/corrections-ledger.js');
      const row = getCorrectionsLedger().resolve(args.id, args.resolution, args.experienceId);
      return { content: [toText(row)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_evolve_stats',
  {
    description: '按 source 分组统计 corrections',
    inputSchema: { sinceHours: z.number().optional().describe('默认 24') },
  },
  async (args: any) => {
    try {
      const { getCorrectionsLedger } = await import('../evolve/corrections-ledger.js');
      const sinceHours = args.sinceHours ?? 24;
      const stats = getCorrectionsLedger().statsBySource(sinceHours);
      const fingerprints = getCorrectionsLedger().countByFingerprint(sinceHours);
      return {
        content: [toText({ sinceHours, statsBySource: stats, topFingerprints: fingerprints.slice(0, 10) })],
      };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_evolve_scan_drafts',
  {
    description: '扫描待补全的经验草稿（纯文件扫描，不调 LLM）',
    inputSchema: {},
  },
  async () => {
    try {
      const { scanPendingDrafts } = await import('../evolve/experience-writer.js');
      const pending = scanPendingDrafts();
      return { content: [toText({ pending: pending.length, drafts: pending })] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_evolve_complete_drafts',
  {
    description: '触发 LLM 补全经验草稿（调用 awkn-复盘总结 15.1 流程）',
    inputSchema: { cwd: z.string().optional() },
  },
  async (args: any) => {
    try {
      const { completePendingDrafts } = await import('../evolve/experience-writer.js');
      const result = await completePendingDrafts(args.cwd ?? process.cwd());
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

// ============================================================
// Agent 模块（2 tools）— 加载智能体人格与经验
// ============================================================

/** agents/ 目录相对于 runtime/src/mcp/ 的位置 */
const AGENTS_ROOT = resolve(__dirname, '..', '..', '..', 'agents');

/** 智能体结构化层定义 */
const AGENT_LAYERS: Record<string, { dir?: string; files: string[] }> = {
  prompt: { files: ['agent.prompt'] },
  soul: { dir: '01-身份与行为', files: ['SOUL.md', 'IDENTITY.md', 'BOUNDARY.md', 'USER.md'] },
  sop: { dir: '02-流程与规范', files: ['SOP.md', 'AGENTS.md'] },
  capability: { dir: '03-能力与工具', files: ['CAPABILITY.md', 'CAPABILITY-TREE.md', 'TOOLS.md', 'ENV.md', 'VFM.md'] },
  memory: { dir: '04-记忆与知识', files: ['MEMORY.md', 'KNOWLEDGE.md', 'ADL.md', 'DECISION.md'] },
};

server.registerTool(
  'awkn_agent_load',
  {
    description:
      '加载智能体完整配置（人格、SOP、能力、经验）。' +
      '可用智能体：tianhuo（天火，全栈编排）、cicd-tester（CICD 审查）。' +
      'layers 可选：prompt,soul,sop,capability,memory,experience（默认 prompt+soul+sop）。',
    inputSchema: {
      agent: z.string().describe('智能体名（tianhuo / cicd-tester）'),
      layers: z.string().optional().describe('逗号分隔的层名（prompt,soul,sop,capability,memory,experience），默认 prompt,soul,sop'),
      experienceCategory: z.string().optional().describe('经验分类过滤（决策框架/执行协议/协作网络/踩坑教训/最佳实践/能力进化），不传则返回索引'),
    },
  },
  async (args: any) => {
    try {
      const { readFileSync, existsSync, readdirSync } = await import('node:fs');
      const agentDir = resolve(AGENTS_ROOT, args.agent);
      if (!existsSync(agentDir)) {
        const available = readdirSync(AGENTS_ROOT).filter((d) => {
          const p = resolve(AGENTS_ROOT, d);
          return existsSync(resolve(p, 'agent.prompt'));
        });
        return toError(new Error(`Agent "${args.agent}" not found. Available: ${available.join(', ')}`));
      }

      const requestedLayers = (args.layers ?? 'prompt,soul,sop').split(',').map((s: string) => s.trim());
      const result: Record<string, unknown> = { agent: args.agent, layers: {} as Record<string, unknown> };
      const layers = result.layers as Record<string, unknown>;

      for (const layerName of requestedLayers) {
        if (layerName === 'experience') {
          // 经验层特殊处理
          const qoderExpDir = resolve(agentDir, '.qoder', 'experience');
          const derivedDir = resolve(agentDir, '04-记忆与知识', 'EXPERIENCE', 'derived');

          if (args.experienceCategory) {
            // 返回指定分类的经验文件内容
            const categoryMap: Record<string, string> = {
              '决策框架': '01-决策框架',
              '执行协议': '02-执行协议',
              '协作网络': '03-协作网络',
              '踩坑教训': '04-踩坑教训',
              '最佳实践': '05-最佳实践',
              '能力进化': '06-能力进化',
            };
            const subDir = categoryMap[args.experienceCategory];
            if (subDir && existsSync(resolve(qoderExpDir, subDir))) {
              const files = readdirSync(resolve(qoderExpDir, subDir)).filter((f) => f.endsWith('.md'));
              const contents: Record<string, string> = {};
              for (const f of files) {
                contents[f] = readFileSync(resolve(qoderExpDir, subDir, f), 'utf-8');
              }
              layers.experience = { category: args.experienceCategory, entries: contents };
            } else {
              layers.experience = { error: `Category "${args.experienceCategory}" not found` };
            }
          } else {
            // 返回经验索引
            const indexPath = resolve(qoderExpDir, 'index.json');
            const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf-8')) : null;
            const derivedCount = existsSync(derivedDir) ? readdirSync(derivedDir).filter((f) => f.endsWith('.md')).length : 0;
            layers.experience = { index, derivedCount, hint: 'Pass experienceCategory to load specific category content' };
          }
          continue;
        }

        const layerDef = AGENT_LAYERS[layerName];
        if (!layerDef) {
          layers[layerName] = { error: `Unknown layer "${layerName}". Valid: ${Object.keys(AGENT_LAYERS).join(',')},experience` };
          continue;
        }

        const layerContent: Record<string, string> = {};
        for (const file of layerDef.files) {
          const filePath = layerDef.dir
            ? resolve(agentDir, layerDef.dir, file)
            : resolve(agentDir, file);
          if (existsSync(filePath)) {
            layerContent[file] = readFileSync(filePath, 'utf-8');
          }
        }
        if (Object.keys(layerContent).length > 0) {
          layers[layerName] = layerContent;
        }
      }

      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_agent_list',
  {
    description: '列出所有可用智能体及其描述',
    inputSchema: {},
  },
  async () => {
    try {
      const { readdirSync, existsSync, readFileSync } = await import('node:fs');
      const agents = readdirSync(AGENTS_ROOT).filter((d) => {
        return existsSync(resolve(AGENTS_ROOT, d, 'agent.prompt'));
      });
      const result = agents.map((name) => {
        const soulPath = resolve(AGENTS_ROOT, name, '01-身份与行为', 'SOUL.md');
        const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf-8').slice(0, 200) : '';
        const promptPath = resolve(AGENTS_ROOT, name, 'agent.prompt');
        const promptPreview = existsSync(promptPath) ? readFileSync(promptPath, 'utf-8').slice(0, 300) : '';
        return { name, soulPreview: soul, promptPreview };
      });
      return { content: [toText({ count: result.length, agents: result })] };
    } catch (e) {
      return toError(e);
    }
  },
);

// ============================================================
// Workflow v2 — awkn_workflow_* (FR-037~FR-041, 单内核适配)
// MCP 仅封装同一 WorkflowRuntime，禁止创建第二份状态或第二套调度逻辑
// ============================================================

server.registerTool(
  'awkn_workflow_start',
  {
    description: '启动工作流智能体系统（初始化 Mission 阶段 + best-effort 分配）',
    inputSchema: {
      missionId: z.string().describe('Mission ID (goal_ 开头)'),
      authorizationEnvelopeId: z.string().describe('Authorization Envelope ID (env_ 开头)'),
      frozenInputHash: z.string().describe('冻结输入 SHA256 (64 hex)'),
      frozenSourceSha: z.string().optional().describe('冻结源码 SHA (可选)'),
    },
  },
  async (args: any) => {
    try {
      const result = startWorkflow({
        missionId: args.missionId,
        authorizationEnvelopeId: args.authorizationEnvelopeId,
        frozenInputHash: args.frozenInputHash,
        frozenSourceSha: args.frozenSourceSha,
      });
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_workflow_status',
  {
    description: '查询工作流状态汇总（各状态阶段数 + isComplete）',
    inputSchema: {
      missionId: z.string().describe('Mission ID'),
    },
  },
  async (args: any) => {
    try {
      const status = getWorkflowStatus(args.missionId);
      return { content: [toText(status)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_workflow_resume',
  {
    description: '恢复已暂停/阻塞的工作流',
    inputSchema: {
      missionId: z.string().describe('Mission ID'),
    },
  },
  async (args: any) => {
    try {
      const result = resumeWorkflow(args.missionId);
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

server.registerTool(
  'awkn_workflow_cancel',
  {
    description: '取消工作流（所有未完成阶段 → CANCELLED）',
    inputSchema: {
      missionId: z.string().describe('Mission ID'),
    },
  },
  async (args: any) => {
    try {
      const result = cancelWorkflow(args.missionId);
      return { content: [toText(result)] };
    } catch (e) {
      return toError(e);
    }
  },
);

// ============================================================
// 启动
// ============================================================

async function main(): Promise<void> {
  // MCP stdio 协议：stdout 专用于 JSON-RPC 消息，所有日志必须走 stderr
  console.log = (...a: unknown[]) => console.error('[mcp]', ...a);

  initEngine();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 优雅关闭
  const shutdown = async () => {
    await server.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('MCP server fatal:', err);
  process.exit(1);
});
