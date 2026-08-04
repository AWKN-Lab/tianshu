/**
 * AgentTeams — M3.1 worker-manifest
 *
 * 影响层级 [M]：capabilities/project 13 角色 → Worker 工种骨架映射。
 * Worker = capability 工种骨架 × PersonaRole 视角人格（吸收映射规则 5）。
 * 骨架只定义职责入口与卡片路径；工具白名单沿用 capability manifest（不扩张授权）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WorkerSkeleton {
  /** capability 环节 id */
  capability: string;
  /** 中文名 */
  label: string;
  /** 能力卡相对路径（capabilities/project/...） */
  cardPath: string;
  /** 完整参考相对路径 */
  referencePath?: string;
}

/** 对齐 capabilities/project/manifest.yaml 的 13 角色 */
export const WORKER_MANIFEST: Record<string, WorkerSkeleton> = {
  tianhuo: { capability: 'tianhuo', label: '天火编排', cardPath: 'project/tianhuo/card.md' },
  tianjie: { capability: 'tianjie', label: '天阶功法', cardPath: 'project/tianjie/card.md' },
  'execution-check': { capability: 'execution-check', label: '执行检查', cardPath: 'project/execution-check/card.md' },
  engineer: { capability: 'engineer', label: '工程师', cardPath: 'project/cards/engineer.md', referencePath: 'project/engineer/reference.md' },
  cicd: { capability: 'cicd', label: 'CICD', cardPath: 'project/cards/cicd.md', referencePath: 'project/cicd/reference.md' },
  bugfix: { capability: 'bugfix', label: '缺陷修复', cardPath: 'project/cards/bugfix.md', referencePath: 'project/bugfix/reference.md' },
  audit: { capability: 'audit', label: '独立审核', cardPath: 'project/cards/audit.md', referencePath: 'project/audit/reference.md' },
  deploy: { capability: 'deploy', label: '部署', cardPath: 'project/cards/deploy.md', referencePath: 'project/deploy/reference.md' },
  prd: { capability: 'prd', label: '产品需求', cardPath: 'project/prd/card.md', referencePath: 'project/prd/reference.md' },
  spec: { capability: 'spec', label: '规格', cardPath: 'project/spec/card.md', referencePath: 'project/spec/reference.md' },
  'engineering-docs': { capability: 'engineering-docs', label: '工程文档', cardPath: 'project/engineering-docs/card.md' },
  retrospective: { capability: 'retrospective', label: '复盘', cardPath: 'project/retrospective/card.md' },
  cards: { capability: 'cards', label: '能力卡', cardPath: 'project/cards/engineer.md' },
};

function defaultCapabilitiesRoot(): string {
  if (process.env.AWKN_CAPABILITIES_ROOT) return resolve(process.env.AWKN_CAPABILITIES_ROOT);
  if (process.env.AWKN_ENGINE_ROOT) return join(resolve(process.env.AWKN_ENGINE_ROOT), 'capabilities');
  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = resolve(here, '..', '..', '..');
  const candidate = resolve(runtimeRoot, '..');
  return existsSync(join(candidate, 'capabilities')) ? join(candidate, 'capabilities') : join(runtimeRoot, 'capabilities');
}

/** 读取 Worker 骨架的能力卡内容（缺失返回 null） */
export function loadSkeletonCard(capability: string, capabilitiesRoot?: string): string | null {
  const skeleton = WORKER_MANIFEST[capability];
  if (!skeleton) return null;
  const root = capabilitiesRoot ?? defaultCapabilitiesRoot();
  const cardFile = join(root, skeleton.cardPath);
  if (!existsSync(cardFile)) return null;
  return readFileSync(cardFile, 'utf-8');
}

/** 取骨架定义 */
export function getSkeleton(capability: string): WorkerSkeleton | undefined {
  return WORKER_MANIFEST[capability];
}
