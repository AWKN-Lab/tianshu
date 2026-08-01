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
        if (entry === '.git' || entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
        const fullPath = join(dir, entry);
        let stat: ReturnType<typeof statSync>;
        try { stat = statSync(fullPath); } catch { continue; }
        if (stat.isDirectory()) walk(fullPath, depth + 1);
        else if (stat.isFile() && entry.toLowerCase() === 'skill.md') {
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
