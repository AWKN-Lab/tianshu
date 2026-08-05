import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../store/db.js';
import { EvolutionLifecycle, type EvolutionCandidate } from './lifecycle.js';

export interface ReplayCase {
  id: string;
  name: string;
  input: Record<string, unknown>;
  expected?: Record<string, unknown>;
  tags?: string[];
  sourceRunId?: string;
}

export interface ReplayMetrics {
  successRate: number;
  avgCycles: number;
  tokenCount: number;
  errorRate: number;
  humanTakeoverRate: number;
  securityViolationRate: number;
}

export type ReplayRunner = (testCase: ReplayCase, candidate: EvolutionCandidate | null) => Promise<ReplayMetrics>;

export interface EvaluationThresholds {
  minSuccessDelta: number;
  maxTokenRatio: number;
  maxCycleRatio: number;
  maxErrorDelta: number;
  maxTakeoverDelta: number;
  maxSecurityViolationDelta: number;
}

const DEFAULT_THRESHOLDS: EvaluationThresholds = {
  minSuccessDelta: 0,
  maxTokenRatio: 1.1,
  maxCycleRatio: 1.1,
  maxErrorDelta: 0,
  maxTakeoverDelta: 0,
  maxSecurityViolationDelta: 0,
};

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregate(results: ReplayMetrics[]): ReplayMetrics {
  return {
    successRate: average(results.map((result) => result.successRate)),
    avgCycles: average(results.map((result) => result.avgCycles)),
    tokenCount: average(results.map((result) => result.tokenCount)),
    errorRate: average(results.map((result) => result.errorRate)),
    humanTakeoverRate: average(results.map((result) => result.humanTakeoverRate)),
    securityViolationRate: average(results.map((result) => result.securityViolationRate)),
  };
}

export class ReplayEvaluator {
  private readonly lifecycle: EvolutionLifecycle;
  constructor(private readonly db: Database.Database = getDb()) {
    this.lifecycle = new EvolutionLifecycle(db);
  }

  addCase(input: Omit<ReplayCase, 'id'>): ReplayCase {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO evolution_replay_cases
       (id, name, input_json, expected_json, tags_json, enabled, source_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      input.name,
      JSON.stringify(input.input),
      JSON.stringify(input.expected ?? {}),
      JSON.stringify(input.tags ?? []),
      input.sourceRunId ?? null,
      new Date().toISOString(),
    );
    return { id, ...input };
  }

  listCases(): ReplayCase[] {
    const rows = this.db.prepare(
      'SELECT * FROM evolution_replay_cases WHERE enabled = 1 ORDER BY created_at ASC, rowid ASC',
    ).all() as Array<{
      id: string;
      name: string;
      input_json: string;
      expected_json: string;
      tags_json: string;
      source_run_id: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      input: JSON.parse(row.input_json) as Record<string, unknown>,
      expected: JSON.parse(row.expected_json) as Record<string, unknown>,
      tags: JSON.parse(row.tags_json) as string[],
      sourceRunId: row.source_run_id ?? undefined,
    }));
  }

  async evaluate(candidateId: string, runner: ReplayRunner, thresholds: Partial<EvaluationThresholds> = {}): Promise<{
    verdict: 'PASS' | 'FAIL';
    baseline: ReplayMetrics;
    candidate: ReplayMetrics;
    reasons: string[];
    /** 非裁决性超限告警（如 token 注入开销），不影响 verdict，随评测留痕 */
    warnings: string[];
  }> {
    const candidate = this.lifecycle.read(candidateId);
    if (!candidate) throw new Error(`candidate ${candidateId} not found`);
    const originalStatus = candidate.status;
    if (candidate.status === 'DRAFT' || candidate.status === 'QUARANTINED') this.lifecycle.transition(candidateId, 'VALIDATING');
    else if (candidate.status !== 'VALIDATING' && candidate.status !== 'ACTIVE') throw new Error(`candidate ${candidateId} cannot be evaluated from ${candidate.status}`);

    const cases = this.listCases();
    if (cases.length === 0) throw new Error('no enabled replay cases');
    const baselineResults: ReplayMetrics[] = [];
    const candidateResults: ReplayMetrics[] = [];
    for (const testCase of cases) {
      baselineResults.push(await runner(testCase, null));
      candidateResults.push(await runner(testCase, candidate));
    }

    const baseline = aggregate(baselineResults);
    const candidateMetrics = aggregate(candidateResults);
    const config = { ...DEFAULT_THRESHOLDS, ...thresholds };
    const reasons: string[] = [];
    const warnings: string[] = [];
    // 主门禁：成功率/错误率/轮次/接管/安全违规，直接裁决
    if (candidateMetrics.successRate < baseline.successRate + config.minSuccessDelta) reasons.push('success rate did not meet threshold');
    if (baseline.avgCycles > 0 && candidateMetrics.avgCycles / baseline.avgCycles > config.maxCycleRatio) reasons.push('cycle count regressed');
    if (candidateMetrics.errorRate - baseline.errorRate > config.maxErrorDelta) reasons.push('error rate regressed');
    if (candidateMetrics.humanTakeoverRate - baseline.humanTakeoverRate > config.maxTakeoverDelta) reasons.push('human takeover rate regressed');
    if (candidateMetrics.securityViolationRate - baseline.securityViolationRate > config.maxSecurityViolationDelta) reasons.push('security violations regressed');
    // token 仅作超限告警：候选侧 token 增量包含规则文本自身的注入开销（system prompt
    // 注入 CANDIDATE_ENGINEERING_RULE 块），不能由该固定开销单独裁决 QUARANTINED。
    // 超限仍随评测留痕（warnings + delta_json），供成本观测与人工复核。
    if (baseline.tokenCount > 0 && candidateMetrics.tokenCount / baseline.tokenCount > config.maxTokenRatio) {
      warnings.push(`token cost exceeded warning ratio (maxTokenRatio=${config.maxTokenRatio})`);
    }
    const verdict = reasons.length === 0 ? 'PASS' : 'FAIL';
    const evaluation = { verdict, reasons, warnings, thresholds: config, cases: cases.length };

    this.db.prepare(
      `INSERT INTO evolution_evaluations
       (id, candidate_id, baseline_json, candidate_json, delta_json, verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      candidateId,
      JSON.stringify(baseline),
      JSON.stringify(candidateMetrics),
      JSON.stringify({
        successRate: candidateMetrics.successRate - baseline.successRate,
        avgCycles: candidateMetrics.avgCycles - baseline.avgCycles,
        tokenCount: candidateMetrics.tokenCount - baseline.tokenCount,
        errorRate: candidateMetrics.errorRate - baseline.errorRate,
        humanTakeoverRate: candidateMetrics.humanTakeoverRate - baseline.humanTakeoverRate,
        securityViolationRate: candidateMetrics.securityViolationRate - baseline.securityViolationRate,
      }),
      verdict,
      new Date().toISOString(),
    );
    this.lifecycle.saveEvaluation(candidateId, {
      baselineMetrics: { ...baseline },
      candidateMetrics: { ...candidateMetrics },
      evaluation,
    });
    if (originalStatus === 'ACTIVE') {
      if (verdict === 'FAIL') this.lifecycle.transition(candidateId, 'QUARANTINED', reasons.join('; '));
    } else {
      this.lifecycle.transition(candidateId, verdict === 'PASS' ? 'APPROVED' : 'QUARANTINED', reasons.join('; '));
    }
    return { verdict, baseline, candidate: candidateMetrics, reasons, warnings };
  }
}
