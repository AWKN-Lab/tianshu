/**
 * awkn-local-action-runner — Gate Step
 *
 * 直接调 quality-gates.ts 的 7 个 gate。
 * 这是 awkn 独有优势（qoder-action 没有本地 gate）。
 */

import {
  typecheckGate,
  testGate,
  lintGate,
  reviewGate,
  securityGate,
  verificationGate,
  budgetGate,
  recordGateFailures,
  type GateContext,
  type GateResult,
} from '../../gates/quality-gates.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { GateStepDef, StepResult } from '../types.js';

const GATE_MAP: Record<string, (ctx: GateContext) => Promise<GateResult>> = {
  typecheck: typecheckGate,
  test: testGate,
  lint: lintGate,
  review: reviewGate,
  security: securityGate,
  verification: verificationGate,
  budget: budgetGate,
};

/** 解析本地 node_modules 下的可执行文件路径（Windows 兼容） */
function localTscCmd(cwd: string): string {
  // typecheckGate 用 execFile 不带 shell，Windows 上 .cmd 无法直接 exec
  // 所以用 node 跑 tsc.js（node 永远在 PATH 上）
  const tscJs = resolve(cwd, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (existsSync(tscJs)) return `node ${tscJs}`;
  return 'tsc'; // fallback
}

function localLintCmd(cwd: string): string {
  // lintGate 用 shell: true，所以 .cmd 可以跑
  const eslintCmd = resolve(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint');
  if (existsSync(eslintCmd)) return eslintCmd;
  return 'eslint';
}

export async function runGateStep(step: GateStepDef, cwd: string): Promise<StepResult> {
  const started = Date.now();
  const ctx: GateContext = {
    cwd,
    typecheckCmd: `${localTscCmd(cwd)} --noEmit`,
    lintCmd: `${localLintCmd(cwd)} .`,
  };
  const results: GateResult[] = [];

  for (const gateName of step.gates) {
    const gateFn = GATE_MAP[gateName];
    if (!gateFn) continue;
    const result = await gateFn(ctx);
    results.push(result);
  }

  // 记录失败到 corrections-ledger（自进化闭环）
  recordGateFailures(undefined, results);

  const allPassed = results.every((r) => r.passed);
  const failedNames = results.filter((r) => !r.passed).map((r) => r.name);

  return {
    name: step.name,
    type: 'gate',
    status: allPassed ? 'passed' : 'failed',
    output: allPassed
      ? `All ${results.length} gates passed`
      : `Failed: ${failedNames.join(', ')}\n${results.filter((r) => !r.passed).map((r) => `[${r.name}] ${r.details ?? ''}`).join('\n')}`,
    gateResults: results.map((r) => ({ name: r.name, passed: r.passed, details: r.details })),
    durationMs: Date.now() - started,
  };
}
