/**
 * SQLite 数据库封装
 *
 * 基于 better-sqlite3（同步 API，无需 async/await）
 * 单文件存储：runtime/data/awkn-engine.db
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_SQL } from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 修复（2026-07-23）：原版用 process.cwd() + 'runtime/data/'，但 cli.ts 从 runtime/ 跑
// 导致路径变成 runtime/runtime/data/awkn-engine.db（双重 runtime）
// 现改用 __dirname 推算：src/store/db.ts → 上溯 2 级到 runtime/，再加 data/
// 路径覆盖：环境变量 AWKN_DB_PATH 优先（测试用）
const DEFAULT_DB_PATH = process.env.AWKN_DB_PATH
  ?? resolve(__dirname, '..', '..', 'data', 'awkn-engine.db');

let dbInstance: Database.Database | null = null;

export function getDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (dbInstance) return dbInstance;

  mkdirSync(dirname(dbPath), { recursive: true });
  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.exec(SCHEMA_SQL);

  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/** 同步查询多行 */
export function queryAll<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.all(...params) as T[];
}

/** 同步查询单行 */
export function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T | undefined {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.get(...params) as T | undefined;
}

/** 同步执行写操作（INSERT/UPDATE/DELETE），返回影响行数 */
export function queryRun(
  sql: string,
  params: unknown[] = [],
): number {
  const db = getDb();
  const stmt = db.prepare(sql);
  const result = stmt.run(...params);
  return result.changes;
}

/** 获取最近插入的自增 ID */
export function lastInsertRowid(): number {
  const row = queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
  return row?.id ?? 0;
}

/** 事务包裹（同步） */
export function transaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}
