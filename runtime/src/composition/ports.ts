/**
 * Composition Root Ports (R2 Shadow Integration Phase 4b)
 *
 * 这些 Port 接口是 ExecutionCoordinator 与 WP02—05 Application 层之间的契约边界。
 *
 * 设计原则：
 * - Port 是函数引用（不是类），因为 application 层已是纯函数
 * - Port 抛错直接传播（fail-closed），不吞错（E96）
 * - Port 不负责持久化；ExecutionCoordinator 也不持久化（持久化是 EventStore 的工作）
 * - 测试时可注入 mock 函数；运行时注入真实 application 层函数
 */

import type {
  ActorRef,
  ClaimResolutionInput,
  ClaimResolutionResult,
  ContextManifest,
  ContextPlannerInput,
  InputJsonReceiptPayload,
  IntentDecision,
  IntentRouterInput,
  ReceiptEnvelope,
  TrustedJsonDocument,
} from '../contracts/public.js';

/**
 * WP02 Trusted Input Port
 *
 * Mode 0 已实现于 `src/input/application/trusted-json-parser.ts` 的 `parseTrustedJson`。
 * Mode 0 已实现于 `src/input/application/input-receipt.ts` 的 `buildInputJsonReceipt`。
 */
export interface InputGatewayPort {
  parse(
    input: string | Uint8Array,
  ): {
    ok: true;
    document: TrustedJsonDocument;
    receiptPayload: InputJsonReceiptPayload;
  } | {
    ok: false;
    receiptPayload: InputJsonReceiptPayload;
  };
}

/**
 * WP03 Intent Router Port
 *
 * 实现于 `src/intent/application/intent-router.ts` 的 `routeIntent`。
 */
export interface IntentRouterPort {
  route(command: {
    intentId: string;
    input: IntentRouterInput;
    routedAt: string;
  }): IntentDecision;
}

/**
 * WP04 Claim Ledger Port
 *
 * 实现于 `src/context/claim-ledger/application/claim-resolver.ts` 的 `resolveClaims`。
 */
export interface ClaimResolverPort {
  resolve(input: ClaimResolutionInput): ClaimResolutionResult;
}

/**
 * WP05 Context Planner Port
 *
 * 实现于 `src/context/planner/application/context-planner.ts` 的 `planContext`。
 */
export interface ContextPlannerPort {
  plan(input: ContextPlannerInput): ContextManifest;
}

/**
 * WP02—05 Port 包，注入 ExecutionCoordinator。
 *
 * 每个 Port 都是独立的函数引用；ExecutionCoordinator 通过此结构访问所有 Port。
 */
export interface ExecutionPorts {
  readonly inputGateway: InputGatewayPort;
  readonly intentRouter: IntentRouterPort;
  readonly claimResolver: ClaimResolverPort;
  readonly contextPlanner: ContextPlannerPort;
}

/**
 * Input Receipt 构造器 Port（与 InputGatewayPort 分离）
 *
 * 实现于 `src/input/application/input-receipt.ts` 的 `buildInputJsonReceipt`。
 * 分离原因：parse 与 build-receipt 是不同关注点；receipt 构造需要 executionId/traceId/producer 上下文。
 */
export interface InputReceiptBuilderPort {
  build(request: {
    executionId: string;
    traceId: string;
    producer: ActorRef;
    payload: InputJsonReceiptPayload;
    createdAt: string;
    receiptId?: string;
  }): ReceiptEnvelope;
}

/**
 * Intent Receipt 构造器 Port
 *
 * 实现于 `src/intent/application/intent-router.ts` 的 `buildIntentReceiptPayload`。
 * 注意：intent-router.ts 只构造 payload，envelope 构造由调用方负责。
 */
export interface IntentReceiptPayloadBuilderPort {
  buildPayload(decision: IntentDecision): import('../contracts/public.js').IntentReceiptPayload;
}
