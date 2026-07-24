import { createHash, randomUUID } from 'node:crypto';
import { cosineSimilarity, HashEmbeddingProvider, lexicalSimilarity, type EmbeddingProvider } from './embedding.js';
import { queryAll, queryOne, queryRun, transaction } from '../store/db.js';
import type { MemoryEntry, MemoryPutInput, MemorySearchInput, MemorySearchResult, MemoryType } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseEmbedding(entry: MemoryEntry): number[] {
  try {
    const parsed = JSON.parse(entry.embedding_json) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

function defaultProjectId(): string {
  return process.env.AWKN_PROJECT_ID ?? process.env.npm_package_name ?? 'default-project';
}

function defaultSessionId(projectId: string): string {
  return process.env.AWKN_MEMORY_SESSION_ID ?? projectId;
}

function extractiveSummary(entries: MemoryEntry[], maxChars: number): string {
  const seen = new Set<string>();
  const sentences: string[] = [];
  const sorted = [...entries].sort((left, right) =>
    right.importance - left.importance || right.created_at.localeCompare(left.created_at));
  for (const entry of sorted) {
    for (const sentence of entry.content.split(/(?<=[。！？.!?])\s+|\n+/)) {
      const normalized = sentence.trim().replace(/\s+/g, ' ');
      if (normalized.length < 8) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sentences.push(normalized);
      if (sentences.join('\n').length >= maxChars) return sentences.join('\n').slice(0, maxChars);
    }
  }
  return sentences.join('\n').slice(0, maxChars);
}

export class MemoryService {
  constructor(private readonly embedding: EmbeddingProvider = new HashEmbeddingProvider()) {}

  put(input: MemoryPutInput): MemoryEntry {
    if (!input.scopeId.trim()) throw new Error('memory scopeId is required');
    if (!input.key.trim()) throw new Error('memory key is required');
    if (!input.content.trim()) throw new Error('memory content is required');
    const now = new Date();
    const expiresAt = input.expiresAt
      ?? (input.type === 'working' ? new Date(now.getTime() + DAY_MS).toISOString() : undefined);
    const contentHash = createHash('sha256').update(input.content).digest('hex');
    const version = (queryOne<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM memory_entries
       WHERE memory_type = ? AND scope_id = ? AND memory_key = ?`,
      [input.type, input.scopeId, input.key],
    )?.version ?? 0) + 1;
    const id = randomUUID();

    transaction(() => {
      queryRun(
        `UPDATE memory_entries SET status = 'superseded', updated_at = ?
         WHERE memory_type = ? AND scope_id = ? AND memory_key = ? AND status = 'active'`,
        [now.toISOString(), input.type, input.scopeId, input.key],
      );
      queryRun(
        `INSERT INTO memory_entries
         (id, memory_type, scope_id, memory_key, version, status, content, content_hash,
          embedding_json, importance, confidence, source_run_id, source_step_id,
          metadata_json, expires_at, access_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          id,
          input.type,
          input.scopeId,
          input.key,
          version,
          input.content,
          contentHash,
          JSON.stringify(this.embedding.embed(input.content)),
          clamp(input.importance ?? 0.5),
          clamp(input.confidence ?? 0.8),
          input.sourceRunId ?? null,
          input.sourceStepId ?? null,
          JSON.stringify(input.metadata ?? {}),
          expiresAt ?? null,
          now.toISOString(),
          now.toISOString(),
        ],
      );
      this.recordEvent(id, 'created', { version, contentHash });
    });
    return this.read(id)!;
  }

  read(id: string): MemoryEntry | null {
    return queryOne<MemoryEntry>('SELECT * FROM memory_entries WHERE id = ?', [id]) ?? null;
  }

  getLatest(type: MemoryType, scopeId: string, key: string): MemoryEntry | null {
    this.expireNow();
    return queryOne<MemoryEntry>(
      `SELECT * FROM memory_entries
       WHERE memory_type = ? AND scope_id = ? AND memory_key = ? AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
      [type, scopeId, key],
    ) ?? null;
  }

  search(input: MemorySearchInput): MemorySearchResult[] {
    this.expireNow();
    const types = input.types?.length ? input.types : ['working', 'project_semantic', 'task_trajectory', 'engineering_experience'] satisfies MemoryType[];
    const scopes = input.scopeIds?.length ? input.scopeIds : [defaultProjectId(), 'global'];
    const typePlaceholders = types.map(() => '?').join(',');
    const scopePlaceholders = scopes.map(() => '?').join(',');
    const rows = queryAll<MemoryEntry>(
      `SELECT * FROM memory_entries
       WHERE status = 'active'
         AND memory_type IN (${typePlaceholders})
         AND scope_id IN (${scopePlaceholders})
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY importance DESC, updated_at DESC LIMIT 500`,
      [...types, ...scopes, new Date().toISOString()],
    );
    const queryEmbedding = this.embedding.embed(input.query);
    const now = Date.now();
    const scored = rows.map((entry): MemorySearchResult => {
      const semanticScore = Math.max(0, cosineSimilarity(queryEmbedding, parseEmbedding(entry)));
      const lexicalScore = lexicalSimilarity(input.query, `${entry.memory_key}\n${entry.content}`);
      const ageDays = Math.max(0, now - new Date(entry.updated_at).getTime()) / DAY_MS;
      const recencyScore = Math.exp(-ageDays / 30);
      const score = 0.5 * semanticScore
        + 0.22 * lexicalScore
        + 0.18 * entry.importance
        + 0.1 * recencyScore;
      return { entry, score, semanticScore, lexicalScore, recencyScore };
    }).filter((result) => result.score >= (input.minScore ?? 0.08))
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit ?? 8);

    const accessedAt = new Date().toISOString();
    for (const result of scored) {
      queryRun(
        `UPDATE memory_entries SET access_count = access_count + 1, last_access_at = ? WHERE id = ?`,
        [accessedAt, result.entry.id],
      );
    }
    return scored;
  }

  buildContext(input: { query: string; projectId?: string; sessionId?: string; limit?: number; maxChars?: number }): string {
    const projectId = input.projectId ?? defaultProjectId();
    const sessionId = input.sessionId ?? defaultSessionId(projectId);
    const perGroup = Math.max(1, Math.ceil((input.limit ?? 8) / 4));
    const groups = [
      this.search({ query: input.query, types: ['working'], scopeIds: [sessionId], limit: perGroup }),
      this.search({ query: input.query, types: ['project_semantic'], scopeIds: [projectId], limit: perGroup }),
      this.search({ query: input.query, types: ['task_trajectory'], scopeIds: [projectId], limit: perGroup }),
      this.search({ query: input.query, types: ['engineering_experience'], scopeIds: [projectId, 'global'], limit: perGroup }),
    ];
    const selected = groups.flat().sort((left, right) => right.score - left.score).slice(0, input.limit ?? 8);
    if (selected.length === 0) return '';
    const lines = selected.map(({ entry, score }) =>
      `- [${entry.memory_type}/${entry.memory_key}@v${entry.version}; score=${score.toFixed(3)}] ${entry.content}`);
    return [
      'AWKN_MEMORY_CONTEXT',
      'Use these memories only when relevant. Current user instructions and repository evidence have higher priority.',
      ...lines,
      'END_AWKN_MEMORY_CONTEXT',
    ].join('\n').slice(0, input.maxChars ?? 6000);
  }

  recordInteraction(input: { userText: string; assistantText: string; projectId?: string; sessionId?: string; traceId?: string }): MemoryEntry | null {
    if (!input.userText.trim() || !input.assistantText.trim()) return null;
    const projectId = input.projectId ?? defaultProjectId();
    const sessionId = input.sessionId ?? defaultSessionId(projectId);
    return this.put({
      type: 'working',
      scopeId: sessionId,
      key: `interaction:${Date.now()}:${randomUUID().slice(0, 8)}`,
      content: `User: ${input.userText.slice(0, 3000)}\nAssistant: ${input.assistantText.slice(0, 5000)}`,
      importance: 0.45,
      confidence: 1,
      metadata: { projectId, traceId: input.traceId ?? null },
    });
  }

  recordRunTrajectory(runId: string, projectId = defaultProjectId()): MemoryEntry | null {
    const run = queryOne<{
      id: string;
      workflow_name: string;
      status: string;
      goal_id: string | null;
      trace_id: string;
      input_json: string;
      output_json: string | null;
      started_at: string;
      finished_at: string | null;
    }>('SELECT * FROM runs WHERE id = ?', [runId]);
    if (!run) return null;
    const events = queryAll<{ event_type: string; payload_json: string }>(
      'SELECT event_type, payload_json FROM events WHERE run_id = ? ORDER BY id ASC',
      [runId],
    );
    const steps = queryAll<{ step_key: string; step_type: string; status: string; attempt: number; error_text: string | null }>(
      'SELECT step_key, step_type, status, attempt, error_text FROM steps WHERE run_id = ? ORDER BY started_at ASC, rowid ASC',
      [runId],
    );
    const content = [
      `Run ${run.id}`,
      `Workflow: ${run.workflow_name}`,
      `Goal: ${run.goal_id ?? 'none'}`,
      `Status: ${run.status}`,
      `Started: ${run.started_at}`,
      `Finished: ${run.finished_at ?? 'unknown'}`,
      `Steps: ${steps.map((step) => `${step.step_key}[${step.step_type}]=${step.status}#${step.attempt}${step.error_text ? `(${step.error_text})` : ''}`).join('; ') || 'none'}`,
      `Events: ${events.map((event) => event.event_type).join(' → ')}`,
      `Output: ${(run.output_json ?? '').slice(0, 3000)}`,
    ].join('\n');
    return this.put({
      type: 'task_trajectory',
      scopeId: projectId,
      key: `run:${run.id}`,
      content,
      importance: run.status === 'succeeded' ? 0.65 : 0.8,
      confidence: 1,
      sourceRunId: run.id,
      metadata: { workflow: run.workflow_name, status: run.status, traceId: run.trace_id },
    });
  }

  invalidate(id: string, reason: string): MemoryEntry {
    const entry = this.read(id);
    if (!entry) throw new Error(`memory ${id} not found`);
    if (entry.status !== 'active') return entry;
    queryRun(
      `UPDATE memory_entries SET status = 'invalid', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    );
    this.recordEvent(id, 'invalidated', { reason });
    return this.read(id)!;
  }

  expireNow(now = new Date()): number {
    const rows = queryAll<{ id: string }>(
      `SELECT id FROM memory_entries WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
      [now.toISOString()],
    );
    if (rows.length === 0) return 0;
    for (const row of rows) {
      queryRun(`UPDATE memory_entries SET status = 'expired', updated_at = ? WHERE id = ?`, [now.toISOString(), row.id]);
      this.recordEvent(row.id, 'expired', {});
    }
    return rows.length;
  }

  listVersions(type: MemoryType, scopeId: string, key: string): MemoryEntry[] {
    return queryAll<MemoryEntry>(
      `SELECT * FROM memory_entries
       WHERE memory_type = ? AND scope_id = ? AND memory_key = ? ORDER BY version DESC`,
      [type, scopeId, key],
    );
  }

  rollback(type: MemoryType, scopeId: string, key: string, targetVersion: number): MemoryEntry {
    const target = queryOne<MemoryEntry>(
      `SELECT * FROM memory_entries
       WHERE memory_type = ? AND scope_id = ? AND memory_key = ? AND version = ?`,
      [type, scopeId, key, targetVersion],
    );
    if (!target) throw new Error(`memory version not found: ${type}/${scopeId}/${key}@${targetVersion}`);
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(target.metadata_json) as Record<string, unknown>; } catch { /* noop */ }
    const restored = this.put({
      type,
      scopeId,
      key,
      content: target.content,
      importance: target.importance,
      confidence: target.confidence,
      sourceRunId: target.source_run_id ?? undefined,
      sourceStepId: target.source_step_id ?? undefined,
      metadata: { ...metadata, rollbackFromVersion: targetVersion, rollbackSourceId: target.id },
      expiresAt: target.expires_at ?? undefined,
    });
    this.recordEvent(restored.id, 'rolled_back', { targetVersion, targetId: target.id });
    return restored;
  }

  compress(input: { type: MemoryType; scopeId: string; key?: string; maxChars?: number; minimumEntries?: number }): MemoryEntry | null {
    const entries = queryAll<MemoryEntry>(
      `SELECT * FROM memory_entries
       WHERE memory_type = ? AND scope_id = ? AND status = 'active'
       ORDER BY importance DESC, updated_at DESC`,
      [input.type, input.scopeId],
    );
    if (entries.length < (input.minimumEntries ?? 2)) return null;
    const summary = extractiveSummary(entries, input.maxChars ?? 5000);
    if (!summary) return null;
    const compacted = this.put({
      type: input.type,
      scopeId: input.scopeId,
      key: input.key ?? `compacted:${input.type}`,
      content: summary,
      importance: Math.max(...entries.map((entry) => entry.importance)),
      confidence: Math.min(...entries.map((entry) => entry.confidence)),
      metadata: { compactedFrom: entries.map((entry) => entry.id) },
    });
    const now = new Date().toISOString();
    for (const entry of entries) {
      if (entry.id === compacted.id) continue;
      queryRun(`UPDATE memory_entries SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'active'`, [now, entry.id]);
    }
    queryRun(
      `INSERT INTO memory_compactions
       (id, memory_type, scope_id, source_ids_json, output_memory_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), input.type, input.scopeId, JSON.stringify(entries.map((entry) => entry.id)), compacted.id, now],
    );
    this.recordEvent(compacted.id, 'compacted', { sourceCount: entries.length });
    return compacted;
  }

  private recordEvent(memoryId: string, eventType: string, payload: Record<string, unknown>): void {
    queryRun(
      `INSERT INTO memory_events (id, memory_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), memoryId, eventType, JSON.stringify(payload), new Date().toISOString()],
    );
  }
}

let instance: MemoryService | null = null;
export function getMemoryService(): MemoryService {
  if (!instance) instance = new MemoryService();
  return instance;
}
