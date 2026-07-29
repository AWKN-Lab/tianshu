import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentOsMigrations } from './agent-os-migration-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let dbInstance: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (dbInstance) return dbInstance;
  // Read AWKN_DB_PATH at call time (not import time) so tests can set it
  // after importing the module. ESM imports are hoisted before module body,
  // so a module-level const would miss the env var set by test files.
  const resolvedPath = dbPath ?? process.env.AWKN_DB_PATH ?? resolve(__dirname, '..', '..', 'data', 'awkn-engine.db');
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    runAgentOsMigrations(db);
  } catch (err) {
    // Migration failed and (if file DB) auto-restored from backup.
    // The db handle is now closed — must not cache it.
    // Reset dbInstance to null so next getDb() call re-opens from restored file.
    dbInstance = null;
    throw err;
  }
  dbInstance = db;
  return dbInstance;
}

export function closeDb(): void {
  if (!dbInstance) return;
  dbInstance.close();
  dbInstance = null;
}

export function queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function queryRun(sql: string, params: unknown[] = []): number {
  return getDb().prepare(sql).run(...params).changes;
}

export function lastInsertRowid(): number {
  return queryOne<{ id: number }>('SELECT last_insert_rowid() as id')?.id ?? 0;
}

export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
