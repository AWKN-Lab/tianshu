/**
 * Tool Broker (Phase 6 / C05 / WP-AOS-08)
 *
 * 设计文档: `docs/agent-os-3.0/06-Tool-Model-Broker.md` 第 5、9 节
 *
 * 职责:
 * - 根据 ToolCapability 生成 ToolRoutePlan
 * - 评估工具风险等级 (R0-R5)
 * - 标注是否需要授权
 * - 生成幂等键 (当工具支持)
 * - 标注是否需要副作用验证
 * - 执行后校验真实副作用并生成 ToolExecutionReceipt
 */

import type {
  ResourceScope,
  ToolCapability,
  ToolExecutionReceipt,
  ToolRiskLevel,
  ToolRoutePlan,
  SideEffectVerificationResult,
} from '../contracts/broker.js';
import { createAwknId } from '../contracts/ids.js';

/** Tool Broker 错误 */
export class ToolBrokerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ToolBrokerError';
  }
}

/** 授权要求输入 (用于构建 ToolRoutePlan) */
export interface AuthorizationRequirementInput {
  requiredActions: readonly string[];
  resourceScopes: readonly ResourceScope[];
  dataScopes: readonly string[];
  riskCeiling: ToolRiskLevel;
  maxExecutions: number;
  requiresHumanConfirmation: boolean;
}

/**
 * 构建 ToolRoutePlan (Plan 阶段, 不执行)
 *
 * fail-closed:
 * - capability.requiresAuthorization 为 true 但未提供 requirement → 抛错
 */
export function buildToolRoutePlan(
  capability: ToolCapability,
  requirement?: AuthorizationRequirementInput,
): ToolRoutePlan {
  if (capability.requiresAuthorization && !requirement) {
    throw new ToolBrokerError(
      `tool ${capability.toolId} requires authorization but no requirement provided`,
      'AUTHORIZATION_REQUIRED',
    );
  }

  return {
    schema: 'awkn-tool-route-plan/v1',
    toolId: capability.toolId,
    providerId: capability.providerId,
    sideEffect: capability.sideEffect,
    riskBase: capability.riskBase,
    requiresAuthorization: capability.requiresAuthorization,
    authorizationRequirement: requirement
      ? {
          schema: 'awkn-authorization-requirement/v1',
          toolId: capability.toolId,
          providerId: capability.providerId,
          requiredActions: [...requirement.requiredActions],
          resourceScopes: [...requirement.resourceScopes],
          dataScopes: [...requirement.dataScopes],
          riskCeiling: requirement.riskCeiling,
          maxExecutions: requirement.maxExecutions,
          requiresHumanConfirmation: requirement.requiresHumanConfirmation,
        }
      : undefined,
    idempotencyKey: capability.supportsIdempotency ? createIdempotencyKey(capability) : undefined,
    requiresSideEffectVerification: capability.supportsVerification && hasSideEffect(capability.sideEffect),
  };
}

function createIdempotencyKey(capability: ToolCapability): string {
  // 简单生成: toolId + 时间窗口 (实际使用时由调用方提供业务键)
  return `idem-${capability.toolId}-${Date.now()}`;
}

function hasSideEffect(sideEffect: ToolCapability['sideEffect']): boolean {
  return sideEffect !== 'none' && sideEffect !== 'local_read';
}

/**
 * 执行后副作用验证 (设计文档第 9 节)
 *
 * 工具返回成功不等于外部状态已完成.
 * Broker 需要:
 * 1. 读取工具原始结果
 * 2. 提取资源 ID 或状态
 * 3. 必要时调用只读验证
 * 4. 生成 Tool Execution Receipt
 * 5. 失败时执行补偿或标记 PARTIAL
 * 6. 避免在不确定状态下自动重试不可逆动作
 */
export interface SideEffectVerificationInput {
  toolCallId: string;
  toolCapability: ToolCapability;
  reportedSuccess: boolean;
  /** 工具返回的资源引用 */
  resourceRefs: readonly string[];
  /** 请求哈希 */
  requestHash: string;
  /** 结果哈希 */
  resultHash: string;
  /** 只读验证函数 (可选, 由调用方提供) */
  verifyReadonly?: (resourceRefs: readonly string[]) => Promise<SideEffectVerificationOutcome>;
}

export interface SideEffectVerificationOutcome {
  verifiedSuccess: boolean;
  reasonCodes: string[];
}

/**
 * 验证副作用并生成 ToolExecutionReceipt
 *
 * fail-closed:
 * - 不可逆动作 + reported success + 无 verifyReadonly → 标记 PARTIAL (不确定)
 * - 不可逆动作 + reported failure → 标记 failure, 触发补偿
 * - 可逆动作 → 信任 reported success (但记录 reversible=true)
 */
export async function verifySideEffect(
  input: SideEffectVerificationInput,
  createdAt: string,
): Promise<{ receipt: ToolExecutionReceipt; verification: SideEffectVerificationResult }> {
  const { toolCapability, reportedSuccess, resourceRefs } = input;
  const irreversible = !toolCapability.reversible;
  const hasSideEffectFlag = hasSideEffect(toolCapability.sideEffect);

  let verifiedSuccess = reportedSuccess;
  let reasonCodes: string[] = [];
  let compensationTriggered = false;

  if (reportedSuccess && hasSideEffectFlag && toolCapability.supportsVerification) {
    if (input.verifyReadonly) {
      const outcome = await input.verifyReadonly(resourceRefs);
      verifiedSuccess = outcome.verifiedSuccess;
      reasonCodes = outcome.reasonCodes;
      if (!verifiedSuccess) {
        reasonCodes.push('VERIFICATION_FAILED');
        // 不可逆动作验证失败 → 触发补偿
        if (irreversible) {
          compensationTriggered = true;
          reasonCodes.push('COMPENSATION_TRIGGERED');
        }
      }
    } else {
      // 不可逆动作 + 无验证函数 → 标记 PARTIAL (不确定)
      if (irreversible) {
        verifiedSuccess = false;
        reasonCodes.push('VERIFICATION_MISSING_FOR_IRREVERSIBLE');
      } else {
        reasonCodes.push('VERIFICATION_SKIPPED_REVERSIBLE');
      }
    }
  } else if (!reportedSuccess) {
    reasonCodes.push('TOOL_REPORTED_FAILURE');
    if (irreversible) {
      compensationTriggered = true;
      reasonCodes.push('COMPENSATION_TRIGGERED');
    }
  } else {
    reasonCodes.push('NO_SIDE_EFFECT_OR_NO_VERIFICATION_SUPPORT');
  }

  const partialState = reportedSuccess && !verifiedSuccess && !compensationTriggered;

  const receipt: ToolExecutionReceipt = {
    schema: 'awkn-tool-execution-receipt/v1',
    toolCallId: input.toolCallId,
    toolId: toolCapability.toolId,
    authorizationId: undefined,
    requestHash: input.requestHash,
    resultHash: input.resultHash,
    sideEffect: toolCapability.sideEffect,
    resourceRefs: [...resourceRefs],
    reportedSuccess,
    verifiedSuccess,
    reversible: toolCapability.reversible,
    compensationRef: compensationTriggered ? `comp-${input.toolCallId}` : undefined,
    createdAt,
  };

  const verification: SideEffectVerificationResult = {
    schema: 'awkn-side-effect-verification/v1',
    toolCallId: input.toolCallId,
    reportedSuccess,
    verifiedSuccess,
    resourceRefs: [...resourceRefs],
    verificationReasonCodes: reasonCodes,
    compensationTriggered,
    partialState,
  };

  return { receipt, verification };
}

/**
 * 判断是否可以自动重试 (设计文档第 9.6 节)
 *
 * 避免在不确定状态下自动重试不可逆动作
 */
export function canAutoRetry(
  capability: ToolCapability,
  verification: SideEffectVerificationResult,
): boolean {
  // 不可逆动作 → 禁止自动重试
  if (!capability.reversible) return false;
  // partial state → 禁止自动重试
  if (verification.partialState) return false;
  // 验证失败 → 禁止自动重试
  if (!verification.verifiedSuccess) return false;
  return true;
}

/**
 * 生成新的 ToolCall ID
 */
export function newToolCallId(): string {
  return createAwknId('toolCall');
}
