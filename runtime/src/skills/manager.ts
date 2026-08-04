import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFile as parseSkillContent } from './parser.js';
import {
  CapabilityCard,
  loadCapabilityManifest,
  resolveDefaultCapabilitiesRoot,
} from './capability-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

export interface SkillMetadata {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  enabled: boolean;
  filePath: string;
}

interface SkillRecord { meta: SkillMetadata; body: string }

function parseSkillFile(filePath: string): SkillRecord {
  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseSkillContent(content);
  const name = parsed.meta.name || basename(dirname(filePath));
  return {
    meta: {
      name,
      version: parsed.meta.version,
      description: parsed.meta.description,
      triggers: parsed.meta.triggers,
      enabled: parsed.meta.enabled,
      filePath,
    },
    body: parsed.body,
  };
}

export function resolveDefaultSkillsRoot(): string {
  return resolve(process.env.AWKN_SKILLS_ROOT ?? process.env.SKILLS_DIR ?? join(PROJECT_ROOT, 'skills'));
}

/**
 * 技能扫描忽略目录（2026-08-04 治本）
 *
 * 背景：此前忽略列表只有 .git/node_modules/dist/build，导致：
 *  - 退役技能移进 `_archived/` 后仍被 loadAll() 递归收录，"退役"不生效，
 *    只能靠把 SKILL.md 改名成 SKILL.asset.md 来绕过，属于治标。
 *  - `draft/` 下的草稿技能会混进正式索引，被 skill list / match 当成可用技能。
 *  - Python 工具链产生的 `__pycache__/` 等噪音目录被无谓遍历。
 *
 * 规则：目录名命中黑名单，或以下划线 `_` 开头（`_archived`/`_backup`/`_tmp` 等
 * 归档与临时目录的统一约定），一律不再向下递归。
 *
 * 注意：**不**忽略以 `.` 开头的目录 —— `skills/.system/` 下存放 skill-creator、
 * skilldeck-bridge 等内置技能，且被 awkn-技能治理 引用，忽略会造成断链。
 */
export const SKILL_SCAN_IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'venv',
  '.venv',
  '.pytest_cache',
  '__pycache__',
  '_archived',
  'draft',
  // 父技能"吸收"的第三方子技能素材区：仅作为父技能的路由目标按文件路径读取，
  // 不应作为独立一级技能进入索引。既有惯例是把子技能主文件改名 SKILL.sub.md
  // （见 awkn-game/absorbed-skills/），此处从扫描层统一兜底，避免新导入的
  // 市场技能包（内含 skills/*/SKILL.md）污染 skill list 与 skill match。
  'absorbed-skills',
]);

/** 判断某个目录名是否应跳过技能扫描 */
export function isSkillScanIgnoredDir(name: string): boolean {
  return SKILL_SCAN_IGNORED_DIRS.has(name) || name.startsWith('_');
}

export class SkillsManager {
  private readonly records = new Map<string, SkillRecord>();
  /** capability id → CapabilityCard(独立命名空间,不与 SKILL.md 冲突) */
  private readonly capabilities = new Map<string, CapabilityCard>();
  private capabilitiesRoot: string | null = null;
  constructor(private rootDir: string) { this.rootDir = resolve(rootDir); }

  getRoot(): string { return this.rootDir; }

  setRoot(rootDir: string): void {
    this.rootDir = resolve(rootDir);
    this.records.clear();
    // 注意:capability 缓存不随 skillsRoot 变化清除,因为 capabilities 目录独立
  }

  loadAll(): SkillMetadata[] {
    this.records.clear();
    const root = resolve(this.rootDir);
    if (!existsSync(root)) return [];

    const walk = (dir: string, depth: number): void => {
      if (depth > 12) return;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        let stat: ReturnType<typeof statSync>;
        try { stat = statSync(fullPath); } catch { continue; }
        if (stat.isDirectory()) {
          if (isSkillScanIgnoredDir(entry)) continue;
          walk(fullPath, depth + 1);
        } else if (stat.isFile() && entry.toLowerCase() === 'skill.md') {
          try {
            const record = parseSkillFile(fullPath);
            this.records.set(record.meta.name, record);
          } catch { /* malformed third-party skill: skip */ }
        }
      }
    };

    walk(root, 0);
    return this.getActiveSkills();
  }

  /**
   * 加载 capabilities 目录下的 manifest.yaml,校验 content_hash 并缓存。
   * 与 loadAll() 独立,允许只调其中一个。
   * 失败语义:hash 不匹配会抛错(参考 capability-loader.ts)。
   */
  loadCapabilities(capabilitiesRoot?: string): CapabilityCard[] {
    const root = resolve(capabilitiesRoot ?? resolveDefaultCapabilitiesRoot());
    this.capabilitiesRoot = root;
    this.capabilities.clear();
    const { capabilities } = loadCapabilityManifest(root);
    for (const cap of capabilities) {
      this.capabilities.set(cap.id, cap);
    }
    return this.getCapabilities();
  }

  /** 列出所有已加载的 capability(不依赖 loadAll,但需先调 loadCapabilities) */
  getCapabilities(): CapabilityCard[] {
    return [...this.capabilities.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 按 id 取 capability(支持 alias 命中) */
  getCapability(idOrAlias: string): CapabilityCard | null {
    if (this.capabilities.has(idOrAlias)) return this.capabilities.get(idOrAlias)!;
    for (const cap of this.capabilities.values()) {
      if (cap.aliases.includes(idOrAlias)) return cap;
    }
    return null;
  }

  /** 取 capability 的 card.md 文本 */
  getCapabilityCard(idOrAlias: string): string | null {
    return this.getCapability(idOrAlias)?.cardBody ?? null;
  }

  /** 取 capability 的 reference.md 文本(若声明) */
  getCapabilityReference(idOrAlias: string): string | null {
    return this.getCapability(idOrAlias)?.referenceBody ?? null;
  }

  /** 当前 capabilities 根目录(已加载时) */
  getCapabilitiesRoot(): string | null { return this.capabilitiesRoot; }

  getActiveSkills(): SkillMetadata[] {
    return [...this.records.values()].map((record) => record.meta)
      .filter((meta) => meta.enabled).sort((a, b) => a.name.localeCompare(b.name));
  }

  getSkill(name: string): SkillMetadata | null { return this.records.get(name)?.meta ?? null; }
  getSkillBody(name: string): string | null { return this.records.get(name)?.body ?? null; }

  matchTriggers(userInput: string): SkillMetadata[] {
    const normalized = userInput.toLowerCase();
    return this.getActiveSkills().filter((skill) =>
      normalized.includes(skill.name.toLowerCase())
      || skill.triggers.some((trigger) => normalized.includes(trigger.toLowerCase())),
    );
  }
}

let instance: SkillsManager | null = null;
export function getSkillsManager(rootDir?: string): SkillsManager {
  const resolvedRoot = resolve(rootDir ?? resolveDefaultSkillsRoot());
  if (!instance) instance = new SkillsManager(resolvedRoot);
  else if (instance.getRoot() !== resolvedRoot) instance.setRoot(resolvedRoot);
  return instance;
}
