import { createHash, randomUUID } from 'node:crypto';
import { cosineSimilarity, HashEmbeddingProvider, lexicalSimilarity, type EmbeddingProvider } from './embedding.js';
import { queryAll, queryOne, queryRun, transaction } from '../store/db.js';
import { NoopRerankProvider, type RerankProvider } from '../llm/rerank.js';
import { dirSegments, normalizeDirPath, type MemoryEntry, type MemoryPutInput, type MemorySearchInput, type MemorySearchResult, type MemoryType } from './types.js';

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
  constructor(
    private readonly embedding: EmbeddingProvider = new HashEmbeddingProvider(),
    private readonly fallbackEmbedding: EmbeddingProvider = new HashEmbeddingProvider(),
    private readonly rerank: RerankProvider = new NoopRerankProvider(),
  ) {}

  private async safeEmbed(text: string): Promise<number[]> {
    try {
      return await this.embedding.embed(text);
    } catch {
      return this.fallbackEmbedding.embed(text);
    }
  }

  private async safeEmbedMany(texts: string[]): Promise<number[][]> {
    try {
      return await this.embedding.embedMany(texts);
    } catch {
      const vectors: number[][] = [];
      for (const text of texts) vectors.push(await this.fallbackEmbedding.embed(text));
      return vectors;
    }
  }

  async put(input: MemoryPutInput): Promise<MemoryEntry> {
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
    const embeddingVector = await this.safeEmbed(input.content);
    const dirPath = normalizeDirPath(input.dirPath);
    const level = input.level ?? 2;

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
          metadata_json, expires_at, access_count, created_at, updated_at, dir_path, level)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          id,
          input.type,
          input.scopeId,
          input.key,
          version,
          input.content,
          contentHash,
          JSON.stringify(embeddingVector),
          clamp(input.importance ?? 0.5),
          clamp(input.confidence ?? 0.8),
          input.sourceRunId ?? null,
          input.sourceStepId ?? null,
          JSON.stringify(input.metadata ?? {}),
          expiresAt ?? null,
          now.toISOString(),
          now.toISOString(),
          dirPath,
          level,
        ],
      );
      this.recordEvent(id, 'created', { version, contentHash, dirPath, level });
    });
    if (dirPath && level === 2) await this.ensureDirNodes(input.type, input.scopeId, dirPath, now);
    return this.read(id)!;
  }

  private async ensureDirNodes(type: MemoryType, scopeId: string, dirPath: string, now: Date): Promise<void> {
    const segments = dirSegments(dirPath);
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const parent = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
      const children = queryAll<MemoryEntry>(
        `SELECT * FROM memory_entries
         WHERE status = 'active' AND memory_type = ? AND scope_id = ? AND dir_path = ? AND level = 2
         ORDER BY importance DESC LIMIT 100`,
        [type, scopeId, prefix],
      );
      const subDirs = queryAll<MemoryEntry>(
        `SELECT * FROM memory_entries
         WHERE status = 'active' AND memory_type = ? AND scope_id = ? AND dir_path = ? AND level = 1
         ORDER BY memory_key LIMIT 50`,
        [type, scopeId, prefix],
      );
      const content = [
        `Directory: ${prefix}`,
        `Entries: ${children.length}`,
        ...children.map((child) => `- ${child.memory_key}`),
        ...(subDirs.length > 0 ? [`Subdirectories:`, ...subDirs.map((sub) => `- ${sub.memory_key.replace(/^dir:/, '')}`)] : []),
      ].join('\n');
      const dirKey = `dir:${prefix}`;
      const version = (queryOne<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) AS version FROM memory_entries
         WHERE memory_type = ? AND scope_id = ? AND memory_key = ?`,
        [type, scopeId, dirKey],
      )?.version ?? 0) + 1;
      const id = randomUUID();
      const importance = clamp(Math.max(...children.map((child) => child.importance), 0.3) * 0.6, 0.3, 1);
      const embedding = await this.safeEmbed(content);
      transaction(() => {
        queryRun(
          `UPDATE memory_entries SET status = 'superseded', updated_at = ?
           WHERE memory_type = ? AND scope_id = ? AND memory_key = ? AND status = 'active'`,
          [now.toISOString(), type, scopeId, dirKey],
        );
        queryRun(
          `INSERT INTO memory_entries
           (id, memory_type, scope_id, memory_key, version, status, content, content_hash,
            embedding_json, importance, confidence, source_run_id, source_step_id,
            metadata_json, expires_at, access_count, created_at, updated_at, dir_path, level)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0.6, NULL, NULL, '{}', NULL, 0, ?, ?, ?, 1)`,
          [
            id,
            type,
            scopeId,
            dirKey,
            version,
            content,
            createHash('sha256').update(content).digest('hex'),
            JSON.stringify(embedding),
            importance,
            now.toISOString(),
            now.toISOString(),
            parent,
          ],
        );
        this.recordEvent(id, 'dir_indexed', { path: prefix, childCount: children.length, subDirCount: subDirs.length });
      });
    }
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

  async search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
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
    const queryVector = await this.safeEmbed(input.query);
    const contentVectors = await this.safeEmbedMany(rows.map((entry) => entry.content));
    const now = Date.now();
    const candidates = rows.map((entry, index): MemorySearchResult => {
      const semanticScore = Math.max(0, cosineSimilarity(queryVector, contentVectors[index] ?? parseEmbedding(entry)));
      const lexicalScore = lexicalSimilarity(input.query, `${entry.memory_key}\n${entry.content}`);
      const ageDays = Math.max(0, now - new Date(entry.updated_at).getTime()) / DAY_MS;
      const recencyScore = Math.exp(-ageDays / 30);
      return {
        entry,
        score: 0,
        semanticScore,
        lexicalScore,
        recencyScore,
      };
    });
    const rerankEnabled = this.rerank.name !== 'noop';
    if (rerankEnabled) {
      const topCandidates = candidates
        .map((candidate) => ({
          ...candidate,
          base: 0.5 * candidate.semanticScore + 0.22 * candidate.lexicalScore + 0.18 * candidate.entry.importance + 0.1 * candidate.recencyScore,
        }))
        .sort((left, right) => right.base - left.base)
        .slice(0, 100);
      const reranked = await this.rerank.rerank({
        query: input.query,
        items: topCandidates.map((candidate) => ({ id: candidate.entry.id, text: `${candidate.entry.memory_key}\n${candidate.entry.content}` })),
        topK: Math.min(input.limit ?? 8, topCandidates.length),
      });
      const rerankById = new Map(reranked.map((result) => [result.id, result.score]));
      for (const candidate of topCandidates) {
        candidate.score = 0.55 * (rerankById.get(candidate.entry.id) ?? 0)
          + 0.15 * candidate.semanticScore
          + 0.12 * candidate.lexicalScore
          + 0.10 * candidate.entry.importance
          + 0.08 * candidate.recencyScore;
      }
      candidates.splice(0, candidates.length, ...topCandidates);
    } else {
      for (const candidate of candidates) {
        candidate.score = 0.5 * candidate.semanticScore
          + 0.22 * candidate.lexicalScore
          + 0.18 * candidate.entry.importance
          + 0.1 * candidate.recencyScore;
      }
    }
    const scored = candidates
      .filter((result) => result.score >= (input.minScore ?? 0.08))
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

  async searchHierarchical(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    this.expireNow();
    const limit = input.limit ?? 8;
    const top = await this.search({ ...input, limit: Math.max(20, limit) });
    const results = [...top];
    const seen = new Set(top.map((result) => result.entry.id));
    const queue: Array<{ dirPath: string; parentScore: number; trail: string[] }> = [];
    for (const result of top) {
      if (result.entry.level === 1 && result.entry.memory_key.startsWith('dir:')) {
        const dirPath = result.entry.memory_key.slice(4);
        queue.push({ dirPath, parentScore: result.score, trail: [`dir:${dirPath}`] });
      }
    }
    const types = input.types?.length ? input.types : ['working', 'project_semantic', 'task_trajectory', 'engineering_experience'] satisfies MemoryType[];
    const scopes = input.scopeIds?.length ? input.scopeIds : [defaultProjectId(), 'global'];
    const typePlaceholders = types.map(() => '?').join(',');
    const scopePlaceholders = scopes.map(() => '?').join(',');
    const now = Date.now();
    let rounds = 0;
    while (queue.length > 0 && rounds < 3) {
      rounds++;
      const batch = queue.splice(0, 4);
      const next: typeof queue = [];
      for (const dir of batch) {
        const children = queryAll<MemoryEntry>(
          `SELECT * FROM memory_entries
           WHERE status = 'active' AND dir_path = ? AND level = 2
             AND memory_type IN (${typePlaceholders})
             AND scope_id IN (${scopePlaceholders})
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY importance DESC LIMIT 50`,
          [dir.dirPath, ...types, ...scopes, new Date().toISOString()],
        );
        const queryVector = await this.safeEmbed(input.query);
        const vectors = await this.safeEmbedMany(children.map((child) => child.content));
        for (let index = 0; index < children.length; index++) {
          const child = children[index]!;
          if (seen.has(child.id)) continue;
          const semanticScore = Math.max(0, cosineSimilarity(queryVector, vectors[index] ?? []));
          const lexicalScore = lexicalSimilarity(input.query, `${child.memory_key}\n${child.content}`);
          const ageDays = Math.max(0, now - new Date(child.updated_at).getTime()) / DAY_MS;
          const recencyScore = Math.exp(-ageDays / 30);
          const base = 0.5 * semanticScore + 0.22 * lexicalScore + 0.18 * child.importance + 0.1 * recencyScore;
          const score = 0.5 * base + 0.5 * dir.parentScore;
          results.push({
            entry: child,
            score,
            semanticScore,
            lexicalScore,
            recencyScore,
            trail: dir.trail,
          });
          seen.add(child.id);
        }
        const subDirs = queryAll<MemoryEntry>(
          `SELECT * FROM memory_entries
           WHERE status = 'active' AND dir_path = ? AND level = 1
             AND memory_type IN (${typePlaceholders})
             AND scope_id IN (${scopePlaceholders})
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY importance DESC LIMIT 50`,
          [dir.dirPath, ...types, ...scopes, new Date().toISOString()],
        );
        for (const sub of subDirs) {
          if (seen.has(sub.id)) continue;
          seen.add(sub.id);
          const subPath = sub.memory_key.startsWith('dir:') ? sub.memory_key.slice(4) : sub.dir_path;
          next.push({
            dirPath: subPath,
            parentScore: Math.max(0.3, dir.parentScore * 0.7),
            trail: [...dir.trail, `dir:${subPath}`],
          });
        }
      }
      queue.push(...next);
    }
    const scored = results
      .filter((result) => result.score >= (input.minScore ?? 0.08))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    const accessedAt = new Date().toISOString();
    for (const result of scored) {
      queryRun(
        `UPDATE memory_entries SET access_count = access_count + 1, last_access_at = ? WHERE id = ?`,
        [accessedAt, result.entry.id],
      );
    }
    return scored;
  }

  async buildContext(input: { query: string; projectId?: string; sessionId?: string; limit?: number; maxChars?: number }): Promise<string> {
    const projectId = input.projectId ?? defaultProjectId();
    const sessionId = input.sessionId ?? defaultSessionId(projectId);
    const perGroup = Math.max(1, Math.ceil((input.limit ?? 8) / 4));
    const groups = await Promise.all([
      this.searchHierarchical({ query: input.query, types: ['working'], scopeIds: [sessionId], limit: perGroup }),
      this.searchHierarchical({ query: input.query, types: ['project_semantic'], scopeIds: [projectId], limit: perGroup }),
      this.searchHierarchical({ query: input.query, types: ['task_trajectory'], scopeIds: [projectId], limit: perGroup }),
      this.searchHierarchical({ query: input.query, types: ['engineering_experience'], scopeIds: [projectId, 'global'], limit: perGroup }),
    ]);
    const selected = groups.flat().sort((left, right) => right.score - left.score).slice(0, input.limit ?? 8);
    if (selected.length === 0) return '';
    const lines = selected.map(({ entry, score, trail }) => {
      const head = trail?.length
        ? `[${trail.join(' > ')}]`
        : `[${entry.memory_type}/${entry.memory_key}@v${entry.version}]`;
      if (entry.level === 1) {
        const summary = entry.content.split('\n').slice(0, 3).join(' · ').slice(0, 200);
        return `- ${head} dir; score=${score.toFixed(3)} ${summary}`;
      }
      return `- ${head}; score=${score.toFixed(3)} ${entry.content}`;
    });
    return [
      'AWKN_MEMORY_CONTEXT',
      'Use these memories only when relevant. Current user instructions and repository evidence have higher priority.',
      ...lines,
      'END_AWKN_MEMORY_CONTEXT',
    ].join('\n').slice(0, input.maxChars ?? 6000);
  }

  async recordInteraction(input: { userText: string; assistantText: string; projectId?: string; sessionId?: string; traceId?: string }): Promise<MemoryEntry | null> {
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

  async recordRunTrajectory(runId: string, projectId = defaultProjectId()): Promise<MemoryEntry | null> {
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

  async rollback(type: MemoryType, scopeId: string, key: string, targetVersion: number): Promise<MemoryEntry> {
    const target = queryOne<MemoryEntry>(
      `SELECT * FROM memory_entries
       WHERE memory_type = ? AND scope_id = ? AND memory_key = ? AND version = ?`,
      [type, scopeId, key, targetVersion],
    );
    if (!target) throw new Error(`memory version not found: ${type}/${scopeId}/${key}@${targetVersion}`);
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(target.metadata_json) as Record<string, unknown>; } catch { /* noop */ }
    const restored = await this.put({
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

  async compress(input: { type: MemoryType; scopeId: string; key?: string; maxChars?: number; minimumEntries?: number }): Promise<MemoryEntry | null> {
    const entries = queryAll<MemoryEntry>(
      `SELECT * FROM memory_entries
       WHERE memory_type = ? AND scope_id = ? AND status = 'active'
       ORDER BY importance DESC, updated_at DESC`,
      [input.type, input.scopeId],
    );
    if (entries.length < (input.minimumEntries ?? 2)) return null;
    const summary = extractiveSummary(entries, input.maxChars ?? 5000);
    if (!summary) return null;
    const compacted = await this.put({
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
