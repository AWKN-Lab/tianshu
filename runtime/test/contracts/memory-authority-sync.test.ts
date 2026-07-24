import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EvolutionLifecycle } from '../../src/evolve/lifecycle.js';
import {
  EvolutionOrchestrator,
  type EvolutionAuthorityGateway,
} from '../../src/evolve/operational-evolution.js';
import { ReplayEvaluator } from '../../src/evolve/replay-evaluator.js';
import { MemoryAuthorityOutboxProcessor } from '../../src/memory/authority-outbox.js';
import type { CaptureMemoryEventInput } from '../../src/memory/backend.js';
import type { GovernCandidateInput, GovernCandidateResult } from '../../src/memory/authority.js';
import { runMigrations } from '../../src/store/migrations.js';
import { runOperationalEvolutionMigration } from '../../src/store/operational-evolution-migration.js';

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  runOperationalEvolutionMigration(db);
  return db;
}

function candidateFile(content = 'Preserve public APIs and add deterministic regression tests.'): string {
  const root = mkdtempSync(join(tmpdir(), 'awkn-authority-'));
  const path = join(root, 'candidate.md');
  writeFileSync(path, content, 'utf-8');
  return path;
}

class FakeAuthority implements EvolutionAuthorityGateway {
  readonly governed: GovernCandidateInput[] = [];
  readonly activated: string[] = [];
  readonly paused: string[] = [];

  isRemoteAuthorityEnabled(): boolean { return true; }

  async governCandidate(input: GovernCandidateInput): Promise<GovernCandidateResult> {
    this.governed.push(input);
    return { experienceId: 'exp-remote-1', ruleId: 'rule-remote-1', status: 'PROPOSED' };
  }

  async activateAuthorityRule(ruleId: string): Promise<Record<string, unknown>> {
    this.activated.push(ruleId);
    return { activation_id: 'activation-1', status: 'ACTIVE' };
  }

  async pauseAuthorityRule(ruleId: string): Promise<Record<string, unknown>> {
    this.paused.push(ruleId);
    return { status: 'PAUSED' };
  }
}

describe('Memory OS authority synchronization', () => {
  it('creates a durable terminal Run outbox record and flushes complete step evidence', async () => {
    const db = setup();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs (id, workflow_name, status, input_json, started_at, updated_at, trace_id)
       VALUES ('run-authority-1', 'agent-loop-l2', 'running', '{}', ?, ?, '00112233445566778899aabbccddeeff')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO steps
       (id, run_id, step_key, step_type, status, attempt, input_json, started_at, updated_at)
       VALUES ('step-1', 'run-authority-1', 'gate:test', 'quality_gate', 'succeeded', 1, '{}', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `UPDATE runs SET status = 'succeeded', output_json = '{"result":"ok"}', finished_at = ?, updated_at = ? WHERE id = 'run-authority-1'`,
    ).run(now, now);

    const pending = db.prepare(`SELECT COUNT(*) AS count FROM memory_authority_outbox WHERE status = 'pending'`).get() as { count: number };
    assert.equal(pending.count, 1);

    const captured: CaptureMemoryEventInput[] = [];
    const processor = new MemoryAuthorityOutboxProcessor(db, {
      capture: async (input) => {
        captured.push(input);
        return { status: 'ok' };
      },
    });
    assert.deepEqual(await processor.flush(), { delivered: 1, failed: 0, pending: 0 });
    assert.equal(captured[0]?.eventType, 'run.terminal');
    assert.equal(captured[0]?.idempotencyKey, 'run:run-authority-1:terminal:succeeded');
    const steps = captured[0]?.payload.steps as Array<{ key: string }>;
    assert.equal(steps[0]?.key, 'gate:test');
  });

  it('keeps a replay-approved candidate pending until Memory OS activates its rule', async () => {
    const db = setup();
    const lifecycle = new EvolutionLifecycle(db);
    const candidate = lifecycle.createCandidate({
      experienceId: 'EXP-AUTHORITY-1',
      contentPath: candidateFile(),
      sourceFingerprint: 'authority-fingerprint',
    });
    new ReplayEvaluator(db).addCase({ name: 'upgrade', input: { prompt: 'upgrade without breaking API' }, expected: { success: true } });
    const authority = new FakeAuthority();
    const orchestrator = new EvolutionOrchestrator(db, authority);
    const promoted = await orchestrator.promote({
      candidateId: candidate.id,
      executor: async ({ systemPrompt }) => ({
        finalText: 'ok',
        totalTurns: systemPrompt?.includes('CANDIDATE_ENGINEERING_RULE') ? 1 : 2,
        totalTokens: 50,
        terminated: false,
        observations: [],
      }),
    });

    assert.equal(promoted.evaluation.verdict, 'PASS');
    assert.equal(promoted.candidate?.status, 'APPROVED');
    assert.equal(promoted.authority?.status, 'PROPOSED');
    const projection = db.prepare(
      `SELECT authority_experience_id, authority_rule_id, authority_status FROM evolution_candidates WHERE id = ?`,
    ).get(candidate.id) as { authority_experience_id: string; authority_rule_id: string; authority_status: string };
    assert.deepEqual(projection, {
      authority_experience_id: 'exp-remote-1',
      authority_rule_id: 'rule-remote-1',
      authority_status: 'PROPOSED',
    });

    const activated = await orchestrator.activateApprovedCandidate(candidate.id);
    assert.equal(activated.candidate.status, 'ACTIVE');
    assert.equal(activated.authority?.status, 'ACTIVE');
    assert.deepEqual(authority.activated, ['rule-remote-1']);
  });

  it('pauses the remote rule before quarantining an active local candidate', async () => {
    const db = setup();
    const lifecycle = new EvolutionLifecycle(db);
    const candidate = lifecycle.createCandidate({
      experienceId: 'EXP-AUTHORITY-2', contentPath: candidateFile(), sourceFingerprint: 'authority-fingerprint-2',
    });
    lifecycle.transition(candidate.id, 'VALIDATING');
    lifecycle.transition(candidate.id, 'APPROVED');
    lifecycle.activate(candidate.id);
    db.prepare(
      `UPDATE evolution_candidates
       SET authority_experience_id = 'exp-2', authority_rule_id = 'rule-2', authority_status = 'ACTIVE'
       WHERE id = ?`,
    ).run(candidate.id);
    const authority = new FakeAuthority();
    const orchestrator = new EvolutionOrchestrator(db, authority);
    const quarantined = await orchestrator.quarantineCandidate(candidate.id, 'regression detected');
    assert.equal(quarantined.status, 'QUARANTINED');
    assert.deepEqual(authority.paused, ['rule-2']);
  });
});
