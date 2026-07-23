/**
 * 7 个质量门禁实现 — Loop Engineering "说不"的东西
 *
 * 三类实现：
 * 1. 直接跑命令：typecheckGate / testGate / lintGate（调 tsc/jest/eslint 二进制）
 * 2. 解析外部传入的 verdict：reviewGate / securityGate（caller 必须先调 awkn-审核 技能）
 * 3. 纯逻辑：verificationGate / budgetGate
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../core/logger.js';
import { getGoalManager } from '../goal/goal-manager.js';
import { parseReviewVerdict } from './prd-consistency.js';
import { getCorrectionsLedger } from '../evolve/corrections-ledger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('QualityGates');

// ─── 通用类型 ─────────────────────────────────────────────────────

export interface GateContext {
  /** 工作目录 */
  cwd: string;
  /** 关联的 goal ID（L2 循环用） */
  goalId?: string;
  /** 类型检查命令（默认 tsc --noEmit） */
  typecheckCmd?: string;
  /** 测试命令（默认 node --import tsx --test，可覆盖为 vitest run） */
  testCmd?: string;
  /** lint 命令（默认 eslint .） */
  lintCmd?: string;
  /** 验证证据（verificationGate 用） */
  evidence?: Array<{ hao: string; pass: boolean; proof?: string }>;
  /**
   * 真实 review 输出文本（reviewGate 用）
   * 调用方负责先调 awkn-审核 技能（callSkill 模式）拿到 finalText，再传入此处
   * 设计原因：reviewGate 内部不直接调 LLM，避免 quality-gates ↔ agent-loop 循环依赖
   * 历史问题：v0.1 reviewGate 默认 passed=true，导致 L2 永远"自评自满"通过
   */
  reviewVerdict?: string;
}

export interface GateResult {
  name: string;
  passed: boolean;
  /** 不通过时的详情 */
  details?: string;
  /** 不通过时的建议动作 */
  suggestion?: string;
  /** 执行耗时（ms） */
  durationMs: number;
}

// ─── 自进化闭环入口：记录 gate 失败到 corrections-ledger ──────────

/**
 * 把 gate FAIL 结果记录到 corrections-ledger（自进化闭环入口）
 *
 * M3 进阶-17（2026-07-23）：修复自进化闭环断链
 *   原版：corrections-ledger.record() 从未被调用 → ledger 永远为空 →
 *         pattern-detector 永远返回 [] → experience-writer 永远写 0 个文件
 *         自进化闭环"看起来实现了但实际是死代码"（无输入被当作已处理）
 *   修复：在所有 gate 评估器（runAllGates / evaluateL2StopConditions /
 *         evaluateTianhuoCicdStop）中调用此函数，记录 FAIL 结果
 *
 * 设计原则（与 EXP-DRV-20260723-001 E73 一致）：
 * - 失败必须留证据，禁止"消失在内存里"
 * - 每个 gate FAIL 都记录，pattern-detector 根据阈值决定是否触发经验沉淀
 * - ledger 写入失败不能阻断 gate 评估（evidence 是 fail-open，gate 是 fail-closed）
 *
 * @param goalId 关联的 goal ID（可空，无 L2 上下文时不记 goal）
 * @param results gate 结果数组
 */
export function recordGateFailures(
  goalId: string | undefined,
  results: GateResult[],
): void {
  const ledger = getCorrectionsLedger();
  for (const r of results) {
    if (r.passed) continue;
    try {
      ledger.record({
        goalId: goalId,
        source: r.name,
        severity:
          r.name === 'securityGate' || r.name === 'budgetGate'
            ? 'fatal'
            : 'error',
        errorText: r.details ?? r.suggestion ?? `${r.name} failed`,
        context: { suggestion: r.suggestion, durationMs: r.durationMs },
      });
    } catch (e) {
      // ledger 写入失败不阻断主流程（evidence fail-open）
      logger.warn(`Failed to record correction for ${r.name}: ${String(e)}`);
    }
  }
}

// ─── 1. typecheckGate ─────────────────────────────────────────────

export async function typecheckGate(ctx: GateContext): Promise<GateResult> {
  const startedAt = Date.now();
  const cmd = ctx.typecheckCmd ?? 'tsc --noEmit';
  const [bin, ...args] = cmd.split(' ');

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: ctx.cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    const output = (stderr + stdout).trim();
    return {
      name: 'typecheckGate',
      passed: true,
      details: output || 'tsc 0 errors',
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    const output = (e.stderr ?? '') + (e.stdout ?? '');
    return {
      name: 'typecheckGate',
      passed: false,
      details: output.slice(0, 2000) || e.message,
      suggestion: '修复类型错误后继续',
      durationMs: Date.now() - startedAt,
    };
  }
}

// ─── 2. testGate ──────────────────────────────────────────────────

export async function testGate(ctx: GateContext): Promise<GateResult> {
  const startedAt = Date.now();
  // 默认用 node:test（Node 20+ 内置，不依赖 vitest native binding）
  // 若 vitest 在当前环境可用，调用方可通过 ctx.testCmd 覆盖为 'vitest run'
  const cmd = ctx.testCmd ?? 'node --import tsx --test test';
  const [bin, ...args] = cmd.split(' ');

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: ctx.cwd,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 300_000,
      shell: true,
    });
    const output = stdout + stderr;
    // node:test 输出 "# pass N" / "# fail N"
    // vitest/jest 输出 "N passed" / "N failed"
    const failedMatch = output.match(/(\d+)\s+failed/i) ?? output.match(/#\s*fail\s+(\d+)/i);
    const failedCount = failedMatch ? Number(failedMatch[1]) : 0;

    return {
      name: 'testGate',
      passed: failedCount === 0,
      details: failedCount === 0
        ? output.match(/(\d+)\s+passed/i)?.[0] ?? 'all passed'
        : `${failedCount} failed`,
      suggestion: failedCount === 0 ? undefined : '修复失败的测试用例',
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    const output = (e.stdout ?? '') + (e.stderr ?? '');
    const failedMatch = output.match(/(\d+)\s+failed/i);
    const failedCount = failedMatch ? Number(failedMatch[1]) : 0;
    return {
      name: 'testGate',
      passed: false,
      details: `${failedCount} failed\n${output.slice(0, 1500)}`,
      suggestion: '修复失败的测试用例后继续',
      durationMs: Date.now() - startedAt,
    };
  }
}

// ─── 3. lintGate ──────────────────────────────────────────────────

export async function lintGate(ctx: GateContext): Promise<GateResult> {
  const startedAt = Date.now();
  const cmd = ctx.lintCmd ?? 'eslint .';
  const [bin, ...args] = cmd.split(' ');

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: ctx.cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      shell: true,
    });
    const output = stdout + stderr;
    // eslint 0 problems 时 exit 0
    return {
      name: 'lintGate',
      passed: true,
      details: output.trim() || '0 problems',
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    const output = (e.stdout ?? '') + (e.stderr ?? '');
    const problemMatch = output.match(/(\d+)\s+(?:error|problem)/i);
    const problemCount = problemMatch ? Number(problemMatch[1]) : 1;
    return {
      name: 'lintGate',
      passed: false,
      details: `${problemCount} problems\n${output.slice(0, 1500)}`,
      suggestion: '修复 lint 问题后继续',
      durationMs: Date.now() - startedAt,
    };
  }
}

// ─── 4. reviewGate（真实评估，依赖 caller 传入 review verdict） ────

/**
 * reviewGate — 检查 awkn-审核 输出是否为 PASS
 *
 * 设计变更（2026-07-23）：
 * - 旧版：默认 passed=true，注释说"由 agent-loop 调 LLM 执行"，但 agent-loop 主循环根本没调
 * - 新版：必须由 caller 调用 awkn-审核 技能（参考 prd-centric-loop.ts 的 callSkill 模式）
 *   拿到 finalText 后传入 ctx.reviewVerdict，本 gate 用 parseReviewVerdict 解析
 * - 无 reviewVerdict 时 returned=false（拒绝通过），杜绝"自评自满"
 *
 * 与 cicdTesterGate 对称设计（参考 quality-gates.ts#L379）
 */
export async function reviewGate(ctx: GateContext): Promise<GateResult> {
  const startedAt = Date.now();

  if (!ctx.reviewVerdict) {
    return {
      name: 'reviewGate',
      passed: false,
      details: '未提供 review verdict（caller 必须先调 awkn-审核 技能并传入 finalText）',
      suggestion: '在调 evaluateL2StopConditions 之前，先 callSkill("awkn-审核", ...) 并把结果放入 ctx.reviewVerdict',
      durationMs: Date.now() - startedAt,
    };
  }

  const verdict = parseReviewVerdict(ctx.reviewVerdict);
  return {
    name: 'reviewGate',
    passed: verdict === 'PASS',
    details: ctx.reviewVerdict.slice(0, 500),
    suggestion: verdict === 'FAIL'
      ? '根据 awkn-审核 的 ISSUES 清单修复后重新提交'
      : verdict === null
        ? 'awkn-审核 输出未包含 PASS/FAIL 标记，需检查技能 prompt'
        : undefined,
    durationMs: Date.now() - startedAt,
  };
}

// ─── 5. securityGate（真实评估，依赖 caller 传入 security 扫描结果） ──

/**
 * securityGate — 检查安全扫描结果
 *
 * 设计变更（2026-07-23）：
 * - 旧版：默认 passed=true，与 reviewGate 同样的"假达成"问题
 * - 新版：必须由 caller 调用安全扫描（awkn-审核 的安全部分或独立 awkn-安全扫描 技能）
 *   拿到扫描结果后传入 ctx.securityVerdict
 * - 无 securityVerdict 时 returned=false
 *
 * 注：当前复用 awkn-审核 输出（awkn-安全扫描 技能在仓库内不存在），实际只检查 verdict 是否 PASS
 */
export async function securityGate(ctx: GateContext): Promise<GateResult> {
  const startedAt = Date.now();

  // 暂复用 reviewVerdict 作为安全扫描来源（awkn-审核 输出已含安全维度）
  // 待 awkn-安全扫描 技能独立后，应增加 ctx.securityVerdict 字段
  if (!ctx.reviewVerdict) {
    return {
      name: 'securityGate',
      passed: false,
      details: '未提供 security 扫描结果（当前复用 reviewVerdict，待独立 awkn-安全扫描 技能接入）',
      suggestion: '在调 runAllGates 之前，先 callSkill("awkn-审核", ...) 并把结果放入 ctx.reviewVerdict',
      durationMs: Date.now() - startedAt,
    };
  }

  const verdict = parseReviewVerdict(ctx.reviewVerdict);
  return {
    name: 'securityGate',
    passed: verdict === 'PASS',
    details: ctx.reviewVerdict.slice(0, 500),
    suggestion: verdict === 'FAIL'
      ? '存在安全风险，根据 awkn-审核 的安全部分修复'
      : verdict === null
        ? 'awkn-审核 输出未包含明确 PASS/FAIL'
        : undefined,
    durationMs: Date.now() - startedAt,
  };
}

// ─── 6. verificationGate（纯逻辑：检查 fresh evidence） ──────────

export async function verificationGate(ctx: GateContext): Promise<GateResult> {
  const startedAt = Date.now();

  // 如果有关联 goal，检查 hao 验收条件是否全过
  if (ctx.goalId) {
    const goalManager = getGoalManager();
    const goal = goalManager.read(ctx.goalId);
    if (goal) {
      const allPassed = goal.hao.every((h) => h.passed);
      return {
        name: 'verificationGate',
        passed: allPassed,
        details: allPassed
          ? `goal ${goal.id} 所有 ${goal.hao.length} 项验收条件通过`
          : `goal ${goal.id} 还有 ${goal.hao.filter((h) => !h.passed).length} 项未通过`,
        suggestion: allPassed ? undefined : '继续完成未通过的验收条件',
        durationMs: Date.now() - startedAt,
      };
    }
  }

  // 无 goal 时，检查 evidence 是否非空
  if (ctx.evidence && ctx.evidence.length > 0) {
    const allPass = ctx.evidence.every((e) => e.pass);
    return {
      name: 'verificationGate',
      passed: allPass,
      details: allPass
        ? `${ctx.evidence.length} 项证据全部通过`
        : `${ctx.evidence.filter((e) => !e.pass).length} 项证据未通过`,
      suggestion: allPass ? undefined : '补充缺失的证据',
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    name: 'verificationGate',
    passed: false,
    details: '无证据，不能宣称完成',
    suggestion: '提供测试输出/截图/日志等证据',
    durationMs: Date.now() - startedAt,
  };
}

// ─── 7. budgetGate（纯逻辑：检查 token/轮数/3-strike） ───────────

export async function budgetGate(ctx: GateContext): Promise<GateResult> {
  const startedAt = Date.now();

  if (!ctx.goalId) {
    return {
      name: 'budgetGate',
      passed: true,
      details: '无 goal 关联，不检查预算',
      durationMs: Date.now() - startedAt,
    };
  }

  const goalManager = getGoalManager();
  const status = goalManager.getBudgetStatus(ctx.goalId);

  if (!status) {
    return {
      name: 'budgetGate',
      passed: false,
      details: `goal ${ctx.goalId} 不存在`,
      durationMs: Date.now() - startedAt,
    };
  }

  if (status.exceeded) {
    return {
      name: 'budgetGate',
      passed: false,
      details: `预算超限：${(status.maxUsage * 100).toFixed(1)}% on ${status.tightest}`,
      suggestion: '预算耗尽，停止循环，建议人工介入',
      durationMs: Date.now() - startedAt,
    };
  }

  if (status.warning) {
    logger.warn(`Budget warning: ${(status.maxUsage * 100).toFixed(1)}% on ${status.tightest}`);
  }

  return {
    name: 'budgetGate',
    passed: true,
    details: `预算使用 ${(status.maxUsage * 100).toFixed(1)}%${status.warning ? ' (warning)' : ''}`,
    durationMs: Date.now() - startedAt,
  };
}

// ─── 批量执行所有 gate ────────────────────────────────────────────

export async function runAllGates(ctx: GateContext): Promise<{
  results: GateResult[];
  allPassed: boolean;
  summary: string;
}> {
  const results = await Promise.all([
    typecheckGate(ctx),
    testGate(ctx),
    lintGate(ctx),
    reviewGate(ctx),
    securityGate(ctx),
    verificationGate(ctx),
    budgetGate(ctx),
  ]);

  const allPassed = results.every((r) => r.passed);
  const failedGates = results.filter((r) => !r.passed);
  const summary = allPassed
    ? `全部 ${results.length} 个 gate 通过`
    : `${failedGates.length}/${results.length} gate 未通过：${failedGates.map((g) => g.name).join(', ')}`;

  // M3 进阶-17：记录 gate 失败到 corrections-ledger（自进化闭环入口）
  recordGateFailures(ctx.goalId, results);

  return { results, allPassed, summary };
}

/**
 * L2 停止条件评估（用户选定 4 项）
 * - typecheck 0 错误
 * - test 0 failed
 * - lint 0 新增
 * - review 通过
 */
export async function evaluateL2StopConditions(ctx: GateContext): Promise<{
  achieved: boolean;
  results: GateResult[];
  summary: string;
}> {
  const results = await Promise.all([
    typecheckGate(ctx),
    testGate(ctx),
    lintGate(ctx),
    reviewGate(ctx),
  ]);

  const achieved = results.every((r) => r.passed);
  const summary = achieved
    ? 'L2 停止条件全部满足'
    : `L2 未达停止条件：${results.filter((r) => !r.passed).map((g) => g.name).join(', ')}`;

  // M3 进阶-17：记录 gate 失败到 corrections-ledger（自进化闭环入口）
  recordGateFailures(ctx.goalId, results);

  return { achieved, results, summary };
}

// ─── 场景A：天火 + cicd-tester 循环停止条件 ───────────────────────

/** 扩展 GateContext，增加 cicd-tester 评审输出 */
export interface TianhuoCicdGateContext extends GateContext {
  /** cicd-tester 的最终输出文本（含 VERDICT: PASS|FAIL） */
  cicdTesterVerdict?: string;
}

/** 从 cicd-tester 输出文本中解析 VERDICT */
export function parseVerdict(text: string): 'PASS' | 'FAIL' | null {
  const m = text.match(/VERDICT:\s*(PASS|FAIL)/i);
  return m ? m[1]!.toUpperCase() as 'PASS' | 'FAIL' : null;
}

/** cicd-tester gate：检查 cicd-tester 输出是否为 PASS */
export async function cicdTesterGate(ctx: TianhuoCicdGateContext): Promise<GateResult> {
  const startedAt = Date.now();
  const verdict = ctx.cicdTesterVerdict ? parseVerdict(ctx.cicdTesterVerdict) : null;
  return {
    name: 'cicdTesterGate',
    passed: verdict === 'PASS',
    details: ctx.cicdTesterVerdict ?? '无 cicd-tester 评审输出',
    suggestion: verdict === 'FAIL' ? '按 ISSUES 清单修复后重新提交' : verdict === null ? 'cicd-tester 未输出标准 VERDICT 格式' : undefined,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * 场景A 停止条件评估（5 项）
 * - typecheck 0 错误
 * - test 0 failed
 * - lint 0 新增
 * - cicd-tester 输出 VERDICT: PASS
 * - budget 未超限
 */
export async function evaluateTianhuoCicdStop(ctx: TianhuoCicdGateContext): Promise<{
  achieved: boolean;
  results: GateResult[];
  summary: string;
}> {
  const results = await Promise.all([
    typecheckGate(ctx),
    testGate(ctx),
    lintGate(ctx),
    cicdTesterGate(ctx),
    budgetGate(ctx),
  ]);

  const achieved = results.every((r) => r.passed);
  const summary = achieved
    ? '场景A 5项停止条件全满足'
    : `场景A 未达停止条件：${results.filter((r) => !r.passed).map((g) => g.name).join(', ')}`;

  // M3 进阶-17：记录 gate 失败到 corrections-ledger（自进化闭环入口）
  recordGateFailures(ctx.goalId, results);

  return { achieved, results, summary };
}
