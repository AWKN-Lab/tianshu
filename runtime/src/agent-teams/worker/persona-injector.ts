/**
 * AgentTeams — M3.2 persona-injector
 *
 * 影响层级 [M]：把 PersonaRole.systemPrompt + thinkingModels + boundaries
 * 注入 Worker prompt 头（吸收映射规则 2/3）。
 * 异常契约：人格缺失 → 退回纯骨架（不中断执行）。
 * prompt 不塞全量上下文：上游产物只给文件路径引用，不内联全文。
 */
import type { PersonaRole } from '../persona/types.js';
import { loadSkeletonCard } from './manifest.js';

export interface InjectOptions {
  persona?: PersonaRole;
  capability?: string;
  /** 审查岗标记（追加独立审查守则） */
  isReviewer?: boolean;
  capabilitiesRoot?: string;
}

/** 渲染人格段（systemPrompt + 思维模型 + 边界） */
export function renderPersonaSection(persona: PersonaRole): string {
  const lines: string[] = [];
  lines.push(`# 你的人格视角：${persona.name}${persona.displayName ? `（${persona.displayName}）` : ''}`);
  lines.push('');
  lines.push(persona.systemPrompt);
  if (persona.thinkingModels?.length) {
    lines.push('');
    lines.push('## 思维模型（按场景取用，作推理脚手架）');
    for (const t of persona.thinkingModels) {
      lines.push(`- ${t.name}（${t.when}）：${t.keyQuestion}`);
    }
  }
  if (persona.boundaries?.length) {
    lines.push('');
    lines.push('## 职责边界（严格遵守，越权即失败）');
    for (const b of persona.boundaries) lines.push(`- ${b}`);
  }
  if (persona.stopConditions?.length) {
    lines.push('');
    lines.push('## 停止条件（满足即停，不过度执行）');
    for (const s of persona.stopConditions) lines.push(`- ${s}`);
  }
  return lines.join('\n');
}

/**
 * 组装 Worker system prompt = 人格段 + 工种骨架卡（降 token：骨架卡只取卡片不取 reference）。
 * 人格缺失时退回纯骨架；骨架也缺失时返回 null。
 */
export function buildWorkerSystemPrompt(opts: InjectOptions): string | null {
  const sections: string[] = [];

  if (opts.persona) {
    sections.push(renderPersonaSection(opts.persona));
  }

  const card = opts.capability ? loadSkeletonCard(opts.capability, opts.capabilitiesRoot) : null;
  if (card) {
    sections.push(`# 工种骨架（capability: ${opts.capability}）\n\n${card}`);
  }

  if (opts.isReviewer) {
    sections.push(
      [
        '# 独立审查守则',
        '- 你是独立审查岗，不被被审环节驱动，不受产出 Worker 结论影响。',
        '- 只基于证据输出结论；最后一行必须输出且仅输出一个明确裁决行：VERDICT: PASS 或 VERDICT: FAIL。',
        '- 永不否决式沉默：FAIL 必须附证据与修复建议。',
      ].join('\n'),
    );
  }

  if (sections.length === 0) return null;
  return sections.join('\n\n---\n\n');
}
