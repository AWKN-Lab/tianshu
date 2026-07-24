import type Database from 'better-sqlite3';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((entry) => entry.name === column);
}

export function runMemoryAuthorityMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 10').get() as { version: number } | undefined;

  const migrate = db.transaction(() => {
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
    if (!applied) {
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (10, ?, ?)')
        .run('memory-os-authority-projection', new Date().toISOString());
    }
  });
  migrate();
}
