import type Database from 'better-sqlite3';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

export function runOperationalEvolutionMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 8').get() as { version: number } | undefined;
  if (applied) return;
  const migrate = db.transaction(() => {
    if (!hasColumn(db, 'evolution_candidates', 'source_fingerprint')) {
      db.exec('ALTER TABLE evolution_candidates ADD COLUMN source_fingerprint TEXT');
    }
    if (!hasColumn(db, 'evolution_replay_cases', 'source_run_id')) {
      db.exec('ALTER TABLE evolution_replay_cases ADD COLUMN source_run_id TEXT');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS evolution_candidate_corrections (
        candidate_id TEXT NOT NULL,
        correction_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (candidate_id, correction_id),
        FOREIGN KEY (candidate_id) REFERENCES evolution_candidates(id),
        FOREIGN KEY (correction_id) REFERENCES corrections_ledger(id)
      );
      CREATE TABLE IF NOT EXISTS evolution_replay_runs (
        id TEXT PRIMARY KEY,
        candidate_id TEXT,
        replay_case_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        error_text TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES evolution_candidates(id),
        FOREIGN KEY (replay_case_id) REFERENCES evolution_replay_cases(id)
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_candidate_fingerprint
        ON evolution_candidates(source_fingerprint, status);
      CREATE INDEX IF NOT EXISTS idx_evolution_candidate_corrections_candidate
        ON evolution_candidate_corrections(candidate_id);
      CREATE INDEX IF NOT EXISTS idx_evolution_replay_runs_candidate
        ON evolution_replay_runs(candidate_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_replay_source_run
        ON evolution_replay_cases(source_run_id) WHERE source_run_id IS NOT NULL;
    `);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (8, ?, ?)')
      .run('operational-evolution-loop', new Date().toISOString());
  });
  migrate();
}
