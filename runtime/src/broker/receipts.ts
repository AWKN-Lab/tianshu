/**
 * Broker Receipts (Phase 6 / C05)
 *
 * 设计文档: `docs/agent-os-3.0/06-Tool-Model-Broker.md` 第 4.2、10 节
 */

import { createHash } from 'node:crypto';
import type {
  DegradationLevel,
  DegradationNotice,
  ModelRouteReceipt,
} from '../contracts/broker.js';
import { createAwknId } from '../contracts/ids.js';

/** 计算 Model Route 请求的哈希 */
export function computeRequestHash(messages: readonly unknown[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(JSON.stringify(message));
    hash.update('|');
  }
  return hash.digest('hex');
}

/** 计算 Model Route 结果的哈希 */
export function computeResultHash(content: string, toolCalls?: unknown[]): string {
  const hash = createHash('sha256');
  hash.update(content);
  if (toolCalls && toolCalls.length > 0) {
    hash.update('|');
    hash.update(JSON.stringify(toolCalls));
  }
  return hash.digest('hex');
}

export interface BuildModelRouteReceiptInput {
  traceId: string;
  callSource: string;
  requestedProvider?: string;
  requestedModel?: string;
  executedProvider: string;
  executedModel: string;
  routeReasonCodes: readonly string[];
  fallbackOccurred: boolean;
  fallbackChain: readonly string[];
  capabilityDelta: readonly string[];
  promptVersion: string;
  policyBundleHash: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  createdAt: string;
}

/**
 * 构建 ModelRouteReceipt (设计文档第 4.2 节)
 *
 * 记录请求模型和实际模型, fallback 链完整保留
 */
export function buildModelRouteReceipt(input: BuildModelRouteReceiptInput): ModelRouteReceipt {
  return {
    schema: 'awkn-model-route-receipt/v1',
    routeId: createAwknId('modelRoute'),
    traceId: input.traceId,
    callSource: input.callSource,
    requestedProvider: input.requestedProvider,
    requestedModel: input.requestedModel,
    executedProvider: input.executedProvider,
    executedModel: input.executedModel,
    routeReasonCodes: [...input.routeReasonCodes],
    fallbackOccurred: input.fallbackOccurred,
    fallbackChain: [...input.fallbackChain],
    capabilityDelta: [...input.capabilityDelta],
    promptVersion: input.promptVersion,
    policyBundleHash: input.policyBundleHash,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    latencyMs: input.latencyMs,
    createdAt: input.createdAt,
  };
}

export interface BuildDegradationNoticeInput {
  level: DegradationLevel;
  capabilityDelta: readonly string[];
  fallbackChain: readonly string[];
  requiresReconfirmation: boolean;
  structuredOutputMissing: boolean;
  reviewerReuseForbidden: boolean;
}

/**
 * 构建可见降级通知 (设计文档第 4.3 节)
 *
 * 当 fallback 可能影响结果质量或工具能力时:
 * - Run 标记 DEGRADED
 * - Delivery 附带能力影响摘要
 * - 高影响任务可以要求重新确认
 * - 独立 Reviewer 禁止回退到执行模型
 * - 结构化输出能力缺失时停止执行
 */
export function buildDegradationNotice(input: BuildDegradationNoticeInput): DegradationNotice {
  return {
    schema: 'awkn-degradation-notice/v1',
    level: input.level,
    capabilityDelta: [...input.capabilityDelta],
    fallbackChain: [...input.fallbackChain],
    requiresReconfirmation: input.requiresReconfirmation,
    structuredOutputMissing: input.structuredOutputMissing,
    reviewerReuseForbidden: input.reviewerReuseForbidden,
  };
}

/**
 * 判断是否需要因结构化输出能力缺失而停止执行
 *
 * 设计文档第 4.3 节: 结构化输出能力缺失时停止执行
 */
export function shouldStopForStructuredOutputMissing(notice: DegradationNotice): boolean {
  return notice.structuredOutputMissing && notice.level === 'BLOCKING';
}

/**
 * 判断 Reviewer 是否禁止回退到执行模型
 *
 * 设计文档第 4.3 节: 独立 Reviewer 禁止回退到执行模型
 */
export function isReviewerReuseForbidden(notice: DegradationNotice): boolean {
  return notice.reviewerReuseForbidden;
}
