/**
 * LegacyInputAdapter (R2 Shadow Integration Phase 4c)
 *
 * 从 Engine v2 运行时数据中提取 InputGatewayPort 期望的 rawInput。
 *
 * Engine v2 hook 点：
 * - agent-loop.ts runL1(): messages[0]=system, messages[1]=user (原始输入)
 * - L2 模式下 cycleInput 可能包含 repairContext（不是纯用户输入）
 *
 * Adapter 策略：
 * - 从 messages 数组中提取最后一条 role='user' 的 message.content
 * - 验证非空（fail-closed）
 * - 返回 string（InputGatewayPort.parse 接受 string | Uint8Array）
 *
 * 注意：
 * - 不调用 InputGatewayPort.parse（那是 ExecutionCoordinator 的工作）
 * - 不验证 JSON 合法性（InputGatewayPort 会做）
 * - 只负责"提取"
 */

import type { LegacyAdapterContext, EngineV2InputSnapshot } from './types.js';
import { LegacyAdapterError } from './types.js';

export interface LegacyInputAdapterResult {
  /** 提取的原始输入（传给 ExecutionCoordinator.createExecution 的 rawInput） */
  readonly rawInput: string;
  /** 提取来源（'user_message' | 'userInput_param'） */
  readonly extractedFrom: 'user_message' | 'userInput_param';
  /** 提取的 message index（如果从 messages 提取） */
  readonly messageIndex?: number;
}

export function adaptLegacyInput(
  snapshot: EngineV2InputSnapshot,
  ctx: LegacyAdapterContext,
): LegacyInputAdapterResult {
  // 优先从 messages 中提取最后一条 user message（更准确）
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const msg = snapshot.messages[i];
    if (msg.role === 'user') {
      const content = msg.content;
      if (content.length === 0) {
        throw new LegacyAdapterError(
          'ADAPTER_INPUT_INVALID',
          'user message content is empty',
          'LegacyInputAdapter',
          ctx.mode,
        );
      }
      return {
        rawInput: content,
        extractedFrom: 'user_message',
        messageIndex: i,
      };
    }
  }

  // 回退到 userInput 参数（如果 messages 中没有 user message）
  if (snapshot.userInput.length === 0) {
    throw new LegacyAdapterError(
      'ADAPTER_INPUT_INVALID',
      'userInput is empty and no user message found in messages',
      'LegacyInputAdapter',
      ctx.mode,
    );
  }
  return {
    rawInput: snapshot.userInput,
    extractedFrom: 'userInput_param',
  };
}
