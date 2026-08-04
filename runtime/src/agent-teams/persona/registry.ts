/**
 * AgentTeams — M1.3 persona-picker + C1 注册接口（persona.list/get/pick）
 *
 * 影响层级 [C]：C1 人格库接口契约实现。
 * 接口契约：persona.list() / persona.pick(mission, k=3..5) / persona.get(id)
 *
 * 组队规则（方案〇·一节）：
 *   1. Manager 按使命定位开发环节 → 取该环节主责人格为 Worker 骨架
 *   2. picker 从议会辅助中选 3-5 视角注入
 *   3. picker 只在一/二梯队内选 —— 第三梯队内容类根本不入库，杜绝误选
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePersona } from './schema.js';
import type { PersonaRole, PersonaTier } from './types.js';

/** 开发环节 → 主责人格 id（方案〇·一 映射表主轴） */
export const STAGE_PRIMARY_PERSONA: Record<string, string> = {
  prd: 'drucker',
  spec: 'socrates',
  engineer: 'coder',
  'engineering-docs': 'docsmith',
  audit: 'verifier',
  cicd: 'coder',
  deploy: 'coder',
  bugfix: 'coder',
  'execution-check': 'verifier',
  retrospective: 'socrates',
};

/** 开发环节 → 议会辅助人格 id（方案〇·一 映射表） */
export const STAGE_COUNCIL_PERSONAS: Record<string, string[]> = {
  prd: ['sherlock', 'ansoff-porter'],
  spec: ['researcher'],
  engineer: ['analyst'],
  'engineering-docs': ['researcher'],
  audit: ['sherlock', 'socrates'],
  bugfix: ['sherlock'],
  'execution-check': ['socrates'],
  retrospective: ['verifier', 'general'],
};

function defaultPersonaDir(): string {
  if (process.env.AWKN_PERSONA_DIR) return resolve(process.env.AWKN_PERSONA_DIR);
  if (process.env.AWKN_ENGINE_ROOT) return join(resolve(process.env.AWKN_ENGINE_ROOT), 'agents', 'personas');
  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = resolve(here, '..', '..', '..');
  const candidate = resolve(runtimeRoot, '..');
  return existsSync(join(candidate, 'agents')) ? join(candidate, 'agents', 'personas') : join(runtimeRoot, 'agents', 'personas');
}

export interface PickResult {
  /** 主责人格（开发环节骨架对应） */
  primary: PersonaRole | null;
  /** 议会视角（含主责时去重） */
  council: PersonaRole[];
  /** 命中的开发环节 */
  stage: string | null;
}

export class PersonaRegistry {
  private personas = new Map<string, PersonaRole>();
  private loadedFrom: string | null = null;

  constructor(private readonly dir: string = defaultPersonaDir()) {}

  /** 从 agents/personas/*.json 加载（懒加载；缺失时目录为空，不抛错） */
  load(): void {
    this.personas.clear();
    if (!existsSync(this.dir)) {
      this.loadedFrom = this.dir;
      return;
    }
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json') || file === 'personas.json' || file === 'absorb-record.json') continue;
      const raw = JSON.parse(readFileSync(join(this.dir, file), 'utf-8'));
      const persona = validatePersona(raw);
      this.personas.set(persona.id, persona);
    }
    this.loadedFrom = this.dir;
  }

  private ensureLoaded(): void {
    if (this.loadedFrom === null) this.load();
  }

  /** persona.list()：全部已入库人格（只有一/二梯队 —— 三梯队不入库） */
  list(): PersonaRole[] {
    this.ensureLoaded();
    return [...this.personas.values()].sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));
  }

  /** persona.get(id) */
  get(id: string): PersonaRole | undefined {
    this.ensureLoaded();
    return this.personas.get(id);
  }

  /**
   * persona.pick(mission, k=3..5)：按使命选编视角议会。
   * 打分：关键词命中（keywords/responsibilities/name）+ 环节主责加权。
   * 只返回一/二梯队（入库即保证），最多 k 个。
   */
  pick(mission: string, k = 4): PickResult {
    this.ensureLoaded();
    const kk = Math.min(Math.max(k, 1), 8);
    const stage = this.detectStage(mission);
    const primaryId = stage ? STAGE_PRIMARY_PERSONA[stage] : undefined;
    const primary = primaryId ? this.personas.get(primaryId) ?? null : null;

    const scores = new Map<string, number>();
    for (const p of this.personas.values()) {
      let score = 0;
      for (const kw of p.keywords) {
        if (kw && mission.toLowerCase().includes(kw.toLowerCase())) score += 2;
      }
      for (const resp of p.responsibilities ?? []) {
        if (mission.includes(resp)) score += 1;
      }
      if (mission.includes(p.name)) score += 3;
      if (stage && p.capabilities.includes(stage)) score += 4;
      if (stage && (STAGE_COUNCIL_PERSONAS[stage] ?? []).includes(p.id)) score += 2;
      if (p.id === primaryId) score += 6;
      scores.set(p.id, score);
    }

    const ranked = [...this.personas.values()]
      .filter((p) => p.tier === 1 || p.tier === 2)
      .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || a.id.localeCompare(b.id));

    const council: PersonaRole[] = [];
    if (primary) council.push(primary);
    for (const p of ranked) {
      if (council.length >= kk) break;
      if (!council.some((c) => c.id === p.id)) council.push(p);
    }
    return { primary, council: council.slice(0, kk), stage };
  }

  /** 使命 → 开发环节定位（关键词匹配 capabilities 环节名） */
  detectStage(mission: string): string | null {
    const text = mission.toLowerCase();
    const stageHints: Array<[string, string[]]> = [
      ['retrospective', ['复盘', '回顾', 'retrospective']],
      ['execution-check', ['执行检查', '改前检查', 'execution-check']],
      ['engineering-docs', ['文档', '技术方案', 'engineering-docs']],
      ['bugfix', ['修复', 'bug', 'bugfix', '缺陷']],
      ['deploy', ['部署', '上线', 'deploy']],
      ['cicd', ['cicd', 'ci/cd', '持续集成', '流水线']],
      ['audit', ['审核', '审查', 'review', 'audit', '代码评审']],
      ['spec', ['规格', 'spec', '接口设计', '详细设计']],
      ['prd', ['需求', 'prd', '产品定义', '产品需求']],
      ['engineer', ['实现', '开发', '编码', '构建功能', 'engineer', 'build']],
    ];
    for (const [stage, hints] of stageHints) {
      if (hints.some((h) => text.includes(h.toLowerCase()))) return stage;
    }
    return null;
  }

  /** 按梯队过滤 */
  byTier(tier: PersonaTier): PersonaRole[] {
    this.ensureLoaded();
    return this.list().filter((p) => p.tier === tier);
  }
}

let singleton: PersonaRegistry | null = null;

export function getPersonaRegistry(): PersonaRegistry {
  if (!singleton) singleton = new PersonaRegistry();
  return singleton;
}

/** persona.* 接口契约门面 */
export const persona = {
  list: (): PersonaRole[] => getPersonaRegistry().list(),
  get: (id: string): PersonaRole | undefined => getPersonaRegistry().get(id),
  pick: (mission: string, k = 4): PickResult => getPersonaRegistry().pick(mission, k),
};
