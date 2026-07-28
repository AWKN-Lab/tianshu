import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { getMemoryService } from '../memory/service.js';
import { getDb } from '../store/db.js';
import { runOperationalEvolutionMigration } from '../store/operational-evolution-migration.js';

export type EvolutionStatus = 'DRAFT' | 'VALIDATING' | 'APPROVED' | 'ACTIVE' | 'QUARANTINED' | 'RETIRED';

export interface EvolutionCandidate {
  id: string;
  experience_id: string;
  version: number;
  status: EvolutionStatus;
  content_path: string;
  content_hash: string;
  source_pattern_json: string;
  source_fingerprint: string | null;
  baseline_metrics_json: string | null;
  candidate_metrics_json: string | null;
  evaluation_json: string | null;
  quarantine_reason: string | null;
  promoted_at: string | null;
  created_at: string;
  updated_at: string;
}

const ALLOWED: Record<EvolutionStatus, EvolutionStatus[]> = {
  DRAFT: ['VALIDATING', 'RETIRED'],
  VALIDATING: ['APPROVED', 'QUARANTINED'],
  APPROVED: ['ACTIVE', 'QUARANTINED', 'RETIRED'],
  ACTIVE: ['QUARANTINED', 'RETIRED'],
  QUARANTINED: ['VALIDATING', 'RETIRED'],
  RETIRED: [],
};

export function sha256Content(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function projectId(): string {
  return process.env.AWKN_PROJECT_ID ?? process.env.npm_package_name ?? 'default-project';
}

export class EvolutionLifecycle {
  constructor(private readonly db: Database.Database = getDb()) {
    runOperationalEvolutionMigration(db);
  }

  createCandidate(input: {
    experienceId: string;
    contentPath: string;
    contentHash?: string;
    sourcePattern?: Record<string, unknown>;
    sourceFingerprint?: string;
    correctionIds?: string[];
  }): EvolutionCandidate {
    if (input.sourceFingerprint) {
      const existing = this.findInFlightByFingerprint(input.sourceFingerprint);
      if (existing) {
        this.linkCorrections(existing.id, input.correctionIds ?? []);
        return existing;
      }
    }
    const contentHash = input.contentHash ?? sha256Content(readFileSync(input.contentPath, 'utf-8'));
    const current = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM evolution_candidates WHERE experience_id = ?')
      .get(input.experienceId) as { version: number };
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO evolution_candidates
       (id, experience_id, version, status, content_path, content_hash, source_pattern_json,
        source_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.experienceId, current.version + 1, input.contentPath, contentHash,
      JSON.stringify(input.sourcePattern ?? {}), input.sourceFingerprint ?? null, now, now);
    this.linkCorrections(id, input.correctionIds ?? []);
    return this.read(id)!;
  }

  read(id: string): EvolutionCandidate | null {
    return (this.db.prepare('SELECT * FROM evolution_candidates WHERE id = ?').get(id) as EvolutionCandidate | undefined) ?? null;
  }

  list(status?: EvolutionStatus): EvolutionCandidate[] {
    return (status
      ? this.db.prepare('SELECT * FROM evolution_candidates WHERE status = ? ORDER BY created_at DESC, rowid DESC').all(status)
      : this.db.prepare('SELECT * FROM evolution_candidates ORDER BY created_at DESC, rowid DESC').all()) as EvolutionCandidate[];
  }

  findInFlightByFingerprint(fingerprint: string): EvolutionCandidate | null {
    return (this.db.prepare(
      `SELECT * FROM evolution_candidates
       WHERE source_fingerprint = ? AND status IN ('DRAFT', 'VALIDATING', 'APPROVED', 'ACTIVE')
       ORDER BY version DESC LIMIT 1`,
    ).get(fingerprint) as EvolutionCandidate | undefined) ?? null;
  }

  linkCorrections(candidateId: string, correctionIds: string[]): number {
    if (correctionIds.length === 0) return 0;
    // Filter out correction IDs that don't exist in corrections_ledger (FK constraint safety)
    const placeholders = correctionIds.map(() => '?').join(',');
    const existingIds = this.db.prepare(
      `SELECT id FROM corrections_ledger WHERE id IN (${placeholders})`,
    ).all(...correctionIds) as Array<{ id: string }>;
    const existingSet = new Set(existingIds.map((r) => r.id));
    const validIds = correctionIds.filter((id) => existingSet.has(id));
    if (validIds.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO evolution_candidate_corrections
       (candidate_id, correction_id, created_at) VALUES (?, ?, ?)`,
    );
    return this.db.transaction(() => validIds.reduce((count, correctionId) =>
      count + insert.run(candidateId, correctionId, new Date().toISOString()).changes, 0))();
  }

  listCorrectionIds(candidateId: string): string[] {
    return (this.db.prepare('SELECT correction_id FROM evolution_candidate_corrections WHERE candidate_id = ? ORDER BY created_at ASC')
      .all(candidateId) as Array<{ correction_id: string }>).map((row) => row.correction_id);
  }

  transition(id: string, next: EvolutionStatus, reason?: string): EvolutionCandidate {
    const candidate = this.read(id);
    if (!candidate) throw new Error(`candidate ${id} not found`);
    if (!ALLOWED[candidate.status].includes(next)) throw new Error(`invalid transition ${candidate.status} -> ${next}`);
    this.db.prepare('UPDATE evolution_candidates SET status = ?, quarantine_reason = ?, updated_at = ? WHERE id = ?')
      .run(next, next === 'QUARANTINED' ? reason ?? 'evaluation failed' : null, new Date().toISOString(), id);
    const updated = this.read(id)!;
    if (candidate.status === 'ACTIVE' && next === 'QUARANTINED') this.invalidateActiveMemory(candidate, reason ?? 'evaluation failed');
    return updated;
  }

  saveEvaluation(id: string, input: { baselineMetrics: Record<string, unknown>; candidateMetrics: Record<string, unknown>; evaluation: Record<string, unknown> }): EvolutionCandidate {
    this.db.prepare(
      `UPDATE evolution_candidates SET baseline_metrics_json = ?, candidate_metrics_json = ?, evaluation_json = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(input.baselineMetrics), JSON.stringify(input.candidateMetrics), JSON.stringify(input.evaluation), new Date().toISOString(), id);
    return this.read(id)!;
  }

  activate(id: string): EvolutionCandidate {
    const candidate = this.read(id);
    if (!candidate) throw new Error(`candidate ${id} not found`);
    if (candidate.status !== 'APPROVED') throw new Error(`candidate ${id} must be APPROVED before activation`);
    this.db.transaction(() => {
      const current = this.db.prepare(`SELECT * FROM evolution_candidates WHERE experience_id = ? AND status = 'ACTIVE' LIMIT 1`)
        .get(candidate.experience_id) as EvolutionCandidate | undefined;
      const now = new Date().toISOString();
      if (current) this.db.prepare(`UPDATE evolution_candidates SET status = 'RETIRED', updated_at = ? WHERE id = ?`).run(now, current.id);
      this.db.prepare(`UPDATE evolution_candidates SET status = 'ACTIVE', promoted_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
      this.db.prepare(
        `INSERT INTO evolution_activation_history (id, experience_id, from_candidate_id, to_candidate_id, action, created_at)
         VALUES (?, ?, ?, ?, 'activate', ?)`,
      ).run(randomUUID(), candidate.experience_id, current?.id ?? null, id, now);
    })();
    const active = this.read(id)!;
    this.publishEngineeringMemory(active, 'activate');
    this.resolveCandidateCorrections(active);
    return active;
  }

  rollback(experienceId: string): EvolutionCandidate {
    const current = this.db.prepare(`SELECT * FROM evolution_candidates WHERE experience_id = ? AND status = 'ACTIVE' LIMIT 1`)
      .get(experienceId) as EvolutionCandidate | undefined;
    if (!current) throw new Error(`no ACTIVE candidate for ${experienceId}`);
    const history = this.db.prepare(
      `SELECT from_candidate_id FROM evolution_activation_history
       WHERE experience_id = ? AND to_candidate_id = ? AND from_candidate_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    ).get(experienceId, current.id) as { from_candidate_id: string } | undefined;
    if (!history) throw new Error(`no rollback target for ${experienceId}`);
    const previous = this.read(history.from_candidate_id);
    if (!previous) throw new Error(`rollback target ${history.from_candidate_id} missing`);
    this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE evolution_candidates SET status = 'QUARANTINED', quarantine_reason = 'rolled back', updated_at = ? WHERE id = ?`).run(now, current.id);
      this.db.prepare(`UPDATE evolution_candidates SET status = 'ACTIVE', quarantine_reason = NULL, promoted_at = ?, updated_at = ? WHERE id = ?`).run(now, now, previous.id);
      this.db.prepare(
        `INSERT INTO evolution_activation_history (id, experience_id, from_candidate_id, to_candidate_id, action, created_at)
         VALUES (?, ?, ?, ?, 'rollback', ?)`,
      ).run(randomUUID(), experienceId, current.id, previous.id, now);
    })();
    this.invalidateActiveMemory(current, 'rolled back');
    const restored = this.read(previous.id)!;
    this.publishEngineeringMemory(restored, 'rollback');
    return restored;
  }

  private resolveCandidateCorrections(candidate: EvolutionCandidate): void {
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `UPDATE corrections_ledger SET status = 'resolved', resolution = ?, experience_id = ?, updated_at = ?
       WHERE id = ? AND status = 'open'`,
    );
    this.db.transaction(() => {
      for (const correctionId of this.listCorrectionIds(candidate.id)) {
        update.run(`candidate ${candidate.id} activated`, candidate.experience_id, now, correctionId);
      }
    })();
  }

  private publishEngineeringMemory(candidate: EvolutionCandidate, action: 'activate' | 'rollback'): void {
    try {
      getMemoryService().put({
        type: 'engineering_experience', scopeId: projectId(), key: candidate.experience_id,
        content: readFileSync(candidate.content_path, 'utf-8'), importance: 0.95, confidence: 0.95,
        metadata: { candidateId: candidate.id, candidateVersion: candidate.version, sourceFingerprint: candidate.source_fingerprint, action },
      });
    } catch { /* optional projection */ }
  }

  private invalidateActiveMemory(candidate: EvolutionCandidate, reason: string): void {
    try {
      const memory = getMemoryService().getLatest('engineering_experience', projectId(), candidate.experience_id);
      if (memory) getMemoryService().invalidate(memory.id, reason);
    } catch { /* quarantine remains authoritative */ }
  }
}
