import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

export interface SkillDependency {
  name: string;
  type: string;
  required: boolean;
}

export interface SkillMetadata {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  enabled: boolean;
  filePath: string;
  dependencies: SkillDependency[];
}

interface SkillRecord { meta: SkillMetadata; body: string }

function parseArray(value: string): string[] {
  const trimmed = value.trim();
  const raw = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return raw.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// M3 进阶-21: CRLF support + dependency parsing
export function parseSkillFile(content: string, filePath?: string): SkillRecord {
  const fp = filePath ?? '';
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  const fields = new Map<string, string>();
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (match) fields.set(match[1].toLowerCase(), match[2].trim());
    }
  }

  const name = fields.get('name')?.replace(/^['"]|['"]$/g, '') ?? basename(dirname(fp));
  const enabledValue = fields.get('enabled')?.toLowerCase();
  const statusValue = fields.get('status')?.toLowerCase();
  return {
    meta: {
      name,
      version: fields.get('version')?.replace(/^['"]|['"]$/g, '') ?? '0.0.0',
      description: fields.get('description')?.replace(/^['"]|['"]$/g, '') ?? '',
      triggers: parseArray(fields.get('triggers') ?? fields.get('trigger') ?? ''),
      enabled: enabledValue !== 'false' && statusValue !== 'disabled',
      filePath: fp,
      dependencies: frontmatter ? parseDependencies(frontmatter[1]) : [],
    },
    body,
  };
}

function parseDependencies(frontmatter: string): SkillDependency[] {
  const deps: SkillDependency[] = [];
  const sectionMatch = frontmatter.match(/dependencies:\s*\r?\n/);
  if (!sectionMatch || sectionMatch.index === undefined) return deps;
  const startIdx = sectionMatch.index + sectionMatch[0].length;
  const rest = frontmatter.slice(startIdx);
  for (const line of rest.split(/\r?\n/)) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) break;
    const m = line.match(/^\s*-\s*(env_var|mcp_server|tool):([A-Za-z0-9_]+)(\?)?\s*$/);
    if (m) {
      deps.push({
        name: m[2],
        type: m[1],
        required: m[3] !== '?',
      });
    }
  }
  return deps;
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
            const record = parseSkillFile(readFileSync(fullPath, 'utf-8'), fullPath);
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
