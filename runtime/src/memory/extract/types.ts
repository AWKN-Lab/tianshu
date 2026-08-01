import type { MemoryType } from '../types.js';

export type MemoryOpUpsert = {
  op: 'upsert';
  type: MemoryType;
  scopeId: string;
  key: string;
  content: string;
  importance?: number;
  dirPath?: string;
};

export type MemoryOpDelete = {
  op: 'delete';
  scopeId: string;
  key: string;
};

export type MemoryOp = MemoryOpUpsert | MemoryOpDelete;

export interface ExtractInput {
  userText: string;
  assistantText: string;
  projectId: string;
  sessionId: string;
  traceId?: string;
}

export interface ExtractResult {
  ops: MemoryOp[];
  applied: number;
  skipped: boolean;
  degraded: boolean;
  model: string;
  durationMs: number;
}
