import type Database from 'better-sqlite3';
import { runMigrations as runLegacyMigrationsV1To7 } from './migrations.js';

interface RegisteredMigration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

const MIGRATIONS_V8_TO_V10: readonly RegisteredMigration[] = [
  {
    version: 8,
    name: 'operational-evolution-loop',
    up(db) {
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
    },
  },
  {
    version: 9,
    name: 'historical-replay-success-target',
    up(db) {
      db.exec(`
        UPDATE evolution_replay_cases
        SET expected_json = json_set(
          expected_json,
          '$.success', json('true'),
          '$.baselineStatus', COALESCE(json_extract(tags_json, '$[2]'), 'unknown')
        )
        WHERE source_run_id IS NOT NULL;

        CREATE TRIGGER IF NOT EXISTS trg_evolution_historical_success_target
        AFTER INSERT ON evolution_replay_cases
        WHEN NEW.source_run_id IS NOT NULL
        BEGIN
          UPDATE evolution_replay_cases
          SET expected_json = json_set(
            expected_json,
            '$.success', json('true'),
            '$.baselineStatus', COALESCE(json_extract(NEW.tags_json, '$[2]'), 'unknown')
          )
          WHERE id = NEW.id;
        END;
      `);
    },
  },
  {
    version: 10,
    name: 'memory-os-authority-projection',
    up(db) {
      if (!hasColumn(db, 'evolution_candidates', 'authority_experience_id')) {
        db.exec('ALTER TABLE evolution_candidates ADD COLUMN authority_experience_id TEXT');
      }
      if (!hasColumn(db, 'evolution_candidates', 'authority_rule_id')) {
        db.exec('ALTER TABLE evolution_candidates ADD COLUMN authority_rule_id TEXT');
      }
      if (!hasColumn(db, 'evolution_candidates', 'authority_status')) {
        db.exec('ALTER TABLE evolution_candidates ADD COLUMN authority_status TEXT');
      }
      if (!hasColumn(db, 'evolution_candidates', 'authority_synced_at')) {
        db.exec('ALTER TABLE evolution_candidates ADD COLUMN authority_synced_at TEXT');
      }
      if (!hasColumn(db, 'evolution_candidates', 'authority_error')) {
        db.exec('ALTER TABLE evolution_candidates ADD COLUMN authority_error TEXT');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_authority_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_authority_outbox_pending
          ON memory_authority_outbox(status, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_evolution_authority_rule
          ON evolution_candidates(authority_rule_id);
        CREATE TRIGGER IF NOT EXISTS trg_runs_memory_authority_terminal
        AFTER UPDATE OF status ON runs
        WHEN NEW.status IN ('succeeded', 'failed', 'cancelled', 'budget_exceeded', 'policy_blocked')
         AND OLD.status <> NEW.status
        BEGIN
          INSERT OR IGNORE INTO memory_authority_outbox(
            event_type, aggregate_id, idempotency_key, payload_json, status, attempts,
            created_at, updated_at
          ) VALUES(
            'run.terminal', NEW.id, 'run:' || NEW.id || ':terminal:' || NEW.status,
            json_object('runId', NEW.id, 'status', NEW.status, 'traceId', NEW.trace_id),
            'pending', 0, NEW.updated_at, NEW.updated_at
          );
        END;
      `);
    },
  },
] as const;

function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function runRegisteredMigrationsV8ToV10(
  db: Database.Database,
  maximumVersion = 10,
): void {
  ensureMigrationTable(db);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all()
      .map((row) => (row as { version: number }).version),
  );

  for (const migration of MIGRATIONS_V8_TO_V10) {
    if (migration.version > maximumVersion || applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    });
    apply();
    applied.add(migration.version);
  }
}

export function runAllMigrations(db: Database.Database): void {
  runLegacyMigrationsV1To7(db);
  runRegisteredMigrationsV8ToV10(db);
}
