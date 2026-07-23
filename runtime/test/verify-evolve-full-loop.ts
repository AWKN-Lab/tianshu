/**
 * M3 进阶端到端验证 — 自进化闭环（非 LLM 部分）
 *
 * 验证链路：
 * 1. experience-writer 生成的草稿含正确的"待人工补充"标记
 * 2. awkn-复盘总结 SKILL.md 15.1 子章节包含扫描指令
 * 3. SKILL.md 的扫描标记与草稿格式匹配（grep 能识别草稿）
 * 4. 闭环可识别：草稿生成 → 标记可被扫描 → SKILL.md 有处理流程
 *
 * 不验证部分（被 MiniMax key 阻塞）：
 * - LLM 实际补全根因分析（需要 LLM provider）
 * - awkn-复盘总结 实际被触发并执行扫描（需要 callSkill → LLM）
 *
 * 运行：node --import tsx test/verify-evolve-full-loop.ts
 * 退出码：0 = 全部通过，1 = 有失败
 */

import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeExperience, patternToMarkdown, resolveExperienceId } from '../src/evolve/experience-writer.js';
import type { DetectedPattern } from '../src/evolve/pattern-detector.js';

// ─── 测试隔离：临时 derived 目录 ───────────────────────────────────
const TMP_DERIVED = resolve(process.cwd(), 'data', 'test-evolve-full-loop');
if (existsSync(TMP_DERIVED)) {
  rmSync(TMP_DERIVED, { recursive: true, force: true });
}
mkdirSync(TMP_DERIVED, { recursive: true });
process.env.AWKN_DERIVED_DIR = TMP_DERIVED;

// SKILL.md 路径（项目根下）
const SKILL_MD = resolve(process.cwd(), '..', 'skills', 'awkn-复盘总结', 'SKILL.md');

// ─── mock DetectedPattern ────────────────────────────────────────
const mockPattern: DetectedPattern = {
  kind: 'repeated_fingerprint',
  source: 'test-source',
  fingerprint: 'abc123def456',
  count: 3,
  firstTs: '2026-07-23T10:00:00Z',
  lastTs: '2026-07-23T12:00:00Z',
  latestError: 'TypeError: Cannot read property "x" of undefined\n    at foo (bar.ts:10:5)',
  sampleIds: ['corr-001', 'corr-002', 'corr-003'],
  goalId: 'goal-test-001',
  suggestedExperienceId: 'EXP-DRV-20260723-999',
};

// ─── 验证函数 ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

// ─── 1. 生成草稿 + 验证标记 ───────────────────────────────────────
console.log('\n=== 1. experience-writer 生成草稿 + 验证"待人工补充"标记 ===');

const writeResult = writeExperience(mockPattern);
assert(existsSync(writeResult.filePath), `草稿文件已生成: ${writeResult.experienceId}`);

const draftContent = readFileSync(writeResult.filePath, 'utf-8');

// 验证草稿含"待人工补充"状态标记
assert(
  draftContent.includes('**状态**: 待人工补充'),
  '草稿含状态标记 "**状态**: 待人工补充"',
);

// 验证草稿含第 4 节"根因分析（待人工补充）"
assert(
  draftContent.includes('## 4. 根因分析（待人工补充）'),
  '草稿含第 4 节标题 "## 4. 根因分析（待人工补充）"',
);

// 验证草稿含第 5 节"待提炼的铁律（待人工补充）"
assert(
  draftContent.includes('## 5. 待提炼的铁律（待人工补充）'),
  '草稿含第 5 节标题 "## 5. 待提炼的铁律（待人工补充）"',
);

// 验证草稿含检测到的模式信息（第 1-3 节）
assert(
  draftContent.includes('## 1. 检测到的模式') &&
    draftContent.includes('## 2. 最近一次错误文本') &&
    draftContent.includes('## 3. 样本 correction ID'),
  '草稿含第 1-3 节（背景/模式/样本）',
);

// ─── 2. SKILL.md 15.1 子章节验证 ─────────────────────────────────
console.log('\n=== 2. awkn-复盘总结 SKILL.md 15.1 子章节验证 ===');

assert(existsSync(SKILL_MD), `SKILL.md 存在: ${SKILL_MD}`);

const skillContent = readFileSync(SKILL_MD, 'utf-8');

// 验证 frontmatter version 是 v2.6.2
assert(
  /version:\s*"v2\.6\.2"/.test(skillContent),
  'frontmatter version = v2.6.2（对齐 §十九）',
);

// 验证 triggers 含新触发词
assert(
  skillContent.includes('"补全草稿"') &&
    skillContent.includes('"处理 derived"') &&
    skillContent.includes('"扫草稿"'),
  'triggers 含新触发词（补全草稿/处理 derived/扫草稿）',
);

// 验证 15.1 子章节存在
assert(
  skillContent.includes('### 15.1 derived 草稿自动补全流程（v2.6.2 新增）'),
  '§十五 含 15.1 子章节 "derived 草稿自动补全流程"',
);

// 验证扫描路径正确
assert(
  skillContent.includes('agents/tianhuo/04-记忆与知识/EXPERIENCE/derived/'),
  '15.1 含正确扫描路径',
);

// ─── 3. 扫描标记与草稿格式匹配验证（核心闭环）──────────────────────
console.log('\n=== 3. 扫描标记与草稿格式匹配验证（闭环核心）===');

// SKILL.md 15.1 声明的识别标记
const skillMarkers = [
  '**状态**: 待人工补充',
  '## 4. 根因分析（待人工补充）',
  '## 5. 待提炼的铁律（待人工补充）',
];

// 验证每个标记都能在草稿中找到
for (const marker of skillMarkers) {
  const inSkill = skillContent.includes(marker);
  const inDraft = draftContent.includes(marker);
  assert(
    inSkill && inDraft,
    `标记 "${marker}" 在 SKILL.md (${inSkill ? '✓' : '✗'}) 和草稿 (${inDraft ? '✓' : '✗'}) 中都存在`,
  );
}

// ─── 4. 扫描流程验证：derived 目录可被遍历找草稿 ──────────────────
console.log('\n=== 4. 扫描流程验证：derived 目录可被遍历找"待补全"草稿 ===');

const files = readdirSync(TMP_DERIVED);
const draftFiles = files.filter((f) => f.startsWith('EXP-DRV-') && f.endsWith('.md'));
assert(draftFiles.length >= 1, `derived 目录有 ${draftFiles.length} 个 EXP-DRV 草稿`);

// 模拟 awkn-复盘总结 的扫描逻辑：找"待人工补充"草稿
const pendingDrafts: string[] = [];
for (const f of draftFiles) {
  const content = readFileSync(resolve(TMP_DERIVED, f), 'utf-8');
  if (content.includes('**状态**: 待人工补充')) {
    pendingDrafts.push(f);
  }
}
assert(
  pendingDrafts.length >= 1,
  `扫描识别到 ${pendingDrafts.length} 个"待补全"草稿（含"**状态**: 待人工补充"标记）`,
);

// ─── 5. 补全后状态更新验证（模拟）──────────────────────────────────
console.log('\n=== 5. 补全后状态更新验证（模拟 awkn-复盘总结 补全流程）===');

// 模拟 LLM 补全后的状态：把"待人工补充"改为"已起草根因（待人工确认铁律）"
const updatedContent = draftContent.replace(
  '**状态**: 待人工补充',
  '**状态**: 已起草根因（待人工确认铁律）',
);
assert(
  updatedContent.includes('**状态**: 已起草根因（待人工确认铁律）') &&
    !updatedContent.includes('**状态**: 待人工补充'),
  '补全后状态行更新为"已起草根因（待人工确认铁律）"',
);

// 验证补全后草稿不再被扫描识别为"待补全"
const stillPending = updatedContent.includes('**状态**: 待人工补充');
assert(!stillPending, '补全后草稿不再被识别为"待补全"（闭环关闭）');

// ─── 6. E74 边界验证：铁律不自动标"已提炼" ────────────────────────
console.log('\n=== 6. E74 边界验证：铁律不自动标"已提炼" ===');

// SKILL.md 15.1 必须含"铁律最终必须人工确认"边界
assert(
  skillContent.includes('铁律最终必须人工确认') &&
    skillContent.includes('不能自动标"已提炼"'),
  '15.1 含 E74 边界（铁律必须人工确认，不自动标"已提炼"）',
);

// ─── 清理 ─────────────────────────────────────────────────────────
rmSync(TMP_DERIVED, { recursive: true, force: true });

// ─── 汇总 ─────────────────────────────────────────────────────────
console.log('\n=== 汇总 ===');
console.log(`通过: ${passed}, 失败: ${failed}`);
console.log('');
if (failed > 0) {
  console.log('❌ M3 进阶端到端验证失败');
  process.exit(1);
} else {
  console.log('✅ M3 进阶端到端验证通过');
  console.log('   闭环验证：草稿生成 → 待补全标记 → SKILL.md 扫描指令匹配 → 闭环可识别');
  console.log('   未验证（被 MiniMax key 阻塞）：LLM 实际补全根因分析');
  process.exit(0);
}
