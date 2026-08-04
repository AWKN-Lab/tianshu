/**
 * AgentTeams — M1.1 persona-schema（接口部分）
 *
 * 影响层级 [M]：C1 人格库入库门禁。字段缺失/非法 → 拒绝入库。
 * 契约对齐 awkn-agent PersonaRole + 引擎扩展字段 tier/capabilities/keywords。
 */
import { z } from 'zod';
import type { PersonaRole } from './types.js';

export const thinkingModelSchema = z.object({
  name: z.string().min(1),
  when: z.string().min(1),
  keyQuestion: z.string().min(1),
});

export const collaborationMapSchema = z.object({
  upstream: z.array(z.string()).default([]),
  downstream: z.array(z.string()).default([]),
  feedbackFrom: z.array(z.string()).default([]),
});

export const personaTraitsSchema = z
  .object({
    openness: z.number().min(0).max(1).optional(),
    conscientiousness: z.number().min(0).max(1).optional(),
    extraversion: z.number().min(0).max(1).optional(),
    agreeableness: z.number().min(0).max(1).optional(),
    neuroticism: z.number().min(0).max(1).optional(),
    formality: z.number().min(0).max(1).optional(),
    humor: z.number().min(0).max(1).optional(),
    proactivity: z.number().min(0).max(1).optional(),
  })
  .strict();

export const personaSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'id 必须为小写字母数字短横线'),
    name: z.string().min(1, 'name（中文职能名）必填'),
    systemPrompt: z.string().min(10, 'systemPrompt 不得为空'),
    personalityTraits: personaTraitsSchema,
    busyHours: z.tuple([z.number(), z.number()]).optional(),
    declineRate: z.number().min(0).max(1),
    avatar: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    concurrentCompatible: z.array(z.string()).optional(),
    memoryIsolation: z.boolean().optional(),
    thinkingModels: z.array(thinkingModelSchema).optional(),
    collaboration: collaborationMapSchema.optional(),
    boundaries: z.array(z.string()).optional(),
    responsibilities: z.array(z.string()).optional(),
    stopConditions: z.array(z.string()).optional(),
    sourceAgent: z.string().optional(),
    category: z.enum(['core', 'technical', 'business', 'functional', 'creative', 'general']).optional(),
    isHero: z.boolean().optional(),
    displayName: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    capabilities: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
  })
  .strict();

/**
 * 校验单个人格定义。
 * @throws 字段缺失/非法时抛错（拒绝入库）
 */
export function validatePersona(raw: unknown): PersonaRole {
  return personaSchema.parse(raw) as PersonaRole;
}

/** 安全校验：返回问题清单（空=通过） */
export function checkPersona(raw: unknown): { ok: boolean; errors: string[] } {
  const result = personaSchema.safeParse(raw);
  if (result.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
  };
}
