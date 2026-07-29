import type Database from 'better-sqlite3';
import { applyClaimLedgerMigrationV12 } from './claim-ledger-migration-v12.js';
import {
  backupBeforeMigration,
  cleanupOldBackups,
  restoreFromBackup,
  type MigrationBackup,
} from './migration-backup.js';
import { runAllMigrations as runLegacyAndCompatibilityMigrations } from './migration-registry-v2.js';

interface AgentOsMigration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

const AGENT_OS_MIGRATIONS: readonly AgentOsMigration[] = [
  {
    version: 11,
    name: 'agent-os-core-execution-receipt-event',
    up(db) {
      db.exec(`
        CREATE TABLE executions (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          actor_json TEXT NOT NULL,
          actor_schema TEXT NOT NULL,
          scope_json TEXT NOT NULL,
          scope_schema TEXT NOT NULL,
          input_ref_json TEXT NOT NULL,
          intent_ref_json TEXT,
          goal_ref_json TEXT,
          context_ref_json TEXT,
          policy_bundle_ref_json TEXT,
          skill_bundle_ref_json TEXT,
          broker_plan_ref_json TEXT,
          run_refs_json TEXT NOT NULL DEFAULT '[]',
          delivery_refs_json TEXT NOT NULL DEFAULT '[]',
          outcome_ref_json TEXT,
          memory_decision_refs_json TEXT NOT NULL DEFAULT '[]',
          evolution_candidate_refs_json TEXT NOT NULL DEFAULT '[]',
          feature_flags_ref_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN (
            'RECEIVED','TRUSTED','ROUTED','CONTEXT_READY','COMPILED','AUTHORIZED',
            'RUNNING','DELIVERING','DELIVERED','OUTCOME_PENDING','OUTCOME_RECORDED',
            'CLOSED','BLOCKED','WAITING_USER','WAITING_AUTHORIZATION','RETRYING',
            'DEGRADED','PARTIAL','FAILED','CANCELLED'
          )),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT,
          UNIQUE(trace_id, id)
        );
        CREATE INDEX idx_executions_trace ON executions(trace_id);
        CREATE INDEX idx_executions_state_updated ON executions(state, updated_at);

        CREATE TABLE execution_snapshots (
          execution_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          snapshot_schema TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          snapshot_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (execution_id, revision),
          FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
        );

        CREATE TABLE receipts (
          id TEXT PRIMARY KEY,
          receipt_type TEXT NOT NULL,
          payload_schema TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          run_id TEXT,
          step_id TEXT,
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          producer_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('SUCCESS','FAILURE','PARTIAL','UNKNOWN')),
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          artifact_refs_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX idx_receipts_payload_dedupe
          ON receipts(receipt_type, aggregate_id, payload_hash);
        CREATE INDEX idx_receipts_execution_type
          ON receipts(execution_id, receipt_type, created_at);
        CREATE INDEX idx_receipts_run ON receipts(run_id, created_at);

        CREATE TABLE domain_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          event_version INTEGER NOT NULL CHECK (event_version > 0),
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 0),
          execution_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          actor_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          receipt_ids_json TEXT NOT NULL DEFAULT '[]',
          payload_schema TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE,
          UNIQUE(aggregate_id, aggregate_revision)
        );
        CREATE INDEX idx_domain_events_execution
          ON domain_events(execution_id, occurred_at);
        CREATE INDEX idx_domain_events_aggregate
          ON domain_events(aggregate_id, aggregate_revision);
      `);
    },
  },
  {
    version: 12,
    name: 'agent-os-claim-ledger-v3',
    up: applyClaimLedgerMigrationV12,
  },
  {
    version: 13,
    name: 'fk-cascade-cleanup',
    up(db) {
      // M3 进阶-17/29: 为 linking/log 表加 ON DELETE CASCADE
      // 解决测试中 DELETE FROM corrections_ledger / cron_jobs 时 FK 约束失败
      // SQLite 不支持 ALTER TABLE 修改 FK，需 drop+recreate+copy

      // --- evolution_candidate_corrections ---
      // 先检查表是否存在（fresh DB 可能由 migration v8 创建）
      const eccExists = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evolution_candidate_corrections'").get() as { name: string } | undefined) !== undefined;
      if (eccExists) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS evolution_candidate_corrections_new (
            candidate_id TEXT NOT NULL,
            correction_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (candidate_id, correction_id),
            FOREIGN KEY (candidate_id) REFERENCES evolution_candidates(id) ON DELETE CASCADE,
            FOREIGN KEY (correction_id) REFERENCES corrections_ledger(id) ON DELETE CASCADE
          );
          INSERT INTO evolution_candidate_corrections_new (candidate_id, correction_id, created_at)
          SELECT candidate_id, correction_id, created_at FROM evolution_candidate_corrections
          WHERE EXISTS (SELECT 1 FROM corrections_ledger WHERE id = evolution_candidate_corrections.correction_id)
            AND EXISTS (SELECT 1 FROM evolution_candidates WHERE id = evolution_candidate_corrections.candidate_id);
          DROP TABLE evolution_candidate_corrections;
          ALTER TABLE evolution_candidate_corrections_new RENAME TO evolution_candidate_corrections;
          CREATE INDEX IF NOT EXISTS idx_evolution_candidate_corrections_candidate
            ON evolution_candidate_corrections(candidate_id);
        `);
      }

      // --- cron_run_log ---
      const crlExists = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_run_log'").get() as { name: string } | undefined) !== undefined;
      if (crlExists) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS cron_run_log_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            duration_ms INTEGER,
            result_text TEXT,
            error_text TEXT,
            FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
          );
          INSERT INTO cron_run_log_new (id, job_id, status, started_at, finished_at, duration_ms, result_text, error_text)
          SELECT id, job_id, status, started_at, finished_at, duration_ms, result_text, error_text FROM cron_run_log
          WHERE EXISTS (SELECT 1 FROM cron_jobs WHERE id = cron_run_log.job_id);
          DROP TABLE cron_run_log;
          ALTER TABLE cron_run_log_new RENAME TO cron_run_log;
          CREATE INDEX IF NOT EXISTS idx_cron_run_log_job_id ON cron_run_log(job_id);
        `);
      }

      // --- cron_work_items ---
      const cwiExists = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_work_items'").get() as { name: string } | undefined) !== undefined;
      if (cwiExists) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS cron_work_items_new (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 3,
            available_at TEXT NOT NULL,
            lease_owner TEXT,
            lease_expires_at TEXT,
            payload_json TEXT NOT NULL,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
          );
          INSERT INTO cron_work_items_new (id, job_id, idempotency_key, status, attempt, max_attempts, available_at, lease_owner, lease_expires_at, payload_json, last_error, created_at, updated_at)
          SELECT id, job_id, idempotency_key, status, attempt, max_attempts, available_at, lease_owner, lease_expires_at, payload_json, last_error, created_at, updated_at FROM cron_work_items
          WHERE EXISTS (SELECT 1 FROM cron_jobs WHERE id = cron_work_items.job_id);
          DROP TABLE cron_work_items;
          ALTER TABLE cron_work_items_new RENAME TO cron_work_items;
          CREATE INDEX IF NOT EXISTS idx_cron_work_status_available ON cron_work_items(status, available_at);
          CREATE INDEX IF NOT EXISTS idx_cron_work_lease ON cron_work_items(status, lease_expires_at);
          CREATE INDEX IF NOT EXISTS idx_cron_work_job ON cron_work_items(job_id);
        `);
      }

      // --- cron_dead_letters ---
      const cdlExists = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_dead_letters'").get() as { name: string } | undefined) !== undefined;
      if (cdlExists) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS cron_dead_letters_new (
            id TEXT PRIMARY KEY,
            work_item_id TEXT NOT NULL UNIQUE,
            job_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            error_text TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
          );
          INSERT INTO cron_dead_letters_new (id, work_item_id, job_id, idempotency_key, payload_json, error_text, attempts, created_at)
          SELECT id, work_item_id, job_id, idempotency_key, payload_json, error_text, attempts, created_at FROM cron_dead_letters
          WHERE EXISTS (SELECT 1 FROM cron_jobs WHERE id = cron_dead_letters.job_id);
          DROP TABLE cron_dead_letters;
          ALTER TABLE cron_dead_letters_new RENAME TO cron_dead_letters;
          CREATE INDEX IF NOT EXISTS idx_cron_dlq_job ON cron_dead_letters(job_id);
        `);
      }
    },
  },
] as const;

/**
 * Last backup created by runAgentOsMigrations.
 * Accessible for restore operations and tests.
 */
let lastMigrationBackup: MigrationBackup | null = null;

export function getLastMigrationBackup(): MigrationBackup | null {
  return lastMigrationBackup;
}

/**
 * Resets the lastMigrationBackup state. Intended for test isolation only.
 * Production code should never call this.
 */
export function resetLastMigrationBackup(): void {
  lastMigrationBackup = null;
}

/**
 * Default number of recent backups to retain after successful migrations.
 * Override via AWKN_MIGRATION_BACKUP_KEEP env var.
 */
const DEFAULT_BACKUP_KEEP_COUNT = 5;

function applyAgentOsMigrations(db: Database.Database, maximumVersion = Number.MAX_SAFE_INTEGER): void {
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all()
      .map((row) => (row as { version: number }).version),
  );

  const pending = AGENT_OS_MIGRATIONS.filter(
    (m) => m.version <= maximumVersion && !applied.has(m.version),
  );

  if (pending.length === 0) return;

  // Create backup before applying migrations (safety net for migration failures)
  // Skip for in-memory databases (tests) or when path is not a file
  const dbPath = db.name;
  const isFileDb = dbPath && dbPath !== ':memory:' && dbPath !== '';
  if (isFileDb) {
    lastMigrationBackup = backupBeforeMigration(db, dbPath, pending.map((m) => m.version));
  }

  try {
    for (const migration of pending) {
      const apply = db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
      });
      apply();
      applied.add(migration.version);
    }
  } catch (originalError) {
    // Migration failed: DB may be in a half-migrated state.
    // Auto-restore from backup to return DB to a known-good pre-migration state.
    const backup = lastMigrationBackup;
    const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);

    if (backup) {
      // Must close db before restore (file lock on Windows)
      try {
        db.close();
      } catch {
        // db may already be closed or in bad state; continue to restore anyway
      }
      try {
        restoreFromBackup(backup);
        throw new Error(
          `Migration failed: ${originalMessage}. Database restored from backup ${backup.backupPath}. `
          + `Please restart the application to re-open the database.`,
        );
      } catch (restoreError) {
        if (restoreError instanceof Error && restoreError.message.startsWith('Migration failed:')) {
          throw restoreError;
        }
        // Restore itself failed — surface both errors
        throw new Error(
          `Migration failed: ${originalMessage}. `
          + `Auto-restore also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}. `
          + `Backup is at ${backup.backupPath}. Manual restore required: awkn-engine migrate restore --backup ${backup.backupPath}`,
        );
      }
    } else {
      // No backup (in-memory DB) — just rethrow
      throw originalError;
    }
  }

  // All migrations succeeded: clean up old backups, keeping only the most recent N.
  if (isFileDb) {
    const keepCount = Number.parseInt(process.env.AWKN_MIGRATION_BACKUP_KEEP ?? '', 10);
    cleanupOldBackups(
      dbPath,
      Number.isFinite(keepCount) && keepCount >= 0 ? keepCount : DEFAULT_BACKUP_KEEP_COUNT,
    );
  }
}

export function runAgentOsMigrations(db: Database.Database, maximumVersion?: number): void {
  runLegacyAndCompatibilityMigrations(db);
  applyAgentOsMigrations(db, maximumVersion);
}
