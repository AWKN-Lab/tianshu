/**
 * AgentTeams — M3.3 verdict-writer
 *
 * 影响层级 [M]：审查 Worker 产出 VERDICT 工件。
 * 协议沿用引擎既有严格裁决格式（gates/review-verdict.ts）：单行 `VERDICT: PASS|FAIL`。
 * 落盘：artifactDir/verdict.json（编排可读）+ verdict.md（人可读）。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrictReviewVerdict, type StrictReviewVerdict } from '../../gates/review-verdict.js';

export interface VerdictRecord {
  schema: 'awkn-team-verdict/v1';
  workerId: string;
  personaId: string;
  verdict: StrictReviewVerdict | null;
  /** 原始输出摘要（截断） */
  excerpt: string;
  at: string;
}

/** 从 Worker 输出文本解析裁决（冲突/缺失 → null，fail closed 交由编排判断） */
export function extractVerdict(text: string): StrictReviewVerdict | null {
  return parseStrictReviewVerdict(text);
}

/** 写 VERDICT 工件到 Worker 工件目录 */
export function writeVerdict(
  artifactDir: string,
  input: { workerId: string; personaId: string; text: string },
): VerdictRecord {
  const verdict = extractVerdict(input.text);
  const record: VerdictRecord = {
    schema: 'awkn-team-verdict/v1',
    workerId: input.workerId,
    personaId: input.personaId,
    verdict,
    excerpt: input.text.slice(-2000),
    at: new Date().toISOString(),
  };
  writeFileSync(join(artifactDir, 'verdict.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  const md = [
    `# VERDICT — ${input.workerId}`,
    '',
    `- 人格：${input.personaId}`,
    `- 裁决：${verdict ?? 'INVALID（未给出唯一明确裁决）'}`,
    `- 时间：${record.at}`,
    '',
    '## 输出摘录',
    '',
    record.excerpt,
    '',
  ].join('\n');
  writeFileSync(join(artifactDir, 'verdict.md'), md, 'utf-8');
  return record;
}
