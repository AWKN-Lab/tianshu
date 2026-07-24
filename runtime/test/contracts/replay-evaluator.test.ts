import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/store/migrations.js';
import { EvolutionLifecycle } from '../../src/evolve/lifecycle.js';
import { ReplayEvaluator, type ReplayMetrics } from '../../src/evolve/replay-evaluator.js';

function metrics(overrides: Partial<ReplayMetrics> = {}): ReplayMetrics {
  return { successRate: 0.8, avgCycles: 4, tokenCount: 1000, errorRate: 0.1, humanTakeoverRate: 0.1, securityViolationRate: 0, ...overrides };
}

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const lifecycle = new EvolutionLifecycle(db);
  const evaluator = new ReplayEvaluator(db);
  evaluator.addCase({ name: 'case-1', input: { task: 'one' } });
  evaluator.addCase({ name: 'case-2', input: { task: 'two' } });
  return { lifecycle, evaluator };
}

describe('ReplayEvaluator', () => {
  it('approves a candidate only when replay metrics meet thresholds', async () => {
    const { lifecycle, evaluator } = setup();
    const candidate = lifecycle.createCandidate({ experienceId: 'EXP-PASS', contentPath: 'pass.md', contentHash: 'pass' });
    const result = await evaluator.evaluate(candidate.id, async (_case, active) => active
      ? metrics({ successRate: 0.9, avgCycles: 3, tokenCount: 900, errorRate: 0.05, humanTakeoverRate: 0.05 })
      : metrics());
    assert.equal(result.verdict, 'PASS');
    assert.equal(lifecycle.read(candidate.id)?.status, 'APPROVED');
  });

  it('quarantines security regressions', async () => {
    const { lifecycle, evaluator } = setup();
    const candidate = lifecycle.createCandidate({ experienceId: 'EXP-FAIL', contentPath: 'fail.md', contentHash: 'fail' });
    const result = await evaluator.evaluate(candidate.id, async (_case, active) => active
      ? metrics({ successRate: 0.9, securityViolationRate: 0.1 })
      : metrics());
    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.reasons.includes('security violations regressed'));
    assert.equal(lifecycle.read(candidate.id)?.status, 'QUARANTINED');
  });

  it('automatically quarantines an ACTIVE candidate on replay regression', async () => {
    const { lifecycle, evaluator } = setup();
    const candidate = lifecycle.createCandidate({ experienceId: 'EXP-ACTIVE', contentPath: 'active.md', contentHash: 'active' });
    lifecycle.transition(candidate.id, 'VALIDATING');
    lifecycle.transition(candidate.id, 'APPROVED');
    lifecycle.activate(candidate.id);
    const result = await evaluator.evaluate(candidate.id, async (_case, active) => active
      ? metrics({ successRate: 0.5, errorRate: 0.4 })
      : metrics());
    assert.equal(result.verdict, 'FAIL');
    assert.equal(lifecycle.read(candidate.id)?.status, 'QUARANTINED');
  });
});
