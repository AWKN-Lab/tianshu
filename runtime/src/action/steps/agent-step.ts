/**
 * awkn-local-action-runner — Agent Step
 *
 * 复用 AgentLoop.runL1()，对标 qoder-action 的 Agent 调用。
 * 关键区别：qoder 调远端 REST，我们调本地 AgentLoop。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentLoop } from '../../core/agent-loop.js';
import { createLogger } from '../../core/logger.js';
import { redactText } from '../../core/redaction.js';
import type { AgentStepDef, StepResult } from '../types.js';

const logger = createLogger('AgentStep');

/** 已知 Agent 的默认 prompt 路径（相对于引擎根目录，即 runtime 的上一级） */
const AGENT_PROMPT_PATHS: Record<string, string> = {
  'tianhuo': 'agents/tianhuo/agent.prompt',
  'cicd-tester': 'agents/cicd-tester/agent.prompt',
};

/** 解析引擎根目录（runtime/ 的上一级） */
function engineRoot(cwd: string): string {
  if (existsSync(resolve(cwd, 'agents'))) return cwd;
  const parent = resolve(cwd, '..');
  if (existsSync(resolve(parent, 'agents'))) return parent;
  return cwd;
}

export async function runAgentStep(step: AgentStepDef, cwd: string): Promise<StepResult> {
  const started = Date.now();

  try {
    // 解析 system prompt（从引擎根目录找 agents/）
    let systemPrompt: string | undefined;
    const root = engineRoot(cwd);
    const promptPath = step.agent.systemPromptPath ?? AGENT_PROMPT_PATHS[step.agent.name];
    if (promptPath) {
      const resolved = resolve(root, promptPath);
      if (existsSync(resolved)) {
        systemPrompt = readFileSync(resolved, 'utf-8');
      } else {
        logger.warn(`Agent prompt not found: ${resolved}`);
      }
    }

    const loop = new AgentLoop({
      cwd,
      enableL2: false,
      callSource: 'action_runner',
      systemPrompt,
      maxTurns: step.agent.maxTurns,
    });

    const result = await loop.runL1(step.agent.prompt);

    return {
      name: step.name,
      type: 'agent',
      status: result.terminated ? 'failed' : 'passed',
      output: redactText(result.finalText).slice(0, 5000),
      agentSummary: redactText(result.finalText).slice(0, 500),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    logger.error(`Agent step "${step.name}" failed: ${String(err)}`);
    return {
      name: step.name,
      type: 'agent',
      status: 'failed',
      output: redactText(String(err)).slice(0, 5000),
      durationMs: Date.now() - started,
    };
  }
}
