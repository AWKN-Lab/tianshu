/**
 * AgentTeams — M1.2 persona-importer
 *
 * 影响层级 [M]：把精选人格目录（忠实吸收自 awkn-agent src/persona/）
 * 落库为 `agents/personas/<id>.json` + `<id>.prompt.md` + 索引 `personas.json`。
 *
 * 状态：imported（新写入/更新）/ skipped（内容无变化）。
 * 异常：重名 id → 抛错提示合并；schema 校验失败 → 拒绝入库。
 *
 * CLI：cd runtime && npx tsx src/agent-teams/persona/importer.ts [targetDir]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePersona } from './schema.js';
import { PERSONA_CATALOG } from './catalog.js';
import type { PersonaIndex, PersonaRole } from './types.js';

export type ImportStatus = 'imported' | 'skipped';

export interface ImportResult {
  id: string;
  name: string;
  tier: number;
  status: ImportStatus;
  jsonPath: string;
  promptPath: string;
}

/** 解析引擎根目录（runtime/ 的上一级） */
function resolveEngineRoot(): string {
  if (process.env.AWKN_ENGINE_ROOT) return resolve(process.env.AWKN_ENGINE_ROOT);
  const here = dirname(fileURLToPath(import.meta.url));
  // src/agent-teams/persona → runtime → engineRoot
  const runtimeRoot = resolve(here, '..', '..', '..');
  const candidate = resolve(runtimeRoot, '..');
  return existsSync(join(candidate, 'agents')) ? candidate : runtimeRoot;
}

/** 由人格定义渲染注入用 prompt 文件（人格段，Worker prompt 头） */
export function renderPersonaPrompt(p: PersonaRole): string {
  const lines: string[] = [];
  lines.push(`# 人格：${p.name}${p.displayName ? `（${p.displayName}）` : ''}`);
  lines.push('');
  lines.push('## 角色定位');
  lines.push(p.systemPrompt);
  if (p.responsibilities?.length) {
    lines.push('');
    lines.push('## 职责');
    for (const r of p.responsibilities) lines.push(`- ${r}`);
  }
  if (p.boundaries?.length) {
    lines.push('');
    lines.push('## 边界（严格遵守，防越权）');
    for (const b of p.boundaries) lines.push(`- ${b}`);
  }
  if (p.thinkingModels?.length) {
    lines.push('');
    lines.push('## 思维模型（推理脚手架）');
    for (const t of p.thinkingModels) lines.push(`- ${t.name}（${t.when}）：${t.keyQuestion}`);
  }
  if (p.stopConditions?.length) {
    lines.push('');
    lines.push('## 停止条件');
    for (const s of p.stopConditions) lines.push(`- ${s}`);
  }
  if (p.sourceAgent) {
    lines.push('');
    lines.push(`> 吸收溯源：${p.sourceAgent}（awkn-agent persona 精选吸收）`);
  }
  lines.push('');
  return lines.join('\n');
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * 导入精选人格到目标目录（默认 <engineRoot>/agents/personas/）。
 * 第三梯队（内容创作）不在目录中，天然不入库。
 */
export function importPersonas(targetDir?: string): ImportResult[] {
  const root = resolveEngineRoot();
  const outDir = targetDir ? resolve(targetDir) : join(root, 'agents', 'personas');
  mkdirSync(outDir, { recursive: true });

  const seenIds = new Set<string>();
  const results: ImportResult[] = [];

  for (const raw of PERSONA_CATALOG) {
    const persona = validatePersona(raw); // 字段缺失 → 拒绝入库（抛错）
    if (seenIds.has(persona.id)) {
      throw new Error(`[persona-importer] 重名人格 id=${persona.id}，请先合并再导入`);
    }
    seenIds.add(persona.id);

    const jsonPath = join(outDir, `${persona.id}.json`);
    const promptPath = join(outDir, `${persona.id}.prompt.md`);
    const jsonBody = `${JSON.stringify(persona, null, 2)}\n`;
    const promptBody = renderPersonaPrompt(persona);

    let status: ImportStatus = 'imported';
    if (existsSync(jsonPath) && existsSync(promptPath)) {
      const sameJson = normalizeNewlines(readFileSync(jsonPath, 'utf-8')) === normalizeNewlines(jsonBody);
      const samePrompt = normalizeNewlines(readFileSync(promptPath, 'utf-8')) === normalizeNewlines(promptBody);
      if (sameJson && samePrompt) status = 'skipped';
    }
    if (status === 'imported') {
      writeFileSync(jsonPath, jsonBody, 'utf-8');
      writeFileSync(promptPath, promptBody, 'utf-8');
    }
    results.push({ id: persona.id, name: persona.name, tier: persona.tier, status, jsonPath, promptPath });
  }

  // 写索引
  const index: PersonaIndex = {
    schema: 'awkn-persona-index/v1',
    updatedAt: new Date().toISOString(),
    personas: PERSONA_CATALOG.map((p) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      category: p.category,
      capabilities: p.capabilities,
    })),
  };
  writeFileSync(join(outDir, 'personas.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf-8');

  // C6 吸收治理接入：人格入库评测记录（schema 校验门禁 + 梯队处置 + 溯源）
  const absorbRecord = {
    schema: 'awkn-persona-absorb-record/v1',
    recordedAt: new Date().toISOString(),
    pipeline: 'absorb-eval（schema 校验门禁）→ absorb-auto（落库）',
    gate: 'PersonaRole JSON Schema strict 校验；字段缺失/重名 → 拒绝入库',
    tiers: {
      tier1: { policy: '必吸·开发核心', count: results.filter((r) => r.tier === 1).length },
      tier2: { policy: '可选·决策增强', count: results.filter((r) => r.tier === 2).length },
      tier3: { policy: '暂缓·内容创作（未入库）', count: 0 },
    },
    personas: results.map((r) => ({
      id: r.id,
      name: r.name,
      tier: r.tier,
      status: r.status,
      sourceAgent: PERSONA_CATALOG.find((p) => p.id === r.id)?.sourceAgent ?? null,
      schemaValidated: true,
    })),
  };
  writeFileSync(join(outDir, 'absorb-record.json'), `${JSON.stringify(absorbRecord, null, 2)}\n`, 'utf-8');

  return results;
}

/** CLI 入口 */
if (process.argv[1] && process.argv[1].includes('agent-teams')) {
  const target = process.argv[2];
  const results = importPersonas(target);
  const core = results.filter((r) => r.tier === 1).length;
  const optional = results.filter((r) => r.tier === 2).length;
  console.log(`[persona-importer] 导入完成：核心 ${core} + 可选 ${optional}（第三梯队内容类未吸收）`);
  for (const r of results) {
    console.log(`  - ${r.status === 'imported' ? '✅' : '⏭️'} [tier${r.tier}] ${r.name}(${r.id}) → ${r.jsonPath}`);
  }
}
