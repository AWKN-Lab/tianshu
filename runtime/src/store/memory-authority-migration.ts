import type Database from 'better-sqlite3';
import { runRegisteredMigrationsV8ToV10 } from './migration-registry-v2.js';

/** @deprecated Use runAllMigrations from migration-registry-v2. */
export function runMemoryAuthorityMigration(db: Database.Database): void {
  runRegisteredMigrationsV8ToV10(db, 10);
}
