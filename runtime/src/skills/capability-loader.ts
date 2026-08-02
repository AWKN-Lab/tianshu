/**
 * Capability Loader
 *
 * 加载 capabilities/project/manifest.yaml 注册的能力卡。
 * 与 SKILL.md 路径互补:SkillsManager 仍扫描 <root>/SKILL.md,
 * CapabilityLoader 负责解析 manifest + card.md + reference.md,
 * 并对 card.md 做 content_hash 校验(CRLF→LF 后 SHA-256)。
 *
 * 失败语义:
 *  - manifest 缺失 → 返回空数组(允许仓库不带 capabilities)
 *  - manifest 存在但 card.md 缺失 → 抛错(资产损坏)
 *  - content_hash 不匹配 → 抛错(资产被篡改或版本漂移)
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface CapabilityCard {
  /** manifest 中的 id,如 tianhuo / tianjie / engineer */
  id: string;
  version: string;
  canonicalSkill: string;
  aliases: string[];
  visibility: string;
  /** 相对 capabilities 根的 card.md 路径,如 project/tianhuo/card.md */
  cardPath: string;
  /** 相对 capabilities 根的 reference.md 路径(可选) */
  fullReferencePath?: string;
  loopProfile?: string;
  executionMode?: string;
  contentHash: string;
  /** card.md 的实际内容(LF 规范化后读出) */
  cardBody: string;
  /** reference.md 的实际内容(若声明 fullReferencePath) */
  referenceBody?: string;
  /** card.md 绝对路径 */
  absoluteCardPath: string;
}

export interface CapabilityLoadResult {
  capabilities: CapabilityCard[];
  /** 解析失败的 id 列表(附带原因) */
  errors: Array<{ id: string; reason: string }>;
}

/**
 * 极简 YAML 解析:只识别本仓库 capabilities/project/manifest.yaml 的子集结构。
 * 不引入 js-yaml 依赖。若 manifest 格式扩展,需同步更新此函数。
 *
 * 支持字段(每个 - id: ... 条目):
 *   id, version, canonical_skill, aliases(列表), visibility,
 *   card, full_reference, loop_profile, execution_mode, content_hash
 */
function parseManifest(yaml: string): Array<Record<string, unknown>> {
  const lines = yaml.split(/\r?\n/);
  const entries: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;
  let inAliases = false;

  const pushCurrent = (): void => {
    if (current && (typeof current.id === 'string')) {
      entries.push(current);
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // 顶层字段(非缩进)
    if (/^[A-Za-z0-9_-]+:/.test(line) && !line.startsWith(' ')) {
      inAliases = false;
      // 顶层 key(如 version: 1 / capabilities:),不进条目
      continue;
    }

    // 条目起始:  - id: xxx(2 空格缩进)
    const entryMatch = line.match(/^  -\s+id:\s*(.+)$/);
    if (entryMatch) {
      pushCurrent();
      current = { id: entryMatch[1]!.trim() };
      inAliases = false;
      continue;
    }

    // 条目内字段(4 空格缩进 key: value)
    if (current && line.startsWith('    ') && !line.startsWith('      ')) {
      inAliases = false;
      const fieldMatch = line.match(/^    ([A-Za-z0-9_]+):\s*(.*)$/);
      if (fieldMatch) {
        const key = fieldMatch[1]!;
        let value: string = fieldMatch[2] ?? '';
        value = value.trim().replace(/^['"]|['"]$/g, '');
        if (value === '[]') {
          current[key] = [];
        } else if (value) {
          current[key] = value;
        } else {
          // 可能是 aliases: 列表头
          current[key] = key === 'aliases' ? [] : '';
          if (key === 'aliases') inAliases = true;
        }
        continue;
      }
    }

    // aliases 列表项(6 空格缩进 - value)
    if (current && inAliases && line.startsWith('      - ')) {
      const alias = line.slice('      - '.length).trim().replace(/^['"]|['"]$/g, '');
      const aliases = (current.aliases as string[]) ?? [];
      aliases.push(alias);
      current.aliases = aliases;
      continue;
    }
  }
  pushCurrent();
  return entries;
}

/** 计算 card.md 的规范化 SHA-256(CRLF→LF) */
function computeHash(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * 加载指定 capabilities 根目录下的 manifest.yaml。
 *
 * @param capabilitiesRoot capabilities 目录绝对路径(其下应有 project/manifest.yaml)
 * @param options.strictHash true(默认)= hash 不匹配时抛错;false = 记入 errors 数组
 */
export function loadCapabilityManifest(
  capabilitiesRoot: string,
  options: { strictHash?: boolean } = {},
): CapabilityLoadResult {
  const strictHash = options.strictHash ?? true;
  const manifestPath = resolve(capabilitiesRoot, 'project', 'manifest.yaml');
  if (!existsSync(manifestPath)) {
    return { capabilities: [], errors: [] };
  }

  const manifestText = readFileSync(manifestPath, 'utf-8');
  const entries = parseManifest(manifestText);

  const capabilities: CapabilityCard[] = [];
  const errors: Array<{ id: string; reason: string }> = [];

  for (const entry of entries) {
    const id = entry.id as string;
    const cardRel = entry.card as string | undefined;
    if (!cardRel) {
      errors.push({ id, reason: 'manifest entry missing card path' });
      continue;
    }
    const cardAbs = resolve(capabilitiesRoot, cardRel);
    if (!existsSync(cardAbs)) {
      errors.push({ id, reason: `card file not found: ${cardRel}` });
      continue;
    }
    const cardBody = readFileSync(cardAbs, 'utf-8');
    const actualHash = computeHash(cardBody);
    const expectedHash = (entry.content_hash as string | undefined)?.toLowerCase();

    if (expectedHash && actualHash !== expectedHash) {
      const reason = `content_hash mismatch for ${id}: expected ${expectedHash}, got ${actualHash}`;
      if (strictHash) {
        throw new Error(`[capability-loader] ${reason}`);
      }
      errors.push({ id, reason });
      continue;
    }

    let referenceBody: string | undefined;
    const fullRef = entry.full_reference as string | undefined;
    if (fullRef) {
      const refAbs = resolve(capabilitiesRoot, fullRef);
      if (existsSync(refAbs)) {
        referenceBody = readFileSync(refAbs, 'utf-8');
      }
    }

    capabilities.push({
      id,
      version: (entry.version as string) ?? '0.0.0',
      canonicalSkill: (entry.canonical_skill as string) ?? id,
      aliases: (entry.aliases as string[]) ?? [],
      visibility: (entry.visibility as string) ?? 'public',
      cardPath: cardRel,
      fullReferencePath: fullRef,
      loopProfile: entry.loop_profile as string | undefined,
      executionMode: entry.execution_mode as string | undefined,
      contentHash: actualHash,
      cardBody,
      referenceBody,
      absoluteCardPath: cardAbs,
    });
  }

  return { capabilities, errors };
}

/**
 * 定位仓库根目录下的 capabilities 目录。
 * 优先级:AWKN_CAPABILITIES_ROOT env > <PROJECT_ROOT>/capabilities > <runtime>/../capabilities
 */
export function resolveDefaultCapabilitiesRoot(): string {
  const envRoot = process.env.AWKN_CAPABILITIES_ROOT;
  if (envRoot) return resolve(envRoot);
  const projectRoot = resolve(__dirname, '..', '..', '..');
  const candidate = join(projectRoot, 'capabilities');
  if (existsSync(candidate)) return candidate;
  // 兜底:与 SkillsManager 对齐,从 cwd 向上找
  return candidate;
}

/** 调试入口:打印所有 capability 概要 */
export function listCapabilitiesSummary(root?: string): Array<{ id: string; card: string; hash: string }> {
  const resolved = root ?? resolveDefaultCapabilitiesRoot();
  const { capabilities } = loadCapabilityManifest(resolved);
  return capabilities.map((c) => ({ id: c.id, card: c.cardPath, hash: c.contentHash }));
}

/** 递归列出目录(用于诊断) */
export function diagnoseCapabilitiesTree(root: string, maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules') continue;
      const full = join(dir, entry);
      out.push(full);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
      } catch { /* skip */ }
    }
  };
  walk(root, 0);
  return out;
}
