import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFile as parseSkillContent } from './parser.js';

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
  constructor(private rootDir: string) { this.rootDir = resolve(rootDir); }

  getRoot(): string { return this.rootDir; }

  setRoot(rootDir: string): void {
    this.rootDir = resolve(rootDir);
    this.records.clear();
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
