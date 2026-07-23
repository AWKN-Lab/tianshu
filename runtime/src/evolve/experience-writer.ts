/**
 * 经验文件写入器 — M3 自进化机制最后一环
 *
 * 职责：
 * - 接收 DetectedPattern，生成 EXP-DRV-YYYYMMDD-NNN.md 文件
 * - 写入路径：agents/tianhuo/04-记忆与知识/EXPERIENCE/derived/
 * - 同日多经验时 NNN 自增（避免冲突）
 * - 写入后调用 corrections-ledger.resolveByFingerprint 关闭对应记录
 *
 * 设计原则：
 * - 经验文件是"自进化闭环"的落地产物，必须真正写到磁盘
 * - 文件名冲突时 NNN +1 直到找到可用编号
 * - 内容包含：背景 / 检测到的模式 / 样本证据 / 待补充的根因分析 / 待人工填的解决方案
 *   （AI 负责检测+起草，人类负责提炼铁律，符合 "AI + 用户监督" 模式）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCorrectionsLedger } from './corrections-ledger.js';
import type { DetectedPattern } from './pattern-detector.js';

// ─── 路径 ────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * derived 经验目录（绝对路径）
 *
 * 修复（2026-07-23）：原版用 process.cwd()，但 cli.ts 从 runtime/ 跑
 * 导致经验文件写到 runtime/agents/... 而非项目根 agents/...
 * 现改用 __dirname 推算：src/evolve/experience-writer.ts → 上溯 3 级到项目根
 *
 * 路径覆盖：优先用环境变量 AWKN_DERIVED_DIR（测试用）
 */
function getDerivedDir(): string {
  if (process.env.AWKN_DERIVED_DIR) {
    return process.env.AWKN_DERIVED_DIR;
  }
  // __dirname = runtime/src/evolve/
  // 上溯：evolve → src → runtime → 项目根
  return resolve(__dirname, '..', '..', '..', 'agents', 'tianhuo', '04-记忆与知识', 'EXPERIENCE', 'derived');
}

// ─── 文件名冲突解决 ───────────────────────────────────────────────

/**
 * 扫描 derived 目录，找到当前日期已存在的最大序号
 * EXP-DRV-20260723-001 → maxSeq = 1
 */
function findMaxSeqForToday(dateStr: string): number {
  const dir = getDerivedDir();
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir);
  let maxSeq = 0;
  const prefix = `EXP-DRV-${dateStr}-`;
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const seqStr = f.slice(prefix.length, prefix.length + 3);
    const seq = parseInt(seqStr, 10);
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq;
  }
  return maxSeq;
}

/**
 * 生成不冲突的经验 ID（重写 pattern-detector 的随机 NNN，改为顺序 +1）
 * 输入：suggestedExperienceId（可能是随机的 NNN）
 * 输出：确定的、文件不冲突的 ID
 */
export function resolveExperienceId(suggested: string): string {
  // 解析 EXP-DRV-YYYYMMDD-NNN
  const m = suggested.match(/^EXP-DRV-(\d{8})-(\d{3})$/);
  if (!m) {
    // 兜底：用今天日期
    const now = new Date();
    const dateStr = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    const maxSeq = findMaxSeqForToday(dateStr);
    return `EXP-DRV-${dateStr}-${String(maxSeq + 1).padStart(3, '0')}`;
  }
  const dateStr = m[1]!;
  const maxSeq = findMaxSeqForToday(dateStr);
  return `EXP-DRV-${dateStr}-${String(maxSeq + 1).padStart(3, '0')}`;
}

// ─── Markdown 生成 ────────────────────────────────────────────────

/** 把 DetectedPattern 转成 Markdown 内容（待人工补充铁律部分） */
export function patternToMarkdown(
  pattern: DetectedPattern,
  experienceId: string,
): string {
  const kindLabel: Record<string, string> = {
    repeated_fingerprint: '同指纹重复（最近 24h 内反复出现）',
    source_burst: 'source 突发（1h 内多次出错）',
    goal_repeat: '同目标内重复（同一 goal 反复踩坑）',
  };

  const now = new Date().toISOString();
  const samples = pattern.sampleIds.map((id) => `- ${id}`).join('\n');

  return `# ${experienceId} — ${pattern.source} 反复出错（${kindLabel[pattern.kind] ?? pattern.kind}）

- **类型**: derived（系统自动检测，待人工提炼）
- **日期**: ${now}
- **触发**: PatternDetector 自动检测到重复模式
- **严重度**: 高（影响自进化闭环）
- **状态**: 待人工补充根因与铁律

## 1. 检测到的模式

| 维度 | 值 |
|------|------|
| kind | ${pattern.kind} |
| source | ${pattern.source} |
| fingerprint | ${pattern.fingerprint} |
| count | ${pattern.count} |
| first_ts | ${pattern.firstTs} |
| last_ts | ${pattern.lastTs} |
| goal_id | ${pattern.goalId ?? '(无)'} |

## 2. 最近一次错误文本

\`\`\`
${pattern.latestError.slice(0, 2000)}
\`\`\`

## 3. 样本 correction ID（最多 5 条）

${samples}

## 4. 根因分析（待人工补充）

> AI 检测到该模式但未自动生成根因。请人工分析：
> - 为什么这个错误反复出现？
> - 是 prompt 设计问题、外部依赖不稳定、还是测试覆盖不足？
> - 该模式与现有经验（如 EXP-DRV-20260723-001 的 E73/E74/E75）是否同源？

## 5. 待提炼的铁律（待人工补充）

> 基于根因，提炼一条可复用的工程铁律。
> 参考 E73 的格式："适用情境 + 铁律 + 反例 + 正例"。

## 6. 解决方案

- [ ] 补充根因分析
- [ ] 提炼铁律（EXX 编号）
- [ ] 修复 prompt / 代码 / 配置
- [ ] 验证修复后重跑无相同错误

---

_本文件由 experience-writer.ts 自动生成，请勿直接编辑自动部分。人工补充后状态可改为"已提炼"。_
`;
}

// ─── Writer ──────────────────────────────────────────────────────

export interface WriteResult {
  experienceId: string;
  filePath: string;
  pattern: DetectedPattern;
  resolvedCorrections: number;
}

/**
 * 把一个 DetectedPattern 写成经验文件
 * - 同一 fingerprint 一天内只写一次（用文件存在性兜底）
 * - 写完后 resolveByFingerprint 关闭对应 corrections
 */
export function writeExperience(pattern: DetectedPattern): WriteResult {
  const dir = getDerivedDir();
  mkdirSync(dir, { recursive: true });

  const experienceId = resolveExperienceId(pattern.suggestedExperienceId);
  const fileName = `${experienceId}.md`;
  const filePath = resolve(dir, fileName);

  // 防御性：文件已存在则跳过写入（理论上 resolveExperienceId 已避免冲突）
  if (existsSync(filePath)) {
    // 已存在 → 不覆盖，只 resolve corrections
    const resolved = getCorrectionsLedger().resolveByFingerprint(
      pattern.fingerprint,
      `经验文件已存在：${experienceId}`,
      experienceId,
    );
    return { experienceId, filePath, pattern, resolvedCorrections: resolved };
  }

  const content = patternToMarkdown(pattern, experienceId);
  writeFileSync(filePath, content, 'utf-8');

  // 关闭对应 corrections
  const resolved = getCorrectionsLedger().resolveByFingerprint(
    pattern.fingerprint,
    `经验文件已生成：${experienceId}`,
    experienceId,
  );

  return { experienceId, filePath, pattern, resolvedCorrections: resolved };
}

/**
 * 批量写入：扫所有 pattern，每个写一个文件
 * 返回所有写入结果
 */
export function writeAllExperiences(patterns: DetectedPattern[]): WriteResult[] {
  const results: WriteResult[] = [];
  for (const p of patterns) {
    try {
      results.push(writeExperience(p));
    } catch (e) {
      // 单个失败不影响其他
      console.error(`[experience-writer] 写入失败: ${(e as Error).message}`);
    }
  }
  return results;
}

// ─── Stop Hook 集成 ──────────────────────────────────────────────

/**
 * Stop hook 函数：在 session_stop 时触发
 * - 扫描所有 corrections → 检测 pattern → 写经验文件
 *
 * 注册方式（在 cli.ts / agent-loop.ts 启动时）：
 *   hookManager.register({
 *     id: 'stop:experience-extract',
 *     point: 'session_stop',
 *     type: 'function',
 *     fn: stopExperienceExtractHook,
 *     timeout: 30000,
 *   });
 */
export async function stopExperienceExtractHook(): Promise<{
  success: boolean;
  output: string;
}> {
  try {
    const { getPatternDetector } = await import('./pattern-detector.js');
    const patterns = getPatternDetector().detect();
    if (patterns.length === 0) {
      return {
        success: true,
        output: '[experience-extract] 无重复模式，跳过经验沉淀',
      };
    }
    const results = writeAllExperiences(patterns);
    const summary = results
      .map((r) => `${r.experienceId}: ${r.pattern.source} × ${r.pattern.count} (resolved ${r.resolvedCorrections})`)
      .join('\n');
    return {
      success: true,
      output: `[experience-extract] 检测到 ${patterns.length} 个模式，已写入经验文件：\n${summary}`,
    };
  } catch (e) {
    return {
      success: false,
      output: `[experience-extract] 失败: ${(e as Error).message}`,
    };
  }
}

// ─── CLI 入口辅助 ────────────────────────────────────────────────

/**
 * 手动触发：扫一次 + 写所有 + 返回摘要
 * （ESM 下用 dynamic import 代替 require）
 */
export async function runEvolveOnce(): Promise<{
  patterns: DetectedPattern[];
  writes: WriteResult[];
}> {
  const { getPatternDetector } = await import('./pattern-detector.js');
  const patterns = getPatternDetector().detect();
  const writes = writeAllExperiences(patterns);
  return { patterns, writes };
}

// ─── M3 进阶-18：derived 草稿补全触发 ──────────────────────────────

/**
 * M3 进阶-18（2026-07-23）：修复自进化闭环第二处断链
 *
 *   原版：experience-writer 写 derived 草稿（含"待人工补充"标记），
 *         awkn-复盘总结 SKILL.md 15.1 文档化了补全流程，
 *         但没有任何代码触发该流程 → 草稿永远堆积 → 自进化闭环卡在"起草"阶段
 *         与 M3 进阶-17 同类："无输入被当作已处理"的第二处实例
 *   修复：
 *     1. scanPendingDrafts() — 纯文件扫描，不需要 LLM
 *     2. completePendingDrafts() — 调 awkn-复盘总结 技能补全（需要 LLM）
 *     3. CLI 命令 evolve complete-drafts 触发上述流程
 *
 * 草稿标记（由 patternToMarkdown 生成）：
 *   - "状态: 待人工补充"
 *   - "（待人工补充）" in section headers
 *   - "- [ ] 补充根因分析" / "- [ ] 提炼铁律"
 */

export interface PendingDraft {
  experienceId: string;
  filePath: string;
  /** 文件大小（字节） */
  size: number;
  /** 含"待人工补充"/"待补全"的行数 */
  pendingMarkerCount: number;
}

/**
 * 扫描 derived 目录，返回所有待补全的草稿
 * 纯文件扫描，不需要 LLM
 */
export function scanPendingDrafts(): PendingDraft[] {
  const dir = getDerivedDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const pending: PendingDraft[] = [];

  for (const f of files) {
    const filePath = resolve(dir, f);
    const content = readFileSync(filePath, 'utf-8');

    // 检查是否有"待人工补充"或"待补全"标记
    const markerCount = (content.match(/待人工补充|待补全/g) || []).length;
    if (markerCount === 0) continue;

    const experienceId = f.replace(/\.md$/, '');
    const stat = statSync(filePath);

    pending.push({
      experienceId,
      filePath,
      size: stat.size,
      pendingMarkerCount: markerCount,
    });
  }

  return pending;
}

/**
 * 补全所有待处理草稿 — 调用 awkn-复盘总结 技能的 15.1 流程
 *
 * 需要 LLM（通过 callSkill 调 awkn-复盘总结）
 * LLM 不可用时 throw error（不假成功，与 E73 一致）
 *
 * @param cwd 工作目录
 * @returns 扫描数 / 完成数 / 错误列表
 */
export async function completePendingDrafts(cwd: string): Promise<{
  scanned: number;
  completed: number;
  errors: string[];
}> {
  const pending = scanPendingDrafts();
  const errors: string[] = [];

  if (pending.length === 0) {
    return { scanned: 0, completed: 0, errors: [] };
  }

  // 动态导入避免循环依赖（evolve → core → evolve）
  const { getSkillsManager } = await import('../skills/manager.js');
  const { AgentLoop } = await import('../core/agent-loop.js');

  const sm = getSkillsManager();
  const skillBody =
    sm.getSkillBody('AWKN 复盘总结') ?? sm.getSkillBody('awkn-复盘总结');
  if (!skillBody) {
    throw new Error(
      'Skill "AWKN 复盘总结" not found — 无法补全草稿（请确认 skills/ 目录已加载）',
    );
  }

  let completed = 0;
  for (const draft of pending) {
    try {
      const prompt = `请按 15.1 derived 草稿自动补全流程，补全以下经验文件：
文件路径：${draft.filePath}
经验 ID：${draft.experienceId}
待补全标记数：${draft.pendingMarkerCount}

请读取该文件，补全"根因分析"和"待提炼的铁律"部分，然后将状态从"待人工补充"改为"已提炼"。`;

      const loop = new AgentLoop({
        cwd,
        enableL2: false,
        callSource: 'skill_tool',
        systemPrompt: skillBody,
      });
      const result = await loop.runL1(prompt);

      // M3 进阶-7/8 同类：检查 terminated，不把"已终止"当成功
      if (result.terminated) {
        errors.push(
          `${draft.experienceId}: terminated (${result.terminationReason ?? 'unknown'})`,
        );
      } else {
        completed++;
      }
    } catch (e) {
      errors.push(`${draft.experienceId}: ${(e as Error).message}`);
    }
  }

  return { scanned: pending.length, completed, errors };
}
