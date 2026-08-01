import { z } from 'zod';
import type { MemoryOp } from './types.js';

export const memoryOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('upsert'),
    type: z.enum(['working', 'project_semantic', 'task_trajectory', 'engineering_experience']),
    scopeId: z.string().min(1),
    key: z.string().min(1).max(200),
    content: z.string().min(1).max(4000),
    importance: z.number().min(0).max(1).optional(),
    dirPath: z.string().max(500).optional(),
  }),
  z.object({
    op: z.literal('delete'),
    scopeId: z.string().min(1),
    key: z.string().min(1).max(200),
  }),
]);

export const extractResponseSchema = z.object({
  ops: z.array(memoryOpSchema).max(8),
});

export function parseOps(json: string): MemoryOp[] | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    const validated = extractResponseSchema.safeParse(parsed);
    if (!validated.success) return null;
    return validated.data.ops as MemoryOp[];
  } catch {
    return null;
  }
}
