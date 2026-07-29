import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDb, getDb, queryRun } from '../src/store/db.js';
import { getCorrectionsLedger } from '../src/evolve/corrections-ledger.js';
import { PatternDetector } from '../src/evolve/pattern-detector.js';
import {
  patternToMarkdown,
  resolveExperienceId,
  stopExperienceExtractHook,
  writeAllExperiences,
  writeExperience,
} from '../src/evolve/experience-writer.js';

const TEST_DB_PATH = resolve(process.cwd(), 'data', `test-pattern-${process.pid}.db`);
const TEST_DERIVED_DIR = resolve(process.cwd(), 'data', `test-derived-${process.pid}`);

beforeEach(() => {
  closeDb();
  for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    try { rmSync(path); } catch { /* ignore */ }
  }
  getDb(TEST_DB_PATH);
  process.env.AWKN_DERIVED_DIR = TEST_DERIVED_DIR;
  rmSync(TEST_DERIVED_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DERIVED_DIR, { recursive: true });
});

afterEach(() => {
  try { queryRun('DELETE FROM corrections_ledger'); } catch { /* ignore */ }
  closeDb();
  delete process.env.AWKN_DERIVED_DIR;
  rmSync(TEST_DERIVED_DIR, { recursive: true, force: true });
});

describe('PatternDetector repeated fingerprint', () => {
  it('detects three open records with one normalized fingerprint', () => {
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'Failed at 2026-07-23T10:00:00Z in D:\\proj\\a.ts' });
    ledger.record({ source: 'reviewGate', errorText: 'Failed at 2026-07-23T11:00:00Z in D:\\other\\a.ts' });
    ledger.record({ source: 'reviewGate', errorText: 'Failed at 2026-07-23T12:00:00Z in D:\\var\\a.ts' });
    const patterns = new PatternDetector().detectRepeatedFingerprints();
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0]!.count, 3);
    assert.equal(patterns[0]!.kind, 'repeated_fingerprint');
  });

  it('excludes resolved records from clustering', () => {
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'reviewGate', errorText: 'same error' });
    const resolved = ledger.record({ source: 'reviewGate', errorText: 'same error' });
    ledger.record({ source: 'reviewGate', errorText: 'same error' });
    ledger.resolve(resolved.id, 'fixed');
    assert.equal(new PatternDetector().detectRepeatedFingerprints().length, 0);
  });
});

describe('PatternDetector source burst and goal repeat', () => {
  it('detects source bursts', () => {
    const ledger = getCorrectionsLedger();
    for (let index = 0; index < 5; index++) ledger.record({ source: 'testGate', errorText: `unique-${index}` });
    const patterns = new PatternDetector().detectSourceBursts();
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0]!.kind, 'source_burst');
  });

  it('detects repeats inside one goal and keeps goals isolated', () => {
    const ledger = getCorrectionsLedger();
    ledger.record({ source: 'testGate', errorText: 'goal error', goalId: 'goal-a' });
    ledger.record({ source: 'testGate', errorText: 'goal error', goalId: 'goal-a' });
    ledger.record({ source: 'testGate', errorText: 'goal error', goalId: 'goal-b' });
    const patterns = new PatternDetector().detectGoalRepeats();
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0]!.goalId, 'goal-a');
  });

  it('returns all detected kinds from detect()', () => {
    const ledger = getCorrectionsLedger();
    for (let index = 0; index < 3; index++) ledger.record({ source: 'reviewGate', errorText: 'fingerprint error' });
    for (let index = 0; index < 5; index++) ledger.record({ source: 'lintGate', errorText: `burst-${index}` });
    ledger.record({ source: 'testGate', errorText: 'goal error', goalId: 'goal-x' });
    ledger.record({ source: 'testGate', errorText: 'goal error', goalId: 'goal-x' });
    const kinds = new Set(new PatternDetector().detect().map((pattern) => pattern.kind));
    assert.ok(kinds.has('repeated_fingerprint'));
    assert.ok(kinds.has('source_burst'));
    assert.ok(kinds.has('goal_repeat'));
  });
});

describe('experience candidate generation', () => {
  it('generates deterministic experience IDs from an empty directory', () => {
    assert.match(resolveExperienceId('EXP-DRV-20260723-999'), /^EXP-DRV-20260723-001$/);
    assert.match(resolveExperienceId('invalid'), /^EXP-DRV-\d{8}-001$/);
  });

  it('creates Markdown with evidence and replay governance', () => {
    const markdown = patternToMarkdown({
      kind: 'repeated_fingerprint',
      source: 'reviewGate',
      fingerprint: 'abc123def456ghi7',
      count: 3,
      firstTs: '2026-07-23T10:00:00Z',
      lastTs: '2026-07-23T11:00:00Z',
      latestError: 'review verdict missing',
      sampleIds: ['id-1', 'id-2', 'id-3'],
      suggestedExperienceId: 'EXP-DRV-20260723-001',
    }, 'EXP-DRV-20260723-001');
    assert.match(markdown, /待人工补充/);
    assert.match(markdown, /baseline\/candidate 回放比较/);
    assert.match(markdown, /id-1/);
    assert.match(markdown, /review verdict missing/);
    assert.match(markdown, /DRAFT/);
  });

  it('creates one DRAFT candidate, resolves corrections by fingerprint and reuses the fingerprint', () => {
    const ledger = getCorrectionsLedger();
    for (let index = 0; index < 3; index++) ledger.record({ source: 'reviewGate', errorText: 'auto-extract error' });
    const pattern = new PatternDetector().detectRepeatedFingerprints()[0]!;
    const first = writeExperience(pattern);
    const second = writeExperience(pattern);

    assert.ok(existsSync(first.filePath));
    assert.match(readFileSync(first.filePath, 'utf-8'), /DRAFT/);
    assert.equal(first.resolvedCorrections, 3);
    assert.equal(first.reusedCandidate, false);
    assert.equal(second.reusedCandidate, true);
    assert.equal(second.candidateId, first.candidateId);
    assert.equal(second.experienceId, first.experienceId);
    assert.equal(ledger.list({ status: 'open' }).length, 0);
  });

  it('writes distinct candidates for distinct fingerprints', () => {
    const ledger = getCorrectionsLedger();
    for (let index = 0; index < 3; index++) ledger.record({ source: 'reviewGate', errorText: 'pattern-a' });
    for (let index = 0; index < 3; index++) ledger.record({ source: 'testGate', errorText: 'pattern-b' });
    const results = writeAllExperiences(new PatternDetector().detectRepeatedFingerprints());
    assert.equal(results.length, 2);
    assert.notEqual(results[0]!.candidateId, results[1]!.candidateId);
  });

  it('stop hook returns candidate evidence', async () => {
    const ledger = getCorrectionsLedger();
    for (let index = 0; index < 3; index++) ledger.record({ source: 'reviewGate', errorText: 'hook error' });
    const result = await stopExperienceExtractHook();
    assert.equal(result.success, true);
    assert.match(result.output, /candidate=/);
  });
});
