/**
 * awkn-engine CLI 入口
 *
 * 4 个子命令：
 * - goal: L2 目标管理（create / list / check-done / pause / resume）
 * - loop: L1/L2 循环执行
 * - hook: hook 管理（list / register / trigger）
 * - skill: 技能管理（list / match / show）
 */

import { getDb, closeDb } from './store/db.js';
import { getGoalManager } from './goal/goal-manager.js';
import { getSkillsManager } from './skills/manager.js';
import { toolRegistry } from './tools/registry.js';
import { builtinTools } from './tools/builtin/index.js';
import { AgentLoop } from './core/agent-loop.js';
import { startCronEngine, stopCronEngine } from './cron/engine.js';
import { hookManager } from './core/hook-manager.js';
import type { HookPoint } from './core/hook-types.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { LlmProvider } from './llm/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 加载 runtime/.env 文件（不引入 dotenv，手动解析，不覆盖已有环境变量） */
function loadEnv(): void {
  const envPath = resolve(__dirname, '..', '.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!key) continue;
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env 不存在或读取失败，忽略
  }
}

loadEnv();

const command = process.argv[2];
const subcommand = process.argv[3];

function usage(): void {
  console.log(`awkn-engine — awkn引擎 轻量 Node.js 运行时

用法：
  awkn-engine <command> [subcommand] [args]

命令：
  goal    L2 目标管理
          create --title <title> --desc <desc> [--hao <hao1,hao2,...>]
          list [--owner <owner>] [--state <state>]
          show <goalId>
          check-done <goalId> --evidence <json>
          pause <goalId>
          resume <goalId>

  loop    L1/L2 循环执行
          l1 <prompt>
          l2 <goalId> <prompt>
          list-checkpoints [--goal <goalId>]
                              列出可恢复的 L1 checkpoint（断点恢复用）
          clear-checkpoint <id>  手动清除某 checkpoint（不再 resume）

  hook    hook 管理
          list
          trigger <point> [--tool <toolName>] [--prompt <prompt>]

  skill   技能管理
          list
          match <userInput>
          show <skillName>

  cron    定时任务管理
          add --name <name> --cron <expr> --type <http|tool|script> --payload <json>
          list [--enabled-only]
          show <jobId>
          remove <jobId>
          enable <jobId>
          disable <jobId>
          start
          stop
          trigger <jobId>

  orchestrate  多 agent 循环编排
          tianhuo-cicd --goal <id> --task <prompt> [--maxCycles N]
                       [--tianhuoProvider trae|codex|minimax]
                       [--cicdProvider trae|codex|minimax]
          prd-centric --goal <id> --task <原始目标> [--maxCycles N]

  evolve   自进化机制（M3）
          detect              检测重复错误模式 + 写经验文件
          list                列出 corrections_ledger 最近记录
          resolve <id> --resolution <text>
                              标记某条 correction 为已解决
          stats               按 source 分组统计
          scan-drafts         扫描 derived 目录待补全草稿（M3 进阶-18）
          complete-drafts     触发 awkn-复盘总结 15.1 补全草稿（需 LLM，M3 进阶-18）

环境变量：
  AWKN_LLM_PROVIDER       默认 LLM provider（trae|codex|minimax）
  AWKN_CODEX_API_KEY      CODEX API key
  AWKN_CODEX_BASE_URL     CODEX base URL
  AWKN_CODEX_MODEL        CODEX 默认模型
  AWKN_MINIMAX_API_KEY    MiniMax API key
  AWKN_MINIMAX_BASE_URL   MiniMax base URL
  AWKN_MINIMAX_MODEL      MiniMax 默认模型
  AWKN_LOG_LEVEL          日志级别（debug|info|warn|error）
`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // 支持 --key=value 格式（带空格的值用引号包裹时不会被 shell 拆分）
      const eqIdx = a.indexOf('=');
      if (eqIdx !== -1) {
        const key = a.slice(2, eqIdx);
        const val = a.slice(eqIdx + 1);
        args[key] = val;
        continue;
      }
      // 原有 --key value 格式
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
      args[key] = val;
      if (val) i++;
    }
  }
  return args;
}

async function main(): Promise<void> {
  // 初始化
  getDb();
  // skills 目录：优先环境变量，否则用 __dirname 相对路径（URL 解码正确）
  const skillsRoot = process.env.AWKN_SKILLS_ROOT
    ?? resolve(__dirname, '..', '..', 'skills');
  getSkillsManager(skillsRoot).loadAll();
  for (const tool of builtinTools) {
    toolRegistry.register(tool);
  }

  // 可选：从环境变量加载 L1 桥接 hook（command 类型，接收 stdin 输出 stdout）
  if (process.env.AWKN_LLM_HOOK_SCRIPT) {
    hookManager.register({
      id: 'l1-bridge-script',
      point: 'pre_llm_call',
      type: 'command',
      command: process.env.AWKN_LLM_HOOK_SCRIPT,
      timeout: 30000,
    });
    console.log(`已注册 L1 桥接 hook: ${process.env.AWKN_LLM_HOOK_SCRIPT}`);
  }

  // M3 自进化：默认注册 session_stop hook，会话结束自动检测重复模式并写经验文件
  // 可通过 AWKN_DISABLE_EVOLVE=1 关闭（用于性能压测或测试场景）
  if (process.env.AWKN_DISABLE_EVOLVE !== '1') {
    const { stopExperienceExtractHook } = await import('./evolve/experience-writer.js');
    hookManager.register({
      id: 'stop:experience-extract',
      point: 'session_stop',
      type: 'function',
      fn: stopExperienceExtractHook,
      timeout: 30000,
    });
  }

  try {
    switch (command) {
      case 'goal':
        await handleGoal(subcommand);
        break;
      case 'loop':
        await handleLoop(subcommand);
        break;
      case 'hook':
        await handleHook(subcommand);
        break;
      case 'skill':
        await handleSkill(subcommand);
        break;
      case 'cron':
        await handleCron(subcommand);
        break;
      case 'orchestrate':
        await handleOrchestrate(subcommand);
        break;
      case 'evolve':
        await handleEvolve(subcommand);
        break;
      default:
        usage();
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    // 触发 session_stop hook（让经验沉淀有机会执行）
    await hookManager.trigger('session_stop', { point: 'session_stop' }).catch(() => {});
    closeDb();
  }
}

async function handleGoal(sub: string): Promise<void> {
  const gm = getGoalManager();
  const args = parseArgs(process.argv.slice(4));

  switch (sub) {
    case 'create': {
      const hao = args.hao
        ? args.hao.split(',').map((d) => ({ description: d.trim(), passed: false }))
        : [{ description: args.desc, passed: false }];
      const goal = gm.create({
        title: args.title,
        description: args.desc,
        owner: args.owner ?? 'user',
        hao,
      });
      console.log(JSON.stringify(goal, null, 2));
      break;
    }
    case 'list': {
      const goals = gm.list({
        owner: args.owner,
        state: args.state as never,
      });
      console.log(JSON.stringify(goals, null, 2));
      break;
    }
    case 'show': {
      const goal = gm.read(process.argv[4]);
      console.log(JSON.stringify(goal, null, 2));
      break;
    }
    case 'pause': {
      const goal = gm.pauseGoal(process.argv[4], args.reason ?? 'user paused');
      console.log(JSON.stringify(goal, null, 2));
      break;
    }
    case 'resume': {
      const goal = gm.resumeGoal(process.argv[4], args.reason ?? 'user resumed');
      console.log(JSON.stringify(goal, null, 2));
      break;
    }
    case 'check-done': {
      const goalId = process.argv[4];
      const evidence = JSON.parse(args.evidence);
      const result = gm.checkDone(goalId, evidence);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      console.error('Unknown goal subcommand:', sub);
      process.exit(1);
  }
}

async function handleLoop(sub: string): Promise<void> {
  const args = parseArgs(process.argv.slice(4));
  const promptArg = process.argv.find((a, i) => i > 3 && !a.startsWith('--'));

  switch (sub) {
    case 'l1': {
      const prompt = promptArg ?? args.prompt ?? '';
      if (!prompt) {
        console.error('需要提供 prompt');
        process.exit(1);
      }
      const loop = new AgentLoop({ cwd: process.cwd(), enableL2: false });
      const result = await loop.runL1(prompt);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'l2': {
      const goalId = process.argv[4];
      const prompt = process.argv[5] ?? '';
      if (!goalId || !prompt) {
        console.error('用法：awkn-engine loop l2 <goalId> <prompt>');
        process.exit(1);
      }
      const loop = new AgentLoop({
        cwd: process.cwd(),
        enableL2: true,
        goalId,
        maxL2Cycles: Number(args.maxCycles ?? 50),
      });
      const result = await loop.runL2(prompt);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'list-checkpoints': {
      // 列出可恢复的 L1 checkpoint（断点恢复用）
      const { getLoopStateManager } = await import('./core/loop-state-manager.js');
      const list = getLoopStateManager().listResumable(args.goal);
      if (list.length === 0) {
        console.log(JSON.stringify({ message: '无可恢复的 checkpoint', checkpoints: [] }, null, 2));
      } else {
        console.log(JSON.stringify({ count: list.length, checkpoints: list }, null, 2));
      }
      break;
    }
    case 'clear-checkpoint': {
      // 手动清除某 checkpoint（标记 terminated，不再 resume）
      const id = process.argv[4];
      if (!id) {
        console.error('用法：awkn-engine loop clear-checkpoint <id>');
        process.exit(1);
      }
      const { getLoopStateManager } = await import('./core/loop-state-manager.js');
      // 没有公开的"按 id 加载并清除"方法，直接 clearCheckpoint（内部会查行）
      getLoopStateManager().clearCheckpoint(id, true, 'manual clear via CLI');
      console.log(JSON.stringify({ id, cleared: true }, null, 2));
      break;
    }
    default:
      console.error('Unknown loop subcommand:', sub);
      console.error('可用：l1 | l2 | list-checkpoints | clear-checkpoint');
      process.exit(1);
  }
}

async function handleHook(sub: string): Promise<void> {
  const args = parseArgs(process.argv.slice(4));

  switch (sub) {
    case 'list': {
      const hooks = hookManager.getHooks();
      console.log(JSON.stringify(hooks, null, 2));
      break;
    }
    case 'trigger': {
      const point = process.argv[4] as never;
      const results = await hookManager.trigger(point, {
        point,
        toolName: args.tool,
        prompt: args.prompt,
      });
      console.log(JSON.stringify(results, null, 2));
      break;
    }
    case 'register': {
      // 用法: hook register --point <HookPoint> --type command --command <cmd> [--id <id>]
      const point = args.point as HookPoint;
      const type = args.type as 'command' | 'function';
      if (!point) { console.error('缺少 --point'); process.exit(1); }
      if (type === 'command') {
        const command = args.command;
        if (!command) { console.error('缺少 --command'); process.exit(1); }
        hookManager.register({
          id: args.id ?? `cli-${point}-${Date.now()}`,
          point,
          type: 'command',
          command,
          timeout: 30000,
        });
        console.log(`已注册 command hook: point=${point}, command=${command}`);
      } else {
        console.error('function 类型 hook 只能通过编程式注册，CLI 不支持');
        process.exit(1);
      }
      break;
    }
    default:
      console.error('Unknown hook subcommand:', sub);
      process.exit(1);
  }
}

async function handleSkill(sub: string): Promise<void> {
  const sm = getSkillsManager();

  switch (sub) {
    case 'list': {
      const skills = sm.getActiveSkills();
      console.log(JSON.stringify(skills.map((s) => ({
        name: s.name,
        version: s.version,
        description: s.description,
        triggers: s.triggers,
      })), null, 2));
      break;
    }
    case 'match': {
      const userInput = process.argv.slice(4).join(' ');
      const matched = sm.matchTriggers(userInput);
      console.log(JSON.stringify(matched.map((s) => ({
        name: s.name,
        description: s.description,
      })), null, 2));
      break;
    }
    case 'show': {
      const name = process.argv[4];
      const meta = sm.getSkill(name);
      const body = sm.getSkillBody(name);
      if (!meta) {
        console.error(`Skill "${name}" not found`);
        process.exit(1);
      }
      console.log(JSON.stringify({ meta, body }, null, 2));
      break;
    }
    default:
      console.error('Unknown skill subcommand:', sub);
      process.exit(1);
  }
}

async function handleCron(sub: string): Promise<void> {
  const args = parseArgs(process.argv.slice(4));

  switch (sub) {
    case 'add': {
      const { getCronJobsManager } = await import('./cron/jobs-manager.js');
      const actionType = args.type as 'http' | 'tool' | 'script' | 'evolve';
      if (!['http', 'tool', 'script', 'evolve'].includes(actionType)) {
        console.error('--type 必须是 http | tool | script | evolve');
        process.exit(1);
      }
      let payload: Record<string, unknown> = {};
      if (args.payload) {
        try {
          payload = JSON.parse(args.payload) as Record<string, unknown>;
        } catch {
          console.error('--payload 不是合法 JSON');
          process.exit(1);
        }
      }
      const job = getCronJobsManager().add({
        name: args.name ?? '',
        cronExpr: args.cron ?? '',
        actionType,
        actionPayload: payload,
        id: args.id,
      });
      console.log(JSON.stringify(job, null, 2));
      break;
    }
    case 'list': {
      const { getCronJobsManager } = await import('./cron/jobs-manager.js');
      const jobs = getCronJobsManager().list({
        enabledOnly: args.enabledOnly === 'true' || args.enabledOnly === '1',
      });
      console.log(JSON.stringify(jobs, null, 2));
      break;
    }
    case 'show': {
      const { getCronJobsManager } = await import('./cron/jobs-manager.js');
      const job = getCronJobsManager().read(process.argv[4] ?? '');
      if (!job) {
        console.error(`Job not found: ${process.argv[4]}`);
        process.exit(1);
      }
      console.log(JSON.stringify(job, null, 2));
      break;
    }
    case 'remove': {
      const { getCronJobsManager } = await import('./cron/jobs-manager.js');
      const result = getCronJobsManager().remove(process.argv[4] ?? '');
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'enable': {
      const { getCronJobsManager } = await import('./cron/jobs-manager.js');
      const job = getCronJobsManager().setEnabled(process.argv[4] ?? '', true);
      console.log(JSON.stringify(job, null, 2));
      break;
    }
    case 'disable': {
      const { getCronJobsManager } = await import('./cron/jobs-manager.js');
      const job = getCronJobsManager().setEnabled(process.argv[4] ?? '', false);
      console.log(JSON.stringify(job, null, 2));
      break;
    }
    case 'start': {
      startCronEngine();
      console.log('CronEngine started');
      // 保持进程运行
      process.on('SIGINT', () => {
        stopCronEngine();
        process.exit(0);
      });
      // M3 进阶-12（2026-07-23）：阻塞 forever，防止 main() finally 的 closeDb() 提前关闭 DB
      // 原版：break 后回到 main() 的 try-finally，finally 立即 closeDb()，
      //   但 cron 引擎还在运行 → 所有 executeJob 的 insertLog/updateJobAfterRun/queryAll 全部抛 DB closed
      //   → L3 自动化彻底失效（cron 调度的每次执行都因 DB 关闭而失败）
      // 修复：await 一个永不 resolve 的 Promise，让 handleCron 永不返回 → finally 不执行
      //   进程靠 pending promise 保持存活，SIGINT 时 process.exit(0) 退出
      await new Promise<void>(() => {});
      break;
    }
    case 'stop': {
      stopCronEngine();
      console.log('CronEngine stopped');
      break;
    }
    case 'trigger': {
      const { getCronEngine } = await import('./cron/engine.js');
      const jobId = process.argv[4];
      const result = await getCronEngine().triggerJob(jobId);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      console.error('Unknown cron subcommand:', sub);
      process.exit(1);
  }
}

async function handleOrchestrate(sub: string): Promise<void> {
  const args = parseArgs(process.argv.slice(4));

  switch (sub) {
    case 'tianhuo-cicd': {
      const goalId = args.goal;
      const task = args.task ?? process.env.AWKN_TASK;
      if (!goalId || !task) {
        console.error('用法：awkn-engine orchestrate tianhuo-cicd --goal <id> --task <prompt> [--maxCycles N]');
        process.exit(1);
      }
      const { runTianhuoCicdLoop } = await import('./orchestrator/tianhuo-cicd-loop.js');
      const result = await runTianhuoCicdLoop({
        cwd: process.cwd(),
        goalId,
        taskPrompt: task,
        maxCycles: Number(args.maxCycles ?? 10),
        tianhuoPromptPath: args.tianhuoPrompt ?? 'agents/tianhuo/agent.prompt',
        cicdTesterPromptPath: args.cicdPrompt ?? 'agents/cicd-tester/agent.prompt',
        tianhuoProvider: (args.tianhuoProvider as LlmProvider) ?? 'trae',
        cicdTesterProvider: (args.cicdProvider as LlmProvider) ?? 'codex',
        maxTurnsPerCycle: Number(args.maxTurns ?? 8),
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'prd-centric': {
      const goalId = args.goal;
      const task = args.task ?? process.env.AWKN_TASK;
      if (!goalId || !task) {
        console.error('用法：awkn-engine orchestrate prd-centric --goal <id> --task <原始目标> [--maxCycles N]');
        process.exit(1);
      }
      const { runPrdCentricLoop } = await import('./orchestrator/prd-centric-loop.js');
      const result = await runPrdCentricLoop({
        cwd: process.cwd(),
        goalId,
        originalGoal: task,
        maxCycles: Number(args.maxCycles ?? 5),
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      console.error('Unknown orchestrate subcommand:', sub);
      console.error('可用：tianhuo-cicd | prd-centric');
      process.exit(1);
  }
}

async function handleEvolve(sub: string): Promise<void> {
  const args = parseArgs(process.argv.slice(4));

  switch (sub) {
    case 'detect': {
      const { getPatternDetector } = await import('./evolve/pattern-detector.js');
      const { writeAllExperiences } = await import('./evolve/experience-writer.js');
      const patterns = getPatternDetector().detect();
      if (patterns.length === 0) {
        console.log(JSON.stringify({ patterns: [], message: '无重复模式' }, null, 2));
        break;
      }
      const writes = writeAllExperiences(patterns);
      console.log(JSON.stringify({ patterns, writes }, null, 2));
      break;
    }
    case 'list': {
      const { getCorrectionsLedger } = await import('./evolve/corrections-ledger.js');
      const limit = args.limit ? Number(args.limit) : 50;
      const sinceHours = args.sinceHours ? Number(args.sinceHours) : undefined;
      const rows = getCorrectionsLedger().list({
        source: args.source,
        goalId: args.goalId,
        status: args.status,
        fingerprint: args.fingerprint,
        sinceHours,
        limit,
      });
      console.log(JSON.stringify(rows, null, 2));
      break;
    }
    case 'resolve': {
      const id = process.argv[4];
      if (!id || !args.resolution) {
        console.error('用法：awkn-engine evolve resolve <id> --resolution <text>');
        process.exit(1);
      }
      const { getCorrectionsLedger } = await import('./evolve/corrections-ledger.js');
      const row = getCorrectionsLedger().resolve(id, args.resolution, args.experienceId);
      console.log(JSON.stringify(row, null, 2));
      break;
    }
    case 'stats': {
      const { getCorrectionsLedger } = await import('./evolve/corrections-ledger.js');
      const sinceHours = args.sinceHours ? Number(args.sinceHours) : 24;
      const stats = getCorrectionsLedger().statsBySource(sinceHours);
      const fingerprints = getCorrectionsLedger().countByFingerprint(sinceHours);
      console.log(JSON.stringify({ sinceHours, statsBySource: stats, topFingerprints: fingerprints.slice(0, 10) }, null, 2));
      break;
    }
    case 'scan-drafts': {
      // M3 进阶-18：扫描待补全草稿（纯文件扫描，不需要 LLM）
      const { scanPendingDrafts } = await import('./evolve/experience-writer.js');
      const pending = scanPendingDrafts();
      if (pending.length === 0) {
        console.log(JSON.stringify({ pending: 0, message: '无待补全草稿' }, null, 2));
      } else {
        console.log(JSON.stringify({ pending: pending.length, drafts: pending }, null, 2));
      }
      break;
    }
    case 'complete-drafts': {
      // M3 进阶-18：触发 awkn-复盘总结 15.1 流程补全草稿（需要 LLM）
      const { completePendingDrafts } = await import('./evolve/experience-writer.js');
      const cwd = (args.cwd as string) ?? process.cwd();
      try {
        const result = await completePendingDrafts(cwd);
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        console.error(`草稿补全失败: ${(e as Error).message}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error('Unknown evolve subcommand:', sub);
      console.error('可用：detect | list | resolve | stats | scan-drafts | complete-drafts');
      process.exit(1);
  }
}

main();
