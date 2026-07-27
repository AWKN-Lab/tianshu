import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentOsMigrations } from './agent-os-migration-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_DB_PATH = process.env.AWKN_DB_PATH ?? resolve(__dirname, '..', '..', 'data', 'awkn-engine.db');

let dbInstance: Database.Database | null = null;

export function getDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (dbInstance) return dbInstance;
  mkdirSync(dirname(dbPath), { recursive: true });
  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  runAgentOsMigrations(dbInstance);
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
