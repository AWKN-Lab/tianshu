import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentOsMigrations } from './agent-os-migration-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 解析 DB 路径：每次调用时读取 AWKN_DB_PATH 环境变量
 *
 * 设计原因（E98）：原版在模块加载时读取 process.env.AWKN_DB_PATH，
 *   但 ESM import 在模块自身代码之前执行，导致测试文件在 import 之后
 *   设置 process.env.AWKN_DB_PATH 不生效（DEFAULT_DB_PATH 已被冻结）。
 *   修复：在 getDb() 调用时读取环境变量，而非模块加载时。
 */
function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  return process.env.AWKN_DB_PATH ?? resolve(__dirname, '..', '..', 'data', 'awkn-engine.db');
}

let dbInstance: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (dbInstance) return dbInstance;
  const resolvedPath = resolveDbPath(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  dbInstance = new Database(resolvedPath);
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
