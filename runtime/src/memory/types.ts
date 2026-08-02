export type MemoryType = 'working' | 'project_semantic' | 'task_trajectory' | 'engineering_experience';
export type MemoryStatus = 'active' | 'superseded' | 'invalid' | 'expired';
export type MemoryLevel = 0 | 1 | 2;

export interface MemoryEntry {
  id: string;
  memory_type: MemoryType;
  scope_id: string;
  memory_key: string;
  version: number;
  status: MemoryStatus;
  content: string;
  content_hash: string;
  embedding_json: string;
  importance: number;
  confidence: number;
  source_run_id: string | null;
  source_step_id: string | null;
  metadata_json: string;
  expires_at: string | null;
  access_count: number;
  last_access_at: string | null;
  created_at: string;
  updated_at: string;
  dir_path: string;
  level: MemoryLevel;
}

export interface MemoryPutInput {
  type: MemoryType;
  scopeId: string;
  key: string;
  content: string;
  importance?: number;
  confidence?: number;
  sourceRunId?: string;
  sourceStepId?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: string;
  dirPath?: string;
  level?: MemoryLevel;
}

export interface MemorySearchInput {
  query: string;
  types?: MemoryType[];
  scopeIds?: string[];
  limit?: number;
  minScore?: number;
  /** Recursively expand matched directories into their child entries with score propagation. */
  hierarchical?: boolean;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  recencyScore: number;
  /** Directory chain followed to reach this entry, e.g. ['docs', 'docs/auth']. */
  trail?: string[];
}

export function normalizeDirPath(path: string | undefined): string {
  if (!path) return '';
  return path.trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

export function dirSegments(path: string): string[] {
  const normalized = normalizeDirPath(path);
  if (!normalized) return [];
  return normalized.split('/');
}
