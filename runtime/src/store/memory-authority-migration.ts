import type Database from 'better-sqlite3';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((entry) => entry.name === column);
}

export function runMemoryAuthorityMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 10').get() as { version: number } | undefined;
  if (applied) return;

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
    db.exec('CREATE INDEX IF NOT EXISTS idx_evolution_authority_rule ON evolution_candidates(authority_rule_id)');
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (10, ?, ?)')
      .run('memory-os-authority-projection', new Date().toISOString());
  });
  migrate();
}
