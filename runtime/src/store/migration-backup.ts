import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, renameSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface MigrationBackup {
  readonly backupPath: string;
  readonly originalPath: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly pendingMigrations: readonly number[];
}

export class MigrationBackupError extends Error {
  constructor(readonly code: 'BACKUP_FAILED' | 'RESTORE_FAILED' | 'HASH_MISMATCH' | 'BACKUP_NOT_FOUND', message: string) {
    super(message);
    this.name = 'MigrationBackupError';
  }
}

/**
 * Retries a synchronous file read on Windows transient lock errors (EBUSY/EACCES).
 *
 * Windows may briefly hold a file handle after `copyFileSync` completes, causing
 * the immediate `readFileSync` to fail with EBUSY. This is a known filesystem
 * race that does not indicate data corruption. We retry a bounded number of
 * times with backoff before surfacing the error.
 *
 * Only EBUSY/EACCES are retried — other errno codes (ENOENT, EISDIR, etc.)
 * propagate immediately so real errors are not masked.
 */
function readFileWithTransientLockRetry(filePath: string): Buffer {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 50;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return readFileSync(filePath);
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err.code !== 'EBUSY' && err.code !== 'EACCES') {
        throw cause;
      }
      lastError = cause;
      // Synchronous sleep via Atomics.wait (no event loop, no timer cleanup).
      // Only sleep between retries, not after the last attempt.
      if (attempt < MAX_RETRIES - 1) {
        const buf = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(buf, 0, 0, BASE_DELAY_MS * (attempt + 1));
      }
    }
  }
  throw lastError;
}

/**
 * Computes SHA256 hash of a file.
 * Used for backup integrity verification before and after restore.
 */
export function computeFileHash(filePath: string): string {
  const content = readFileWithTransientLockRetry(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Creates a backup of the database file before running migrations.
 *
 * Steps:
 * 1. Checkpoint WAL to flush all writes to the main database file
 * 2. Copy the database file to a timestamped backup location
 * 3. Compute SHA256 hash of the backup for integrity verification
 *
 * The backup is stored alongside the original database with a
 * `.migration-backup-{timestamp}.db` suffix.
 *
 * @param db The open database connection (used for WAL checkpoint)
 * @param dbPath The path to the database file
 * @param pendingMigrations List of migration versions about to be applied
 * @returns MigrationBackup metadata
 */
// Monotonic counter so multiple backups created within the same millisecond
// still get distinct filenames. Without it, rapid successive backups (e.g. a
// test loop or a migration batch) would collide on the same ISO timestamp and
// silently overwrite each other.
let backupSequence = 0;

export function backupBeforeMigration(
  db: Database.Database,
  dbPath: string,
  pendingMigrations: readonly number[],
): MigrationBackup {
  if (!existsSync(dbPath)) {
    throw new MigrationBackupError('BACKUP_FAILED', `database file not found: ${dbPath}`);
  }

  // Checkpoint WAL to ensure all writes are flushed to the main file
  db.pragma('wal_checkpoint(TRUNCATE)');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const seq = String(backupSequence++).padStart(4, '0');
  const backupPath = join(
    dirname(dbPath),
    `.migration-backup-${timestamp}-${seq}.db`,
  );

  try {
    copyFileSync(dbPath, backupPath);
  } catch (cause) {
    throw new MigrationBackupError(
      'BACKUP_FAILED',
      `failed to copy database to backup: ${backupPath} — ${(cause as Error).message}`,
    );
  }

  const contentHash = computeFileHash(backupPath);
  const createdAt = new Date().toISOString();

  // Write hash alongside backup for tamper detection
  const hashPath = `${backupPath}.sha256`;
  const hashContent = `${contentHash}  ${backupPath}\n`;
  writeFileSync(hashPath, hashContent, 'utf8');

  return { backupPath, originalPath: dbPath, contentHash, createdAt, pendingMigrations };
}

/**
 * Restores a database file from a backup.
 *
 * Steps:
 * 1. Verify backup file exists
 * 2. Recompute hash and verify against expected hash (tamper detection)
 * 3. Close any open connections to the target (caller's responsibility)
 * 4. Move current database aside (for forensic analysis)
 * 5. Copy backup to original location
 * 6. Verify restored file hash matches backup hash
 *
 * @param backup The backup metadata (path + expected hash)
 * @returns Path to the displaced original (for forensic analysis)
 */
export function restoreFromBackup(backup: MigrationBackup): string {
  const { backupPath, originalPath, contentHash: expectedHash } = backup;

  if (!existsSync(backupPath)) {
    throw new MigrationBackupError('BACKUP_NOT_FOUND', `backup file not found: ${backupPath}`);
  }

  // Verify backup integrity before restore
  const actualHash = computeFileHash(backupPath);
  if (actualHash !== expectedHash) {
    throw new MigrationBackupError(
      'HASH_MISMATCH',
      `backup hash mismatch: expected ${expectedHash}, got ${actualHash} — backup may be corrupted or tampered`,
    );
  }

  // Move current database aside if it exists
  const displacedPath = `${originalPath}.displaced-${Date.now()}`;
  if (existsSync(originalPath)) {
    renameSync(originalPath, displacedPath);
  }

  try {
    copyFileSync(backupPath, originalPath);
  } catch (cause) {
    // Attempt to restore the displaced file
    if (existsSync(displacedPath)) {
      renameSync(displacedPath, originalPath);
    }
    throw new MigrationBackupError(
      'RESTORE_FAILED',
      `failed to copy backup to original location: ${(cause as Error).message}`,
    );
  }

  // Verify restored file hash
  const restoredHash = computeFileHash(originalPath);
  if (restoredHash !== expectedHash) {
    throw new MigrationBackupError(
      'HASH_MISMATCH',
      `restored file hash mismatch: expected ${expectedHash}, got ${restoredHash}`,
    );
  }

  return displacedPath;
}

/**
 * Lists migration backup files in a directory.
 * Returns backups sorted by creation time (newest first).
 *
 * Sorting uses the filename timestamp (ISO format, lexicographically sortable)
 * rather than stat.mtime, because Windows mtime precision may be insufficient
 * to distinguish backups created within the same millisecond.
 */
export function listMigrationBackups(dbPath: string): MigrationBackup[] {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) return [];

  const backups: MigrationBackup[] = [];

  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('.migration-backup-') || !entry.endsWith('.db')) continue;
    const backupPath = join(dir, entry);
    // Tolerate ENOENT from concurrent test workers that may delete backups
    // between readdirSync and statSync/computeFileHash. Skip missing files
    // instead of throwing — they will simply not appear in the list.
    try {
      const stat = statSync(backupPath);
      const contentHash = computeFileHash(backupPath);
      const createdAt = stat.mtime.toISOString();

      backups.push({
        backupPath,
        originalPath: dbPath,
        contentHash,
        createdAt,
        pendingMigrations: [],
      });
    } catch {
      // backup file was deleted between readdirSync and statSync/computeFileHash
      // (concurrent test worker cleanup race); skip it
    }
  }

  // Sort by backupPath descending — the filename contains an ISO timestamp
  // (e.g., .migration-backup-2026-07-27T18-14-10-344Z.db) which is
  // lexicographically sortable and gives chronological order.
  // Use code point comparison instead of localeCompare() to ensure
  // cross-platform determinism (localeCompare may differ on Linux).
  return backups.sort((a, b) =>
    a.backupPath > b.backupPath ? -1 : a.backupPath < b.backupPath ? 1 : 0,
  );
}

/**
 * Cleans up old migration backups, keeping only the most recent N.
 * Returns the count of removed backups.
 */
export function cleanupOldBackups(dbPath: string, keepCount = 5): number {
  const backups = listMigrationBackups(dbPath);
  let removed = 0;
  for (const backup of backups.slice(keepCount)) {
    try {
      unlinkSync(backup.backupPath);
      const hashPath = `${backup.backupPath}.sha256`;
      if (existsSync(hashPath)) unlinkSync(hashPath);
      removed++;
    } catch {
      // ignore individual cleanup failures
    }
  }
  return removed;
}
