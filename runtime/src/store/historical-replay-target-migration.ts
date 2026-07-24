import type Database from 'better-sqlite3';

export function runHistoricalReplayTargetMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 9').get() as { version: number } | undefined;
  if (applied) return;

  const migrate = db.transaction(() => {
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
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (9, ?, ?)')
      .run('historical-replay-success-target', new Date().toISOString());
  });
  migrate();
}
