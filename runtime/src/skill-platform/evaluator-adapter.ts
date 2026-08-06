/**
 * Skill 测评适配层。
 *
 * 把 MCP awkn_skill_evaluate 工具请求转发到 workflows/skill-platform/evaluate.py，
 * 通过 python-runner 安全调用，返回 AssessmentResult。
 *
 * 安全约束：
 * - skillDir 必须在 engineRoot 内（边界检查）。
 * - context 通过临时文件传递（避免命令行长度限制和注入）。
 * - 临时文件在 finally 块中清理。
 */

import { resolve, relative, isAbsolute, sep } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPython, type PythonRunResult } from './python-runner.js';

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

export interface EvaluatorRequest {
  /** Skill 目录绝对路径（必须在 engineRoot 内） */
  skillDir: string;
  /** 测评模式 */
  mode?: 'quick' | 'full' | 'boost' | 'batch';
  /** 测评上下文（JSON 对象） */
  context?: Record<string, unknown>;
  /** 引擎根目录 */
  engineRoot: string;
  /** Python 可执行路径（可选） */
  python?: string;
  /** 超时毫秒（可选，默认 120s） */
  timeoutMs?: number;
}

export interface EvaluatorResult {
  status: string;
  mode: string;
  assessment_result?: unknown;
  diagnosis?: unknown;
  improvement_gate?: unknown;
  schema_validation?: unknown;
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
 * 运行 Skill 测评。
 *
 * 调用 workflows/skill-platform/evaluate.py，返回结构化 AssessmentResult。
 * 不抛异常（除非参数非法）；调用方根据 status 判断成功与否。
 */
export async function runEvaluator(opts: EvaluatorRequest): Promise<EvaluatorResult> {
  const engineRoot = resolve(opts.engineRoot);
  const scriptPath = resolve(engineRoot, 'workflows', 'skill-platform', 'evaluate.py');
  const skillDir = resolve(opts.skillDir);

  // 边界检查：skillDir 必须在 engineRoot 内
  if (!isWithin(engineRoot, skillDir)) {
    throw new Error(`SKILL_DIR_OUT_OF_BOUNDS: ${skillDir} 不在引擎根 ${engineRoot} 内`);
  }

  const mode = opts.mode ?? 'full';
  const args: string[] = [skillDir, '--mode', mode];

  // context 通过临时文件传递（避免命令行长度限制和注入）
  let tmpDir: string | undefined;
  if (opts.context && Object.keys(opts.context).length > 0) {
    tmpDir = await mkdtemp(join(tmpdir(), 'awkn-evaluator-'));
    const ctxPath = join(tmpDir, 'context.json');
    await writeFile(ctxPath, JSON.stringify(opts.context), 'utf-8');
    args.push('--context', ctxPath);
  }

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
      return { status: 'FAILED', mode, error: 'EVALUATOR_TIMEOUT', execution };
    }
    if (raw.truncated) {
      return { status: 'FAILED', mode, error: 'EVALUATOR_OUTPUT_TRUNCATED', execution };
    }

    const payload = raw.json as Record<string, unknown> | undefined;
    if (!payload) {
      return {
        status: 'FAILED',
        mode,
        error: `EVALUATOR_OUTPUT_INVALID_JSON: ${raw.stdout.slice(0, 500)}`,
        execution,
      };
    }

    return {
      status: String(payload.status ?? 'UNKNOWN'),
      mode: String(payload.mode ?? mode),
      assessment_result: payload.assessment_result,
      diagnosis: payload.diagnosis,
      improvement_gate: payload.improvement_gate,
      schema_validation: payload.schema_validation,
      route_trace: payload.route_trace as unknown[] | undefined,
      error: payload.error as string | undefined,
      execution,
    };
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
