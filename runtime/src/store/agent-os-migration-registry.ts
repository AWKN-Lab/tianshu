import type Database from 'better-sqlite3';
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
] as const;

function applyAgentOsMigrations(db: Database.Database, maximumVersion = Number.MAX_SAFE_INTEGER): void {
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all()
      .map((row) => (row as { version: number }).version),
  );
  for (const migration of AGENT_OS_MIGRATIONS) {
    if (migration.version > maximumVersion || applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    });
    apply();
    applied.add(migration.version);
  }
}

export function runAgentOsMigrations(db: Database.Database, maximumVersion?: number): void {
  runLegacyAndCompatibilityMigrations(db);
  applyAgentOsMigrations(db, maximumVersion);
}
