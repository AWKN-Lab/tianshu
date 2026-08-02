import { createHash } from 'node:crypto';
import { queryOne, queryRun } from '../../store/db.js';
import type { ChatMessage, ChatRequest, ChatResponse } from '../../llm/types.js';
import { enqueue } from '../../store/queue.js';
import { startAsyncWorker } from '../async-worker.js';
import { parseOps } from './schema.js';
import { applyDelete, mergeOps, opToPutInput } from './merge.js';
import type { ExtractInput, ExtractResult, MemoryOp } from './types.js';

const EXTRACTION_MODEL = 'memory-extraction';
const MAX_LLM_CHARS = 20000;
const EXTRACTION_QUEUE = 'memory-extraction';
let extractionWorkerStarted = false;

export interface ExtractionDeps {
  chat(req: ChatRequest): Promise<ChatResponse>;
  put(input: import('../types.js').MemoryPutInput): Promise<unknown>;
}

export function inputHash(userText: string, assistantText: string): string {
  return createHash('sha256').update(`${userText}\u0000${assistantText}`).digest('hex').slice(0, 16);
}

function buildMessages(input: ExtractInput): ChatMessage[] {
  const user = input.userText.slice(0, MAX_LLM_CHARS);
  const assistant = input.assistantText.slice(0, MAX_LLM_CHARS);
  return [
    {
      role: 'system',
      content: [
        'You are a memory curator. Extract durable, self-contained facts from the conversation into structured memory operations.',
        'Rules:',
        '- Only emit ops for facts worth remembering long-term; ignore small talk and transient chatter.',
        '- upsert: durable fact with a stable short key and a standalone content string that is true without this conversation.',
        '- delete: an existing memory that the conversation explicitly invalidates or supersedes.',
        '- Content must be plain text, no markdown, no quoted conversation fragments.',
        '- Respond with ONLY a JSON object: {"ops":[...]} where each op is {"op":"upsert","type":"project_semantic","scopeId":"project","key":"...","content":"...","importance":0.0-1.0,"dirPath":"optional/path"} or {"op":"delete","scopeId":"project","key":"..."}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `<conversation>\nUSER:\n${user}\n\nASSISTANT:\n${assistant}\n</conversation>`,
    },
  ];
}

export function ensureExtractionLog(): void {
  queryRun(
    `CREATE TABLE IF NOT EXISTS memory_extraction_log (
       input_hash TEXT PRIMARY KEY,
       raw_user TEXT NOT NULL,
       raw_assistant TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'raw',
       ops_json TEXT,
       model TEXT,
       error TEXT,
       created_at TEXT NOT NULL,
       extracted_at TEXT
     )`,
  );
}

export function hasBeenExtracted(inputHash: string): boolean {
  return queryOne<{ status: string }>('SELECT status FROM memory_extraction_log WHERE input_hash = ?', [inputHash])?.status === 'extracted';
}

export function enqueueExtraction(input: ExtractInput): string {
  const hash = inputHash(input.userText, input.assistantText);
  enqueue(EXTRACTION_QUEUE, { userText: input.userText, assistantText: input.assistantText, projectId: input.projectId, sessionId: input.sessionId, traceId: input.traceId }, {
    idempotencyKey: `extract:${hash}`,
    maxAttempts: 3,
  });
  return hash;
}

export function ensureExtractionWorker(deps: () => ExtractionDeps): void {
  if (extractionWorkerStarted) return;
  extractionWorkerStarted = true;
  startAsyncWorker({
    queueName: EXTRACTION_QUEUE,
    handler: async (item) => {
      await runExtraction(JSON.parse(item.payloadJson) as ExtractInput, deps());
    },
    pollIntervalMs: 5_000,
    leaseMs: 120_000,
  });
}

export async function runExtraction(input: ExtractInput, deps: ExtractionDeps): Promise<ExtractResult> {
  const startedAt = Date.now();
  const hash = inputHash(input.userText, input.assistantText);
  ensureExtractionLog();

  if (hasBeenExtracted(hash)) {
    return { ops: [], applied: 0, skipped: true, degraded: false, model: EXTRACTION_MODEL, durationMs: Date.now() - startedAt };
  }

  queryRun(
    `INSERT OR IGNORE INTO memory_extraction_log
       (input_hash, raw_user, raw_assistant, status, created_at)
     VALUES (?, ?, ?, 'raw', ?)`,
    [hash, input.userText.slice(0, MAX_LLM_CHARS), input.assistantText.slice(0, MAX_LLM_CHARS), new Date().toISOString()],
  );

  let ops: MemoryOp[] = [];
  try {
    const response = await deps.chat({
      messages: buildMessages(input),
      model: EXTRACTION_MODEL,
      callSource: 'memory_extraction',
      fallbackPolicy: 'allow',
      traceId: input.traceId,
    });
    ops = parseOps(response.content) ?? [];
  } catch (err) {
    const reason = String(err);
    queryRun(`UPDATE memory_extraction_log SET error = ?, model = ? WHERE input_hash = ?`, [reason.slice(0, 500), EXTRACTION_MODEL, hash]);
    return { ops: [], applied: 0, skipped: false, degraded: true, model: EXTRACTION_MODEL, durationMs: Date.now() - startedAt };
  }

  const merged = mergeOps(ops);
  let applied = 0;
  for (const op of merged) {
    if (op.op === 'delete') {
      applyDelete(op, input.projectId);
    } else {
      await deps.put(opToPutInput(op, input.projectId));
    }
    applied++;
  }

  queryRun(
    `UPDATE memory_extraction_log SET status = 'extracted', ops_json = ?, model = ?, extracted_at = ? WHERE input_hash = ?`,
    [JSON.stringify(merged), EXTRACTION_MODEL, new Date().toISOString(), hash],
  );

  return { ops: merged, applied, skipped: false, degraded: false, model: EXTRACTION_MODEL, durationMs: Date.now() - startedAt };
}
