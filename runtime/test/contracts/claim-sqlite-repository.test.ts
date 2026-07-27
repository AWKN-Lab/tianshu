import Database from 'better-sqlite3';
import { SqliteClaimRepository } from '../../src/context/public.js';
import { runAgentOsMigrations } from '../../src/store/agent-os-migration-registry.js';
import { claimRepositoryConformance } from './claim-repository-conformance.js';

claimRepositoryConformance('sqlite', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runAgentOsMigrations(db);
  return new SqliteClaimRepository(db);
});
