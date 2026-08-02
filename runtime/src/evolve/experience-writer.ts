import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvolutionLifecycle } from './lifecycle.js';
import type { DetectedPattern } from './pattern-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getDerivedDir(): string {
  return process.env.AWKN_DERIVED_DIR
    ? resolve(process.env.AWKN_DERIVED_DIR)
    : resolve(__dirname, '..', '..', '..', 'agents', 'tianhuo', '04-记忆与知识', 'EXPERIENCE', 'derived');
}

function findMaxSeqForToday(dateStr: string): number {
  const dir = getDerivedDir();
  if (!existsSync(dir)) return 0;
  let maxSeq = 0;
  const prefix = `EXP-DRV-${dateStr}-`;
  for (const file of readdirSync(dir)) {
    if (!file.startsWith(prefix)) continue;
    const sequence = Number.parseInt(file.slice(prefix.length, prefix.length + 3), 10);
    if (Number.isFinite(sequence)) maxSeq = Math.max(maxSeq, sequence);
  }
  return maxSeq;
}

export function resolveExperienceId(suggested: string): string {
  const match = suggested.match(/^EXP-DRV-(\d{8})-(\d{3})$/);
  const now = new Date();
  const dateStr = match?.[1]
    ?? `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `EXP-DRV-${dateStr}-${String(findMaxSeqForToday(dateStr) + 1).padStart(3, '0')}`;
}

export function patternToMarkdown(pattern: DetectedPattern, experienceId: string): string {
  const kindLabel: Record<string, string> = {
    repeated_fingerprint: '同指纹重复',
    source_burst: 'source 突发',
    goal_repeat: '同目标内重复',
  };
  return `# ${experienceId} — ${pattern.source} 反复出错（${kindLabel[pattern.kind] ?? pattern.kind}）

- **类型**: derived
- **日期**: ${new Date().toISOString()}
- **状态**: 待人工补充
- **fingerprint**: ${pattern.fingerprint}

## 1. 检测到的模式

| 维度 | 值 |
|---|---|
| kind | ${pattern.kind} |
| source | ${pattern.source} |
| count | ${pattern.count} |
| first_ts | ${pattern.firstTs} |
| last_ts | ${pattern.lastTs} |
| goal_id | ${pattern.goalId ?? '(无)'} |

## 2. 最近一次错误文本

\`\`\`
${pattern.latestError.slice(0, 2000)}
\`\`\`

## 3. 样本 correction ID

${pattern.sampleIds.map((id) => `- ${id}`).join('\n')}

## 4. 根因分析（待人工补充）

- 检查失败是否由协议、状态、外部依赖、权限、测试覆盖或上下文缺失引起。
- 通过历史任务回放验证规则，禁止仅凭文本判断晋级。

## 5. 待提炼的铁律（待人工补充）

1. 在修改前复用现有接口、状态与证据。
2. 对该 fingerprint 增加确定性检查和失败证据。
3. 新规则必须通过 baseline/candidate 回放比较。

## 6. 晋级条件

- [ ] 成功率不下降
- [ ] 循环数与 Token 不越过阈值
- [ ] 错误率、人工接管率、安全违规率不增加
- [ ] 通过后进入 APPROVED，再由激活动作进入 ACTIVE

---

_自动生成的候选经验（DRAFT）。相关 correction 在候选 ACTIVE 前保持 open；待 awkn-复盘总结补全根因与工程规则，并经回放、人工批准后晋级。_
`;
}

export interface WriteResult {
  experienceId: string;
  filePath: string;
  pattern: DetectedPattern;
  candidateId: string;
  candidateStatus: string;
  linkedCorrections: number;
  reusedCandidate: boolean;
  resolvedCorrections: number;
}

export function writeExperience(pattern: DetectedPattern): WriteResult {
  const lifecycle = new EvolutionLifecycle();
  const existing = lifecycle.findInFlightByFingerprintAndKind(pattern.fingerprint, pattern.kind);
  if (existing) {
    // Ensure file exists at the current derived dir (previous file may have been cleaned up)
    const dir = getDerivedDir();
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, `${existing.experience_id}.md`);
    if (!existsSync(filePath)) writeFileSync(filePath, patternToMarkdown(pattern, existing.experience_id), 'utf-8');
    const linked = lifecycle.linkCorrections(existing.id, pattern.sampleIds);
    return {
      experienceId: existing.experience_id,
      filePath,
      pattern,
      candidateId: existing.id,
      candidateStatus: existing.status,
      linkedCorrections: linked,
      reusedCandidate: true,
      resolvedCorrections: 0,
    };
  }

  const dir = getDerivedDir();
  mkdirSync(dir, { recursive: true });
  const experienceId = resolveExperienceId(pattern.suggestedExperienceId);
  const filePath = resolve(dir, `${experienceId}.md`);
  if (!existsSync(filePath)) writeFileSync(filePath, patternToMarkdown(pattern, experienceId), 'utf-8');
  const candidate = lifecycle.createCandidate({
    experienceId,
    contentPath: filePath,
    sourcePattern: { ...pattern },
    sourceFingerprint: pattern.fingerprint,
    correctionIds: pattern.sampleIds,
  });
  return {
    experienceId,
    filePath,
    pattern,
    candidateId: candidate.id,
    candidateStatus: candidate.status,
    linkedCorrections: pattern.sampleIds.length,
    reusedCandidate: false,
    resolvedCorrections: 0,
  };
}

export function writeAllExperiences(patterns: DetectedPattern[]): WriteResult[] {
  const results: WriteResult[] = [];
  for (const pattern of patterns) {
    try {
      results.push(writeExperience(pattern));
    } catch (error) {
      console.error(`[experience-writer] 写入失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}

export async function stopExperienceExtractHook(): Promise<{ success: boolean; output: string }> {
  try {
    const { getPatternDetector } = await import('./pattern-detector.js');
    const patterns = getPatternDetector().detect();
    if (patterns.length === 0) return { success: true, output: '[experience-extract] 无重复模式，跳过候选生成' };
    const results = writeAllExperiences(patterns);
    const summary = results.map((result) =>
      `${result.experienceId}: candidate=${result.candidateId} status=${result.candidateStatus} linked=${result.linkedCorrections}${result.reusedCandidate ? ' reused' : ''}`,
    ).join('\n');
    return { success: true, output: `[experience-extract] 检测到 ${patterns.length} 个模式，候选结果：\n${summary}` };
  } catch (error) {
    return { success: false, output: `[experience-extract] 失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function runEvolveOnce(): Promise<{ patterns: DetectedPattern[]; writes: WriteResult[] }> {
  const { getPatternDetector } = await import('./pattern-detector.js');
  const patterns = getPatternDetector().detect();
  return { patterns, writes: writeAllExperiences(patterns) };
}

export interface PendingDraft {
  experienceId: string;
  filePath: string;
  size: number;
  pendingMarkerCount: number;
}

// M3 进阶-18: scanPendingDrafts / completePendingDrafts — 候选经验草稿扫描与补全
export function scanPendingDrafts(): PendingDraft[] {
  const dir = getDerivedDir();
  if (!existsSync(dir)) return [];
  const pending: PendingDraft[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    const filePath = resolve(dir, file);
    const content = readFileSync(filePath, 'utf-8');
    const markerCount = (content.match(/待人工补充|待补全|待回放验证/g) ?? []).length;
    if (markerCount === 0) continue;
    pending.push({
      experienceId: file.replace(/\.md$/, ''),
      filePath,
      size: statSync(filePath).size,
      pendingMarkerCount: markerCount,
    });
  }
  return pending;
}

export async function completePendingDrafts(cwd: string): Promise<{
  scanned: number;
  completed: number;
  errors: string[];
}> {
  const pending = scanPendingDrafts();
  if (pending.length === 0) return { scanned: 0, completed: 0, errors: [] };
  const { getSkillsManager } = await import('../skills/manager.js');
  const { AgentLoop } = await import('../core/agent-loop.js');
  const skills = getSkillsManager();
  const skillBody = skills.getSkillBody('AWKN 复盘总结') ?? skills.getSkillBody('awkn-复盘总结');
  if (!skillBody) throw new Error('Skill "AWKN 复盘总结" not found');

  const errors: string[] = [];
  let completed = 0;
  for (const draft of pending) {
    try {
      const loop = new AgentLoop({
        cwd,
        enableL2: false,
        callSource: 'skill_tool',
        systemPrompt: skillBody,
        excludedTools: ['skill'],
      });
      const result = await loop.runL1(`读取并完善候选经验文件 ${draft.filePath}。补充根因和可执行工程规则，保留 DRAFT 状态，等待历史回放。`);
      if (result.terminated) errors.push(`${draft.experienceId}: ${result.terminationReason ?? 'terminated'}`);
      else completed++;
    } catch (error) {
      errors.push(`${draft.experienceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { scanned: pending.length, completed, errors };
}
