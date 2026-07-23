/**
 * 通用技能调用工具
 *
 * 读 SKILL.md body 作为 system prompt，起子 AgentLoop 跑完技能流程，返回 finalText。
 * 让 agent-loop L1 循环中可以直接调用 awkn-* 技能。
 */

import { getSkillsManager } from '../../skills/manager.js';
import { AgentLoop } from '../../core/agent-loop.js';
import type { ToolHandler } from '../types.js';

export const skillTool: ToolHandler = {
  name: 'skill',
  description: '调用 awkn 技能（读 SKILL.md body 作为 prompt，起子 AgentLoop 执行）',
  source: 'builtin',
  isReadOnly: false,
  concurrentSafe: false,
  permissionLevel: 'confirm',
  priority: 'high',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: '技能名（如 awkn-spec / awkn-审核 / AWKN 复盘总结）' },
      input: { type: 'string', description: '技能输入内容' },
    },
    required: ['skill', 'input'],
  },
  async execute(args: Record<string, unknown>) {
    const skillName = args.skill as string;
    const input = args.input as string;

    // M3 进阶-26（2026-07-23）：参数缺失必须 throw，不能返回 [error] 字符串
    //   原版：return '[error] 参数缺失' → agent-loop 视为成功（isError=false）
    //   问题：绕过 consecutiveErrors / 3-strike / recordLoopFailure（与 M3 进阶-7 terminated throw 不一致）
    //   修复：throw，与同文件 M3 进阶-7 的 terminated throw 保持一致
    if (!skillName || !input) {
      throw new Error('参数缺失：需要 skill 和 input');
    }

    const sm = getSkillsManager();
    const body = sm.getSkillBody(skillName);
    // M3 进阶-26（续）：skill 不存在同样 throw
    if (!body) {
      throw new Error(`Skill "${skillName}" not found`);
    }

    const loop = new AgentLoop({
      cwd: process.cwd(),
      enableL2: false,
      callSource: 'skill_tool',
      systemPrompt: body,
    });
    const result = await loop.runL1(input);

    // M3 进阶-7（2026-07-23）：检查 terminated，避免把"已终止的子循环"输出当成功结果返回
    // 原版：直接 return result.finalText，不检查 terminated
    // 问题：子 AgentLoop 可能因 LLM 连续失败 3 次 / 重复模式检测 / budget 超限被终止，
    //   此时 finalText 是错误占位文本（如"[循环异常：检测到工具调用重复模式，已终止]"）或空串，
    //   但调用方（agent-loop L1）会把它当成功的技能输出 → "无信号当成功"同类 bug
    // 修复：terminated 时 throw error，让上层 toolRegistry.execute → agent-loop catch 记录为 isError
    if (result.terminated) {
      throw new Error(
        `Skill "${skillName}" terminated: ${result.terminationReason ?? 'unknown reason'}`,
      );
    }
    return result.finalText;
  },
};
