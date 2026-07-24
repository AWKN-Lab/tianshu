export type MemoryType = 'working' | 'project_semantic' | 'task_trajectory' | 'engineering_experience';
export type MemoryStatus = 'active' | 'superseded' | 'invalid' | 'expired';

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
}

export interface MemorySearchInput {
  query: string;
  types?: MemoryType[];
  scopeIds?: string[];
  limit?: number;
  minScore?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  recencyScore: number;
}
