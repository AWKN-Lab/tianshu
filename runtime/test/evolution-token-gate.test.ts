/**
 * 回放评测 token 阈值口径回归测试（token 仅作超限告警，不单独裁决）。
 *
 * 背景：候选规则文本注入 system prompt（CANDIDATE_ENGINEERING_RULE 块）必然
 * 带来 token 增量，旧实现中 token 比值 > maxTokenRatio(1.1) 会单独触发
 * 'token cost regressed' → QUARANTINED。本测试复刻真实 QUARANTINED 候选的
 * 指标模式（successRate=1、errorRate=0、token 比值 1.3~1.65），确认修复后：
 *   - 裁决由成功率/错误率等主门决定，token 仅进 warnings（不 FAIL）；
 *   - 主门回归时仍 FAIL；
 *   - 评测留痕边界保持：delta_json 保留 tokenCount delta，evaluation 留痕含 warnings。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/store/migrations.js';
import { EvolutionLifecycle } from '../src/evolve/lifecycle.js';
import { ReplayEvaluator, type ReplayMetrics } from '../src/evolve/replay-evaluator.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const lifecycle = new EvolutionLifecycle(db);
  const evaluator = new ReplayEvaluator(db);
  return { db, lifecycle, evaluator };
}

/** 复刻真实 QUARANTINED 候选（history: token 973→1492.67, ratio≈1.53） */
function quarantinedTokenPattern(): ReplayMetrics {
  return { successRate: 1, avgCycles: 1, tokenCount: 1492.67, errorRate: 0, humanTakeoverRate: 0, securityViolationRate: 0 };
}

function baselineMetrics(): ReplayMetrics {
  return { successRate: 1, avgCycles: 1, tokenCount: 973, errorRate: 0, humanTakeoverRate: 0, securityViolationRate: 0 };
}

describe('ReplayEvaluator token gate — 注入开销不单独裁决', () => {
  it('token 超限（ratio>1.1）但主门全过 → PASS + warnings 告警 + APPROVED（不再 QUARANTINED）', async () => {
    const { lifecycle, evaluator } = setup();
    evaluator.addCase({ name: 'case-1', input: { prompt: 'task' } });
    evaluator.addCase({ name: 'case-2', input: { prompt: 'task' } });
    evaluator.addCase({ name: 'case-3', input: { prompt: 'task' } });
    const candidate = lifecycle.createCandidate({ experienceId: 'EXP-TOKEN-WARN', contentPath: 'warn.md', contentHash: 'warn' });

    const result = await evaluator.evaluate(candidate.id, async (_case, active) => active
      ? quarantinedTokenPattern()
      : baselineMetrics());

    assert.equal(result.verdict, 'PASS', `token 注入开销不得单独裁决，reasons=${JSON.stringify(result.reasons)}`);
    assert.deepEqual(result.reasons, [], 'reasons 不应包含任何门禁失败');
    assert.ok(result.warnings.length > 0, 'token 超限应进入 warnings 告警');
    assert.ok(result.warnings[0]!.includes('token cost exceeded warning ratio'), `warnings=${JSON.stringify(result.warnings)}`);
    assert.equal(lifecycle.read(candidate.id)?.status, 'APPROVED', 'token 超限不应导致 QUARANTINED');
  });

  it('token 超限 + 主门回归（successRate 下降）→ 仍 FAIL，token 不进 reasons', async () => {
    const { lifecycle, evaluator } = setup();
    evaluator.addCase({ name: 'case-1', input: { prompt: 'task' } });
    const candidate = lifecycle.createCandidate({ experienceId: 'EXP-TOKEN-FAIL', contentPath: 'fail.md', contentHash: 'fail' });

    const result = await evaluator.evaluate(candidate.id, async (_case, active) => active
      ? { successRate: 0.5, avgCycles: 1, tokenCount: 1492.67, errorRate: 0, humanTakeoverRate: 0, securityViolationRate: 0 }
      : baselineMetrics());

    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.reasons.includes('success rate did not meet threshold'), `reasons=${JSON.stringify(result.reasons)}`);
    assert.ok(!result.reasons.some((r) => r.includes('token')), 'token 不应作为裁决原因');
    assert.ok(result.warnings.some((w) => w.includes('token cost exceeded warning ratio')), 'token 超限仍应告警留痕');
    assert.equal(lifecycle.read(candidate.id)?.status, 'QUARANTINED');
  });

  it('留痕边界：delta_json 保留 tokenCount delta，evaluation 留痕含 warnings 且阈值原样', async () => {
    const { db, lifecycle, evaluator } = setup();
    evaluator.addCase({ name: 'case-1', input: { prompt: 'task' } });
    const candidate = lifecycle.createCandidate({ experienceId: 'EXP-TOKEN-TRAIL', contentPath: 'trail.md', contentHash: 'trail' });

    await evaluator.evaluate(candidate.id, async (_case, active) => active
      ? quarantinedTokenPattern()
      : baselineMetrics());

    const row = db.prepare(
      `SELECT delta_json FROM evolution_evaluations WHERE candidate_id = ?`,
    ).get(candidate.id) as { delta_json: string };
    const delta = JSON.parse(row.delta_json) as { tokenCount: number };
    assert.equal(delta.tokenCount, 1492.67 - 973, 'evolution_evaluations.delta_json 必须保留 tokenCount delta 留痕');

    const saved = lifecycle.read(candidate.id)!;
    const evaluation = JSON.parse(saved.evaluation_json!) as { verdict: string; reasons: string[]; warnings: string[]; thresholds: { maxTokenRatio: number } };
    assert.equal(evaluation.verdict, 'PASS');
    assert.deepEqual(evaluation.reasons, []);
    assert.ok(evaluation.warnings.length > 0, 'candidate.evaluation_json 留痕必须含 warnings');
    assert.equal(evaluation.thresholds.maxTokenRatio, 1.1, '阈值配置必须原样留痕');
    const baseline = JSON.parse(saved.baseline_metrics_json!) as { tokenCount: number };
    const candidateMetrics = JSON.parse(saved.candidate_metrics_json!) as { tokenCount: number };
    assert.equal(baseline.tokenCount, 973);
    assert.equal(candidateMetrics.tokenCount, 1492.67, 'baseline/candidate metrics 留痕必须完整保留');
  });
});
