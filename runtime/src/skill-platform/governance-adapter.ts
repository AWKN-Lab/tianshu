/**
 * Skill 治理适配层。
 *
 * 把 MCP awkn_skill_govern 工具请求转发到 workflows/skill-platform/govern.py，
 * 通过 python-runner 安全调用，返回 GovernanceDecision。
 *
 * 安全约束：
 * - request 通过临时文件传递（避免命令行长度限制和注入）。
 * - state-file 和 receipt-dir 默认指向 runtime/data/skill-governance。
 * - apply/rollback 是写操作，调用方需做授权检查。
 * - 临时文件在 finally 块中清理。
 */

import { resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPython, type PythonRunResult } from './python-runner.js';

export type GovernanceCommand = 'inspect' | 'plan' | 'apply' | 'rollback';

export interface GovernanceRequest {
  /** 治理操作 */
  command: GovernanceCommand;
  /** 治理请求体（JSON 对象） */
  request: Record<string, unknown>;
  /** 引擎根目录 */
  engineRoot: string;
  /** 状态文件路径（可选，默认 runtime/data/skill-governance/state/governance-state.json） */
  stateFile?: string;
  /** Receipt 目录（可选，默认 runtime/data/skill-governance/receipts） */
  receiptDir?: string;
  /** Python 可执行路径（可选） */
  python?: string;
  /** 超时毫秒（可选，默认 120s） */
  timeoutMs?: number;
}

export interface GovernanceResult {
  status: string;
  command: string;
  assessment_result?: unknown;
  governance_decision?: unknown;
  route_trace?: unknown[];
  error?: string;
  /** Python 子进程执行元数据（进入 Receipt） */
  execution: {
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
    truncated: boolean;
    stderr: string;
  };
}

/**
 * 运行 Skill 治理。
 *
 * 调用 workflows/skill-platform/govern.py，返回结构化 GovernanceDecision。
 * 不抛异常（除非参数非法）；调用方根据 status 判断成功与否。
 *
 * 注意：command='apply' 是写操作，会修改 state 文件并生成 receipt；
 *       command='rollback' 会恢复前态。调用方必须确认授权。
 */
export async function runGovernance(opts: GovernanceRequest): Promise<GovernanceResult> {
  const engineRoot = resolve(opts.engineRoot);
  const scriptPath = resolve(engineRoot, 'workflows', 'skill-platform', 'govern.py');
  const command = opts.command;

  if (!opts.request || Object.keys(opts.request).length === 0) {
    throw new Error('GOVERNANCE_REQUEST_REQUIRED: request 不能为空');
  }

  const args: string[] = [command];

  // request 通过临时文件传递
  const tmpDir = await mkdtemp(join(tmpdir(), 'awkn-governance-'));
  const reqPath = join(tmpDir, 'request.json');
  await writeFile(reqPath, JSON.stringify(opts.request), 'utf-8');
  args.push('--request', reqPath);

  // state-file 和 receipt-dir 默认指向 runtime/data/skill-governance
  const stateFile = opts.stateFile
    ? resolve(opts.stateFile)
    : resolve(engineRoot, 'runtime', 'data', 'skill-governance', 'state', 'governance-state.json');
  const receiptDir = opts.receiptDir
    ? resolve(opts.receiptDir)
    : resolve(engineRoot, 'runtime', 'data', 'skill-governance', 'receipts');

  args.push('--state-file', stateFile);
  args.push('--receipt-dir', receiptDir);

  try {
    const raw: PythonRunResult = await runPython({
      python: opts.python,
      scriptPath,
      args,
      cwd: engineRoot,
      engineRoot,
      timeoutMs: opts.timeoutMs,
    });

    const execution = {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      timedOut: raw.timedOut,
      truncated: raw.truncated,
      stderr: raw.stderr,
    };

    if (raw.timedOut) {
      return { status: 'FAILED', command, error: 'GOVERNANCE_TIMEOUT', execution };
    }
    if (raw.truncated) {
      return { status: 'FAILED', command, error: 'GOVERNANCE_OUTPUT_TRUNCATED', execution };
    }

    const payload = raw.json as Record<string, unknown> | undefined;
    if (!payload) {
      return {
        status: 'FAILED',
        command,
        error: `GOVERNANCE_OUTPUT_INVALID_JSON: ${raw.stdout.slice(0, 500)}`,
        execution,
      };
    }

    return {
      status: String(payload.status ?? 'UNKNOWN'),
      command: String(payload.command ?? command),
      assessment_result: payload.assessment_result,
      governance_decision: payload.governance_decision,
      route_trace: payload.route_trace as unknown[] | undefined,
      error: payload.error as string | undefined,
      execution,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
