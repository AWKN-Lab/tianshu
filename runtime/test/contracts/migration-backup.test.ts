import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import Database from 'better-sqlite3';
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  backupBeforeMigration,
  computeFileHash,
  restoreFromBackup,
  listMigrationBackups,
  cleanupOldBackups,
  MigrationBackupError,
} from '../../src/store/migration-backup.js';
import { runAgentOsMigrations, getLastMigrationBackup, resetLastMigrationBackup } from '../../src/store/agent-os-migration-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testDir = resolve(__dirname, '..', 'data', `test-migration-backup-${Date.now()}`);
const testDbPath = join(testDir, 'test-backup.db');

function createTestDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Create schema_migrations table (simulating legacy migrations already applied)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  // Simulate v1-v10 already applied (so only v11/v12 are pending)
  for (let v = 1; v <= 10; v++) {
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
      .run(v, `legacy-${v}`, new Date().toISOString());
  }
  return db;
}

describe('Migration Backup/Restore', () => {
  before(() => {
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    // Reset module-level state for test isolation
    resetLastMigrationBackup();
  });

  describe('backupBeforeMigration', () => {
    it('creates a backup file with correct hash', () => {
      const db = createTestDb(testDbPath);
      db.exec('CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT)');
      db.prepare('INSERT INTO test_data (value) VALUES (?)').run('test-value');

      const backup = backupBeforeMigration(db, testDbPath, [11, 12]);

      assert.equal(existsSync(backup.backupPath), true);
      assert.equal(backup.originalPath, testDbPath);
      assert.equal(backup.contentHash.length, 64);
      assert.deepEqual(backup.pendingMigrations, [11, 12]);

      // Hash should match recomputed hash
      const recomputedHash = computeFileHash(backup.backupPath);
      assert.equal(backup.contentHash, recomputedHash);

      // Hash file should exist alongside
      assert.equal(existsSync(`${backup.backupPath}.sha256`), true);

      db.close();
    });

    it('checkpoints WAL before backup (all writes flushed)', () => {
      const db = createTestDb(testDbPath);
      db.exec('CREATE TABLE wal_test (id INTEGER PRIMARY KEY)');
      // Write many rows to generate WAL
      const insert = db.prepare('INSERT INTO wal_test (id) VALUES (?)');
      const tx = db.transaction(() => {
        for (let i = 0; i < 100; i++) insert.run(i);
      });
      tx();

      const backup = backupBeforeMigration(db, testDbPath, [11]);
      db.close();

      // Backup should contain all 100 rows
      const backupDb = new Database(backup.backupPath, { readonly: true });
      const count = backupDb.prepare('SELECT COUNT(*) as n FROM wal_test').get() as { n: number };
      assert.equal(count.n, 100);
      backupDb.close();
    });

    it('throws BACKUP_FAILED for non-existent database file', () => {
      const db = createTestDb(testDbPath);
      db.close();
      try {
        backupBeforeMigration(db, '/nonexistent/path.db', [11]);
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof MigrationBackupError);
        assert.equal(error.code, 'BACKUP_FAILED');
      }
    });
  });

  describe('restoreFromBackup', () => {
    it('restores database from backup with hash verification', () => {
      const db = createTestDb(testDbPath);
      db.exec('CREATE TABLE restore_test (id INTEGER PRIMARY KEY, data TEXT)');
      db.prepare('INSERT INTO restore_test (data) VALUES (?)').run('original-data');

      const backup = backupBeforeMigration(db, testDbPath, [11]);
      db.close();

      // Simulate corruption: modify the database
      const corruptDb = new Database(testDbPath);
      corruptDb.exec('DROP TABLE restore_test');
      corruptDb.close();

      // Restore
      const displacedPath = restoreFromBackup(backup);
      assert.equal(existsSync(displacedPath), true);

      // Verify restored data
      const restoredDb = new Database(testDbPath, { readonly: true });
      const row = restoredDb.prepare('SELECT data FROM restore_test WHERE id = 1').get() as { data: string };
      assert.equal(row.data, 'original-data');
      restoredDb.close();
    });

    it('throws HASH_MISMATCH when backup is tampered', () => {
      const db = createTestDb(testDbPath);
      db.exec('CREATE TABLE tamper_test (id INTEGER PRIMARY KEY)');
      const backup = backupBeforeMigration(db, testDbPath, [11]);
      db.close();

      // Tamper with backup: append bytes
      appendFileSync(backup.backupPath, Buffer.from('tampered'));

      try {
        restoreFromBackup(backup);
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof MigrationBackupError);
        assert.equal(error.code, 'HASH_MISMATCH');
      }
    });

    it('throws BACKUP_NOT_FOUND for missing backup', () => {
      const fakeBackup = {
        backupPath: '/nonexistent/backup.db',
        originalPath: testDbPath,
        contentHash: '0'.repeat(64),
        createdAt: new Date().toISOString(),
        pendingMigrations: [11],
      };
      try {
        restoreFromBackup(fakeBackup);
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof MigrationBackupError);
        assert.equal(error.code, 'BACKUP_NOT_FOUND');
      }
    });
  });

  describe('Integration with runAgentOsMigrations', () => {
    it('creates backup before applying v11/v12/v13 migrations', () => {
      const integrationDbPath = join(testDir, 'integration-backup.db');
      const db = createTestDb(integrationDbPath);

      runAgentOsMigrations(db);

      const backup = getLastMigrationBackup();
      assert.ok(backup, 'backup should have been created');
      assert.equal(existsSync(backup.backupPath), true);
      assert.deepEqual(backup.pendingMigrations, [11, 12, 13]);
      assert.equal(backup.contentHash.length, 64);

      // Verify migrations were applied
      const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
      const versionList = versions.map((v) => v.version);
      assert.ok(versionList.includes(11));
      assert.ok(versionList.includes(12));
      assert.ok(versionList.includes(13));

      db.close();
    });

    it('does not create backup when no pending migrations', () => {
      const noPendingDbPath = join(testDir, 'no-pending.db');
      const db = createTestDb(noPendingDbPath);

      // Pre-apply v11/v12
      runAgentOsMigrations(db);
      const firstBackup = getLastMigrationBackup();

      // Re-run (no pending)
      runAgentOsMigrations(db);
      const secondBackup = getLastMigrationBackup();

      // Second run should not create new backup
      assert.equal(secondBackup?.backupPath, firstBackup?.backupPath);

      db.close();
    });

    it('skips backup for in-memory databases', () => {
      const memDb = new Database(':memory:');
      memDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (let v = 1; v <= 10; v++) {
        memDb.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
          .run(v, `legacy-${v}`, new Date().toISOString());
      }

      runAgentOsMigrations(memDb);
      const backup = getLastMigrationBackup();
      assert.equal(backup, null, 'in-memory databases should not create backups');

      // But migrations should still apply
      const versions = memDb.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
      const versionList = versions.map((v) => v.version);
      assert.ok(versionList.includes(11));
      assert.ok(versionList.includes(12));

      memDb.close();
    });
  });

  describe('Full backup/restore drill (recovery rehearsal)', () => {
    it('performs complete round-trip: backup → migrate → restore → verify', () => {
      const drillDbPath = join(testDir, 'drill-backup.db');
      const db = createTestDb(drillDbPath);

      // Insert pre-migration data
      db.exec('CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, payload TEXT)');
      db.prepare('INSERT INTO legacy_data (payload) VALUES (?)').run('pre-migration');

      // Step 1: Run migrations (creates backup automatically)
      runAgentOsMigrations(db);
      const backup = getLastMigrationBackup();
      assert.ok(backup);

      // Verify post-migration state
      assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'executions\'').get());

      // Insert post-migration data
      db.prepare('INSERT INTO executions (id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema, input_ref_json, feature_flags_ref_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('exec_test', 'trace_1', 0, '{}', 'test', '{}', 'test', '{}', '{}', 'RECEIVED', new Date().toISOString(), new Date().toISOString());

      db.close();

      // Step 2: Simulate disaster - corrupt the database
      const corruptDb = new Database(drillDbPath);
      corruptDb.exec('DROP TABLE executions');
      corruptDb.exec('DROP TABLE receipts');
      corruptDb.close();

      // Step 3: Restore from backup
      const displacedPath = restoreFromBackup(backup);
      assert.equal(existsSync(displacedPath), true);

      // Step 4: Verify restored state matches pre-migration snapshot
      const restoredDb = new Database(drillDbPath, { readonly: true });

      // Legacy data should be intact
      const legacyRow = restoredDb.prepare('SELECT payload FROM legacy_data WHERE id = 1').get() as { payload: string };
      assert.equal(legacyRow.payload, 'pre-migration');

      // Post-migration tables should NOT exist (backup was pre-migration)
      const executionsTable = restoredDb.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'executions\'').get();
      assert.equal(executionsTable, undefined);

      restoredDb.close();
    });
  });

  describe('listMigrationBackups and cleanup', () => {
    it('lists backups sorted by creation time', () => {
      const listDbPath = join(testDir, 'list-test.db');
      const db1 = createTestDb(listDbPath);
      const backup1 = backupBeforeMigration(db1, listDbPath, [11]);
      db1.close();

      const db2 = new Database(listDbPath);
      const backup2 = backupBeforeMigration(db2, listDbPath, [12]);
      db2.close();

      const backups = listMigrationBackups(listDbPath);
      assert.ok(backups.length >= 2);

      // Newest first
      assert.equal(backups[0].backupPath, backup2.backupPath);
      assert.equal(backups[1].backupPath, backup1.backupPath);
    });

    it('cleanupOldBackups keeps only N most recent', () => {
      const cleanupDbPath = join(testDir, 'cleanup-test.db');
      for (let i = 0; i < 7; i++) {
        const db = createTestDb(cleanupDbPath);
        backupBeforeMigration(db, cleanupDbPath, [11]);
        db.close();
      }

      const before = listMigrationBackups(cleanupDbPath);
      assert.ok(before.length >= 7);

      const removed = cleanupOldBackups(cleanupDbPath, 3);
      assert.equal(removed, before.length - 3);

      const after = listMigrationBackups(cleanupDbPath);
      assert.equal(after.length, 3);
    });
  });
});
