import type Database from 'better-sqlite3';

export function applyClaimLedgerMigrationV12(db: Database.Database): void {
  db.exec(`
    CREATE TABLE claims (
      id TEXT PRIMARY KEY,
      content TEXT,
      content_ref_json TEXT,
      content_hash TEXT NOT NULL,
      originator TEXT NOT NULL CHECK (originator IN ('human','assistant','system','external')),
      speaker TEXT NOT NULL CHECK (speaker IN ('human','assistant','system','tool')),
      claim_type TEXT NOT NULL,
      epistemic_status TEXT NOT NULL CHECK (epistemic_status IN (
        'proposed','asserted','derived','observed','disputed','superseded','expired'
      )),
      confirmation_level TEXT NOT NULL CHECK (confirmation_level IN ('none','direction','option','field')),
      authority REAL NOT NULL CHECK (authority >= 0 AND authority <= 1),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      sensitivity_class TEXT NOT NULL,
      project_id TEXT,
      user_id TEXT,
      valid_from TEXT,
      valid_until TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (content IS NOT NULL OR content_ref_json IS NOT NULL)
    );
    CREATE INDEX idx_claims_scope_status
      ON claims(project_id, user_id, epistemic_status, updated_at);
    CREATE INDEX idx_claims_content_hash ON claims(content_hash);

    CREATE TABLE claim_sources (
      claim_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_uri TEXT,
      source_span_json TEXT,
      source_hash TEXT,
      observed_at TEXT,
      source_json TEXT NOT NULL,
      PRIMARY KEY (claim_id, source_id),
      FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
    );

    CREATE TABLE claim_derivations (
      claim_id TEXT NOT NULL,
      parent_claim_id TEXT NOT NULL,
      derivation_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (claim_id, parent_claim_id),
      FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_claim_id) REFERENCES claims(id)
    );

    CREATE TABLE claim_confirmations (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('direction','option','field')),
      field_path TEXT,
      actor_json TEXT NOT NULL,
      source_ref_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
    );

    CREATE TABLE claim_conflicts (
      id TEXT PRIMARY KEY,
      left_claim_id TEXT NOT NULL,
      right_claim_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED','SUPERSEDED')),
      resolution_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      CHECK (left_claim_id <> right_claim_id),
      FOREIGN KEY (left_claim_id) REFERENCES claims(id),
      FOREIGN KEY (right_claim_id) REFERENCES claims(id)
    );
    CREATE UNIQUE INDEX idx_claim_conflicts_pair
      ON claim_conflicts(
        CASE WHEN left_claim_id < right_claim_id THEN left_claim_id ELSE right_claim_id END,
        CASE WHEN left_claim_id < right_claim_id THEN right_claim_id ELSE left_claim_id END
      );

    CREATE TABLE claim_events (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      payload_schema TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE,
      UNIQUE (claim_id, revision),
      UNIQUE (idempotency_key, claim_id)
    );
    CREATE INDEX idx_claim_events_claim_revision
      ON claim_events(claim_id, revision);
  `);
}
