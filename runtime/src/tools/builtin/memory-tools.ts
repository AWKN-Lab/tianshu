import { getMemoryService } from '../../memory/service.js';
import type { MemoryType } from '../../memory/types.js';
import type { ToolHandler } from '../types.js';

const TYPES: MemoryType[] = ['working', 'project_semantic', 'task_trajectory', 'engineering_experience'];
function memoryType(value: unknown): MemoryType {
  const type = String(value ?? 'project_semantic') as MemoryType;
  if (!TYPES.includes(type)) throw new Error(`unsupported memory type: ${type}`);
  return type;
}

export const memorySearchTool: ToolHandler = {
  name: 'memory_search',
  description: 'Search working, project semantic, task trajectory and engineering experience memory using hybrid semantic retrieval.',
  source: 'builtin',
  isReadOnly: true,
  concurrentSafe: true,
  permissionLevel: 'none',
  priority: 'high',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      types: { type: 'array', items: { type: 'string', enum: TYPES } },
      scopeIds: { type: 'array', items: { type: 'string' } },
      limit: { type: 'number' },
    },
    required: ['query'],
  },
  async execute(args) {
    const results = await getMemoryService().search({
      query: String(args.query ?? ''),
      types: Array.isArray(args.types) ? args.types.map(memoryType) : undefined,
      scopeIds: Array.isArray(args.scopeIds) ? args.scopeIds.map(String) : undefined,
      limit: Number(args.limit ?? 8),
    });
    return JSON.stringify(results.map((result) => ({
      id: result.entry.id,
      type: result.entry.memory_type,
      scopeId: result.entry.scope_id,
      key: result.entry.memory_key,
      version: result.entry.version,
      score: result.score,
      content: result.entry.content,
    })), null, 2);
  },
};

export const memoryWriteTool: ToolHandler = {
  name: 'memory_write',
  description: 'Create a versioned memory entry. Use project_semantic for stable project facts and engineering_experience for reusable engineering rules.',
  source: 'builtin',
  isReadOnly: false,
  concurrentSafe: false,
  permissionLevel: 'none',
  priority: 'medium',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: TYPES },
      scopeId: { type: 'string' },
      key: { type: 'string' },
      content: { type: 'string' },
      importance: { type: 'number' },
      confidence: { type: 'number' },
      expiresAt: { type: 'string' },
    },
    required: ['type', 'scopeId', 'key', 'content'],
  },
  async execute(args, ctx) {
    const entry = await getMemoryService().put({
      type: memoryType(args.type),
      scopeId: String(args.scopeId),
      key: String(args.key),
      content: String(args.content),
      importance: args.importance === undefined ? undefined : Number(args.importance),
      confidence: args.confidence === undefined ? undefined : Number(args.confidence),
      expiresAt: args.expiresAt === undefined ? undefined : String(args.expiresAt),
      sourceRunId: ctx?.runId,
      sourceStepId: ctx?.stepId,
      metadata: { writtenBy: 'memory_write', traceId: ctx?.traceId ?? null },
    });
    return JSON.stringify(entry, null, 2);
  },
};

export const memoryVersionsTool: ToolHandler = {
  name: 'memory_versions',
  description: 'List all versions of a memory key.',
  source: 'builtin',
  isReadOnly: true,
  concurrentSafe: true,
  permissionLevel: 'none',
  priority: 'normal',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: TYPES },
      scopeId: { type: 'string' },
      key: { type: 'string' },
    },
    required: ['type', 'scopeId', 'key'],
  },
  async execute(args) {
    return JSON.stringify(getMemoryService().listVersions(memoryType(args.type), String(args.scopeId), String(args.key)), null, 2);
  },
};

export const memoryInvalidateTool: ToolHandler = {
  name: 'memory_invalidate',
  description: 'Invalidate one active memory entry while retaining its audit history.',
  source: 'builtin',
  isReadOnly: false,
  concurrentSafe: false,
  permissionLevel: 'none',
  priority: 'normal',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' }, reason: { type: 'string' } },
    required: ['id', 'reason'],
  },
  async execute(args) {
    return JSON.stringify(getMemoryService().invalidate(String(args.id), String(args.reason)), null, 2);
  },
};

export const memoryRollbackTool: ToolHandler = {
  name: 'memory_rollback',
  description: 'Restore an earlier memory version by creating a new monotonic version.',
  source: 'builtin',
  isReadOnly: false,
  concurrentSafe: false,
  permissionLevel: 'none',
  priority: 'normal',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: TYPES },
      scopeId: { type: 'string' },
      key: { type: 'string' },
      version: { type: 'number' },
    },
    required: ['type', 'scopeId', 'key', 'version'],
  },
  async execute(args) {
    return JSON.stringify(await getMemoryService().rollback(memoryType(args.type), String(args.scopeId), String(args.key), Number(args.version)), null, 2);
  },
};

export const memoryCompressTool: ToolHandler = {
  name: 'memory_compress',
  description: 'Compress active memories in one scope into an extractive consolidated version and supersede source entries.',
  source: 'builtin',
  isReadOnly: false,
  concurrentSafe: false,
  permissionLevel: 'none',
  priority: 'low',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: TYPES },
      scopeId: { type: 'string' },
      key: { type: 'string' },
      maxChars: { type: 'number' },
    },
    required: ['type', 'scopeId'],
  },
  async execute(args) {
    return JSON.stringify(await getMemoryService().compress({
      type: memoryType(args.type),
      scopeId: String(args.scopeId),
      key: args.key === undefined ? undefined : String(args.key),
      maxChars: args.maxChars === undefined ? undefined : Number(args.maxChars),
    }), null, 2);
  },
};

export const memoryTools: ToolHandler[] = [
  memorySearchTool,
  memoryWriteTool,
  memoryVersionsTool,
  memoryInvalidateTool,
  memoryRollbackTool,
  memoryCompressTool,
];
