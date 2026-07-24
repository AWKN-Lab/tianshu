import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EvolutionLifecycle } from '../../src/evolve/lifecycle.js';
import {
  AgentReplayRunner,
  EvolutionOrchestrator,
  HistoricalReplayManager,
  metricsFromReplay,
} from '../../src/evolve/operational-evolution.js';
import { ReplayEvaluator } from '../../src/evolve/replay-evaluator.js';
import { runMigrations } from '../../src/store/migrations.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function candidateFile(content = 'Always add a deterministic regression test.'): string {
  const root = mkdtempSync(join(tmpdir(), 'awkn-evolution-'));
  const path = join(root, 'candidate.md');
  writeFileSync(path, content, 'utf-8');
  return path;
}

function insertCorrection(db: Database.Database, id: string, fingerprint: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO corrections_ledger
     (id, ts, source, severity, error_text, fingerprint, context_json, status, created_at, updated_at)
     VALUES (?, ?, 'testGate', 'error', 'repeat failure', ?, '{}', 'open', ?, ?)`,
  ).run(id, now, fingerprint, now, now);
}

describe('operational evolution loop', () => {
  it('deduplicates in-flight candidates and closes evidence only after activation', () => {
    const db = setup();
    const lifecycle = new EvolutionLifecycle(db);
    const correctionId = randomUUID();
    insertCorrection(db, correctionId, 'fingerprint-1');
    const path = candidateFile();
    const first = lifecycle.createCandidate({
      experienceId: 'EXP-OP-1',
      contentPath: path,
      sourceFingerprint: 'fingerprint-1',
      correctionIds: [correctionId],
    });
    const second = lifecycle.createCandidate({
      experienceId: 'EXP-OP-OTHER',
      contentPath: path,
      sourceFingerprint: 'fingerprint-1',
      correctionIds: [correctionId],
    });
    assert.equal(second.id, first.id);
    assert.equal((db.prepare('SELECT status FROM corrections_ledger WHERE id = ?').get(correctionId) as { status: string }).status, 'open');

    lifecycle.transition(first.id, 'VALIDATING');
    lifecycle.transition(first.id, 'APPROVED');
    lifecycle.activate(first.id);
    const correction = db.prepare('SELECT status, experience_id FROM corrections_ledger WHERE id = ?').get(correctionId) as { status: string; experience_id: string };
    assert.equal(correction.status, 'resolved');
    assert.equal(correction.experience_id, 'EXP-OP-1');
  });

  it('imports terminal Runs once as historical replay cases', () => {
    const db = setup();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs (id, workflow_name, status, input_json, output_json, started_at, finished_at, updated_at, trace_id)
       VALUES ('run-1', 'historical-test', 'succeeded', ?, '{}', ?, ?, ?, '00112233445566778899aabbccddeeff')`,
    ).run(JSON.stringify({ userInput: 'repair the failing contract test' }), now, now, now);
    const manager = new HistoricalReplayManager(db);
    assert.deepEqual(manager.importTerminalRuns(10), { imported: 1, skipped: 0 });
    assert.deepEqual(manager.importTerminalRuns(10), { imported: 0, skipped: 1 });
    const count = db.prepare('SELECT COUNT(*) AS count FROM evolution_replay_cases').get() as { count: number };
    assert.equal(count.count, 1);
  });

  it('calculates takeover and security metrics from replay evidence', () => {
    const metrics = metricsFromReplay({
      finalText: '',
      totalTurns: 2,
      totalTokens: 120,
      terminated: true,
      terminationReason: 'policy blocked: workspace boundary',
      observations: [{ isError: true, errorMessage: 'approval required' }],
    }, { success: true });
    assert.equal(metrics.successRate, 0);
    assert.equal(metrics.errorRate, 1);
    assert.equal(metrics.humanTakeoverRate, 1);
    assert.equal(metrics.securityViolationRate, 1);
  });

  it('runs baseline and candidate through an injected executor and promotes a passing rule', async () => {
    const db = setup();
    const lifecycle = new EvolutionLifecycle(db);
    const candidate = lifecycle.createCandidate({
      experienceId: 'EXP-OP-PROMOTE',
      contentPath: candidateFile('Use deterministic checks.'),
      sourceFingerprint: 'promote-fingerprint',
    });
    const evaluator = new ReplayEvaluator(db);
    evaluator.addCase({ name: 'repair', input: { prompt: 'repair test' }, expected: { success: true } });
    let calls = 0;
    const orchestrator = new EvolutionOrchestrator(db);
    const result = await orchestrator.promote({
      candidateId: candidate.id,
      executor: async ({ systemPrompt }) => {
        calls++;
        const candidateApplied = systemPrompt?.includes('CANDIDATE_ENGINEERING_RULE') ?? false;
        return {
          finalText: 'completed',
          totalTurns: candidateApplied ? 2 : 3,
          totalTokens: candidateApplied ? 80 : 100,
          terminated: false,
          observations: [],
        };
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.evaluation.verdict, 'PASS');
    assert.equal(result.candidate?.status, 'ACTIVE');
    const replayRows = db.prepare('SELECT mode FROM evolution_replay_runs ORDER BY rowid ASC').all() as Array<{ mode: string }>;
    assert.deepEqual(replayRows.map((row) => row.mode), ['baseline', 'candidate']);
  });

  it('records failed candidate replay and quarantines regressions', async () => {
    const db = setup();
    const lifecycle = new EvolutionLifecycle(db);
    const candidate = lifecycle.createCandidate({
      experienceId: 'EXP-OP-FAIL',
      contentPath: candidateFile('Unsafe candidate.'),
      sourceFingerprint: 'fail-fingerprint',
    });
    new ReplayEvaluator(db).addCase({ name: 'security', input: { prompt: 'safe task' }, expected: { success: true } });
    const runner = new AgentReplayRunner(db, {
      executor: async ({ systemPrompt }) => systemPrompt?.includes('CANDIDATE_ENGINEERING_RULE')
        ? { finalText: '', totalTurns: 1, totalTokens: 50, terminated: true, terminationReason: 'policy blocked: sensitive path', observations: [] }
        : { finalText: 'ok', totalTurns: 1, totalTokens: 50, terminated: false, observations: [] },
    });
    const evaluation = await new ReplayEvaluator(db).evaluate(candidate.id, (testCase, active) => runner.run(testCase, active));
    assert.equal(evaluation.verdict, 'FAIL');
    assert.equal(lifecycle.read(candidate.id)?.status, 'QUARANTINED');
  });
});
