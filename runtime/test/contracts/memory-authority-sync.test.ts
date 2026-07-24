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

function approve(lifecycle: EvolutionLifecycle, candidateId: string): void {
  lifecycle.transition(candidateId, 'VALIDATING');
  lifecycle.transition(candidateId, 'APPROVED');
}

function setAuthority(
  db: Database.Database,
  candidateId: string,
  experienceId: string,
  ruleId: string,
  status: string,
): void {
  db.prepare(
    `UPDATE evolution_candidates
     SET authority_experience_id = ?, authority_rule_id = ?, authority_status = ? WHERE id = ?`,
  ).run(experienceId, ruleId, status, candidateId);
}

class FakeAuthority implements EvolutionAuthorityGateway {
  readonly governed: GovernCandidateInput[] = [];
  readonly activated: string[] = [];
  readonly paused: string[] = [];
  readonly operations: string[] = [];
  failActivationFor?: string;

  isRemoteAuthorityEnabled(): boolean { return true; }

  async governCandidate(input: GovernCandidateInput): Promise<GovernCandidateResult> {
    this.governed.push(input);
    this.operations.push(`govern:${input.candidateId}`);
    return { experienceId: 'exp-remote-1', ruleId: 'rule-remote-1', status: 'PROPOSED' };
  }

  async activateAuthorityRule(ruleId: string): Promise<Record<string, unknown>> {
    this.operations.push(`activate:${ruleId}`);
    if (this.failActivationFor === ruleId) throw new Error(`activation failed: ${ruleId}`);
    this.activated.push(ruleId);
    return { activation_id: `activation-${ruleId}`, status: 'ACTIVE' };
  }

  async pauseAuthorityRule(ruleId: string, _reason: string): Promise<Record<string, unknown>> {
    this.operations.push(`pause:${ruleId}`);
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

  it('pauses the previous remote rule before activating a replacement version', async () => {
    const db = setup();
    const lifecycle = new EvolutionLifecycle(db);
    const first = lifecycle.createCandidate({ experienceId: 'EXP-SINGLE', contentPath: candidateFile('rule v1') });
    approve(lifecycle, first.id);
    lifecycle.activate(first.id);
    setAuthority(db, first.id, 'exp-old', 'rule-old', 'ACTIVE');

    const second = lifecycle.createCandidate({ experienceId: 'EXP-SINGLE', contentPath: candidateFile('rule v2') });
    approve(lifecycle, second.id);
    setAuthority(db, second.id, 'exp-new', 'rule-new', 'PROPOSED');

    const authority = new FakeAuthority();
    const activated = await new EvolutionOrchestrator(db, authority).activateApprovedCandidate(second.id);
    assert.equal(activated.candidate.status, 'ACTIVE');
    assert.deepEqual(authority.operations, ['pause:rule-old', 'activate:rule-new']);
    assert.equal(lifecycle.read(first.id)?.status, 'RETIRED');
    const rows = db.prepare(
      `SELECT id, authority_status FROM evolution_candidates WHERE id IN (?, ?) ORDER BY id`,
    ).all(first.id, second.id) as Array<{ id: string; authority_status: string }>;
    const statuses = new Map(rows.map((row) => [row.id, row.authority_status]));
    assert.equal(statuses.get(first.id), 'PAUSED');
    assert.equal(statuses.get(second.id), 'ACTIVE');
  });

  it('reactivates the previous remote rule when replacement activation fails', async () => {
    const db = setup();
    const lifecycle = new EvolutionLifecycle(db);
    const first = lifecycle.createCandidate({ experienceId: 'EXP-COMPENSATE', contentPath: candidateFile('rule old') });
    approve(lifecycle, first.id);
    lifecycle.activate(first.id);
    setAuthority(db, first.id, 'exp-old', 'rule-old', 'ACTIVE');

    const second = lifecycle.createCandidate({ experienceId: 'EXP-COMPENSATE', contentPath: candidateFile('rule bad') });
    approve(lifecycle, second.id);
    setAuthority(db, second.id, 'exp-bad', 'rule-bad', 'PROPOSED');

    const authority = new FakeAuthority();
    authority.failActivationFor = 'rule-bad';
    await assert.rejects(
      () => new EvolutionOrchestrator(db, authority).activateApprovedCandidate(second.id),
      /activation failed: rule-bad/,
    );
    assert.deepEqual(authority.operations, ['pause:rule-old', 'activate:rule-bad', 'activate:rule-old']);
    assert.equal(lifecycle.read(first.id)?.status, 'ACTIVE');
    assert.equal(lifecycle.read(second.id)?.status, 'APPROVED');
    const oldStatus = db.prepare('SELECT authority_status FROM evolution_candidates WHERE id = ?').get(first.id) as { authority_status: string };
    assert.equal(oldStatus.authority_status, 'ACTIVE');
  });

  it('pauses the remote rule before quarantining an active local candidate', async () => {
    const db = setup();
    const lifecycle = new EvolutionLifecycle(db);
    const candidate = lifecycle.createCandidate({
      experienceId: 'EXP-AUTHORITY-2', contentPath: candidateFile(), sourceFingerprint: 'authority-fingerprint-2',
    });
    approve(lifecycle, candidate.id);
    lifecycle.activate(candidate.id);
    setAuthority(db, candidate.id, 'exp-2', 'rule-2', 'ACTIVE');
    const authority = new FakeAuthority();
    const orchestrator = new EvolutionOrchestrator(db, authority);
    const quarantined = await orchestrator.quarantineCandidate(candidate.id, 'regression detected');
    assert.equal(quarantined.status, 'QUARANTINED');
    assert.deepEqual(authority.paused, ['rule-2']);
  });
});
