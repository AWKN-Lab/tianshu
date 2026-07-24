import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface SkillMetadata {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  enabled: boolean;
  filePath: string;
}

interface SkillRecord { meta: SkillMetadata; body: string }

function parseArray(value: string): string[] {
  const trimmed = value.trim();
  const raw = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return raw.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function parseSkillFile(filePath: string): SkillRecord {
  const content = readFileSync(filePath, 'utf-8');
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  const fields = new Map<string, string>();
  if (frontmatter) {
    for (const line of frontmatter[1].split('\n')) {
      const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (match) fields.set(match[1].toLowerCase(), match[2].trim());
    }
  }

  const name = fields.get('name')?.replace(/^['"]|['"]$/g, '') ?? basename(dirname(filePath));
  const enabledValue = fields.get('enabled')?.toLowerCase();
  const statusValue = fields.get('status')?.toLowerCase();
  return {
    meta: {
      name,
      version: fields.get('version')?.replace(/^['"]|['"]$/g, '') ?? '0.0.0',
      description: fields.get('description')?.replace(/^['"]|['"]$/g, '') ?? '',
      triggers: parseArray(fields.get('triggers') ?? fields.get('trigger') ?? ''),
      enabled: enabledValue !== 'false' && statusValue !== 'disabled',
      filePath,
    },
    body,
  };
}

export class SkillsManager {
  private readonly records = new Map<string, SkillRecord>();
  constructor(private rootDir: string) {}

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
  const resolvedRoot = resolve(rootDir ?? process.env.AWKN_SKILLS_ROOT ?? process.env.SKILLS_DIR ?? join(process.cwd(), 'skills'));
  if (!instance) instance = new SkillsManager(resolvedRoot);
  else if (rootDir) instance.setRoot(resolvedRoot);
  return instance;
}
