import type Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial-runtime-schema', sql: SCHEMA_SQL },
  {
    version: 2,
    name: 'engine-v2-run-event-artifact-model',
    sql: `
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        goal_id TEXT,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL DEFAULT '{}',
        output_json TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        step_type TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        input_json TEXT NOT NULL DEFAULT '{}',
        output_json TEXT,
        error_text TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id),
        FOREIGN KEY (step_id) REFERENCES steps(id)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT,
        artifact_type TEXT NOT NULL,
        path TEXT,
        sha256 TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id),
        FOREIGN KEY (step_id) REFERENCES steps(id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL DEFAULT '{}',
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id),
        FOREIGN KEY (step_id) REFERENCES steps(id)
      );

      CREATE TABLE IF NOT EXISTS model_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        step_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_text TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id),
        FOREIGN KEY (step_id) REFERENCES steps(id)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_goal_id ON runs(goal_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_steps_run_id ON steps(run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_run_key_attempt ON steps(run_id, step_key, attempt);
      CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
      CREATE INDEX IF NOT EXISTS idx_events_step_id ON events(step_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_run_id ON approvals(run_id);
      CREATE INDEX IF NOT EXISTS idx_model_calls_run_id ON model_calls(run_id);
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all()
      .map((row) => (row as { version: number }).version),
  );

  const apply = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.version)) apply(migration);
  }
}
