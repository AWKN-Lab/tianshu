/**
 * M3 进阶-21: Skill file parser with CRLF support
 *
 * Bug: original parseSkillFile in manager.ts used \n-only regex for frontmatter
 *   → CRLF (Windows) SKILL.md files silently failed to parse frontmatter
 *   → dependencies field was lost → skills silently ran without required deps
 * Fix: use \r?\n in all regexes to support both LF and CRLF line endings
 */

export interface SkillDependency {
  type: 'env_var' | 'mcp_server' | 'tool';
  name: string;
  required: boolean;
}

export interface ParsedSkillMeta {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  enabled: boolean;
  proactive: boolean;
  dependencies: SkillDependency[];
}

export interface ParsedSkillFile {
  meta: ParsedSkillMeta;
  body: string;
}

function parseArray(value: string): string[] {
  const trimmed = value.trim();
  const raw = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return raw.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// M3 进阶-21: parseDependencies — 支持 CRLF 行尾的依赖解析
function parseDependencies(frontmatter: string): SkillDependency[] {
  const deps: SkillDependency[] = [];
  // 匹配 dependencies: 字段后的列表项（支持 \r?\n）
  const sectionMatch = frontmatter.match(/dependencies:\s*\r?\n([\s\S]*?)(?=\r?\n\S|$)/);
  if (!sectionMatch) return deps;

  const section = sectionMatch[1];
  // 每行格式: "  - env_var:NAME?" 或 "  - mcp_server:NAME?" 或 "  - tool:NAME?"
  const lines = section.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*-\s*(env_var|mcp_server|tool):([^\s?]+)(\?)?/);
    if (match) {
      deps.push({
        type: match[1] as SkillDependency['type'],
        name: match[2]!,
        required: match[3] !== '?',
      });
    }
  }
  return deps;
}

export function parseSkillFile(content: string): ParsedSkillFile {
  // M3 进阶-21: frontmatter 正则支持 CRLF（\r?\n）
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = frontmatter ? content.slice(frontmatter[0].length).replace(/^[\r\n]+/, '') : content;

  const fields = new Map<string, string>();
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (match) fields.set(match[1].toLowerCase(), match[2].trim());
    }
  }

  const name = fields.get('name')?.replace(/^['"]|['"]$/g, '') ?? '';
  const enabledValue = fields.get('enabled')?.toLowerCase();
  const statusValue = fields.get('status')?.toLowerCase();
  const proactiveValue = fields.get('proactive')?.toLowerCase();

  return {
    meta: {
      name,
      version: fields.get('version')?.replace(/^['"]|['"]$/g, '') ?? '0.0.0',
      description: fields.get('description')?.replace(/^['"]|['"]$/g, '') ?? '',
      triggers: parseArray(fields.get('triggers') ?? fields.get('trigger') ?? ''),
      enabled: enabledValue !== 'false' && statusValue !== 'disabled',
      proactive: proactiveValue === 'true',
      // M3 进阶-21: dependencies section 正则支持 CRLF
      dependencies: frontmatter ? parseDependencies(frontmatter[1]) : [],
    },
    body,
  };
}
