/**
 * Execution Coordinator (R2 Shadow Integration Phase 4b)
 *
 * 编排 WP02—05 Ports，按 Feature Flag 值决定路径：
 * - '0'       只调用 Input Port，生成 RECEIVED 状态 Envelope（Engine v2 接管后续）
 * - 'shadow'  调用全部 4 个 Port，生成 ROUTED/CONTEXT_READY 状态 Envelope（旁路比较，不写外部副作用）
 * - 'enforce' 调用全部 4 个 Port，生成 ROUTED/CONTEXT_READY 状态 Envelope（Agent OS 3.0 权威）
 *
 * 关键不变量：
 * 1. 每次 createExecution 创建独立 FeatureFlagSnapshot（多 Execution 并发不互相影响）
 * 2. Snapshot 冻结后不接受热更新（FeatureFlagRegistry.freeze 后 frozen=true）
 * 3. Port 错误直接传播（fail-closed，遵循 E96）
 * 4. ExecutionCoordinator 不持久化；持久化是 EventStore 的工作
 * 5. ExecutionCoordinator 不产生 Shadow Diff；Diff 是 Phase 4d/4e 的工作
 */

import {
  ExecutionEnvelopeSchema,
  IntentDecisionSchema,
  IntentRouterInputSchema,
  IntentReceiptPayloadSchema,
  ContextManifestSchema,
  ClaimResolutionResultSchema,
  ContextPlannerInputSchema,
  ClaimResolutionInputSchema,
  createAwknId,
  receiptPayloadHash,
  type ActorRef,
  type AgentOsFlag,
  type ClaimResolutionInput,
  type ClaimResolutionResult,
  type ContextManifest,
  type ContextPlannerInput,
  type ExecutionEnvelope,
  type ExecutionScope,
  type FeatureFlagSnapshot,
  type FeatureFlagValue,
  type IntentDecision,
  type IntentReceiptPayload,
  type IntentRouterInput,
  type ObjectRef,
  type ReceiptEnvelope,
} from '../contracts/public.js';
import { FeatureFlagRegistry } from '../feature-flag/feature-flag-registry.js';
import type {
  ExecutionPorts,
  InputReceiptBuilderPort,
  IntentReceiptPayloadBuilderPort,
} from './ports.js';

/**
 * ExecutionCoordinator 依赖。
 *
 * ports：WP02—05 Port 实例（函数引用）
 * flagConfig：部署级配置（applyConfig 的输入）
 * env：环境变量（applyEnv 的输入）
 * clock：UTC 时间源（测试时可注入；默认 new Date().toISOString()）
 */
export interface ExecutionCoordinatorDeps {
  readonly ports: ExecutionPorts;
  readonly inputReceiptBuilder: InputReceiptBuilderPort;
  readonly intentReceiptPayloadBuilder: IntentReceiptPayloadBuilderPort;
  readonly flagConfig?: Partial<Record<AgentOsFlag, FeatureFlagValue>>;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly clock?: () => string;
}

/**
 * 创建 Execution 的请求。
 *
 * executionId/traceId：可选；未提供时自动生成
 * rawInput：原始输入（string 或 Uint8Array）
 * intentRouterInput：Intent Router 输入（不含 schema/inputId/sourceHash/createdAt，由 Coordinator 补全）
 * contextPlannerInput：Context Planner 输入（不含 schema，由 Coordinator 补全）
 * claimResolutionInput：可选；Claim Resolution 输入（Context flag 为 '0' 时可省略）
 * flagOverrides：Execution 级 Override（最高优先级）
 */
export interface CreateExecutionRequest {
  readonly executionId?: string;
  readonly traceId?: string;
  readonly actor: ActorRef;
  readonly scope: ExecutionScope;
  readonly rawInput: string | Uint8Array;
  readonly intentRouterInput: Omit<IntentRouterInput, 'schema' | 'inputId' | 'sourceHash' | 'createdAt'>;
  readonly contextPlannerInput: Omit<ContextPlannerInput, 'schema'>;
  readonly claimResolutionInput?: ClaimResolutionInput;
  readonly flagOverrides?: Partial<Record<AgentOsFlag, FeatureFlagValue>>;
}

/**
 * Execution 句柄：包含 Envelope + Flag Snapshot + 各 Port 产物。
 *
 * envelope：ExecutionEnvelope（状态机当前状态）
 * flagSnapshot：本次 Execution 冻结的 Flag Snapshot（L3/L4 恢复时复用）
 * inputReceipt：Input Port 产物
 * intentReceipt：Intent Port 产物（Input flag='0' 时为 undefined）
 * intentDecision：Intent Decision（Input flag='0' 时为 undefined）
 * contextManifest：Context Planner 产物（Context flag='0' 时为 undefined）
 * claimResolutionResult：Claim Resolver 产物（未提供 claimResolutionInput 时为 undefined）
 */
export interface ExecutionHandle {
  readonly envelope: ExecutionEnvelope;
  readonly flagSnapshot: FeatureFlagSnapshot;
  readonly inputReceipt: ReceiptEnvelope;
  readonly intentReceipt?: ReceiptEnvelope;
  readonly intentDecision?: IntentDecision;
  readonly contextManifest?: ContextManifest;
  readonly claimResolutionResult?: ClaimResolutionResult;
}

function defaultClock(): string {
  return new Date().toISOString();
}

function makeObjectRef(
  objectType: string,
  objectId: string,
  schemaId: string,
  contentHash?: string,
): ObjectRef {
  const ref: ObjectRef = {
    schema: 'awkn-object-ref/v1',
    objectType,
    objectId,
    schemaId,
  };
  if (contentHash !== undefined) ref.contentHash = contentHash;
  return ref;
}

function buildIntentReceiptEnvelope(
  executionId: string,
  traceId: string,
  producer: ActorRef,
  decision: IntentDecision,
  payload: IntentReceiptPayload,
  createdAt: string,
): ReceiptEnvelope {
  return {
    schema: 'awkn-receipt-envelope/v1',
    receiptId: createAwknId('receipt'),
    receiptType: 'INTENT',
    payloadSchema: payload.schema,
    executionId,
    traceId,
    aggregateType: 'intent-decision',
    aggregateId: decision.intentId,
    producer,
    status: 'SUCCESS',
    payload,
    payloadHash: receiptPayloadHash(payload.schema, payload),
    artifactRefs: [makeObjectRef('intent-decision', decision.intentId, decision.schema)],
    createdAt,
  };
}

function buildContextReceiptEnvelope(
  executionId: string,
  traceId: string,
  producer: ActorRef,
  manifest: ContextManifest,
  createdAt: string,
): ReceiptEnvelope {
  const payload = {
    schema: 'awkn-context-receipt/v1',
    contextId: manifest.contextId,
    executionId: manifest.executionId,
    status: manifest.status,
    selectedTokenCount: manifest.selectedTokenCount,
    blockingReasonCodes: manifest.blockingReasonCodes,
    plannerVersion: manifest.plannerVersion,
    createdAt,
  };
  return {
    schema: 'awkn-receipt-envelope/v1',
    receiptId: createAwknId('receipt'),
    receiptType: 'CONTEXT',
    payloadSchema: 'awkn-context-receipt/v1',
    executionId,
    traceId,
    aggregateType: 'context-manifest',
    aggregateId: manifest.contextId,
    producer,
    status: manifest.status === 'READY' ? 'SUCCESS' : 'FAILURE',
    payload,
    payloadHash: receiptPayloadHash('awkn-context-receipt/v1', payload),
    artifactRefs: [makeObjectRef('context-manifest', manifest.contextId, manifest.schema, manifest.manifestHash)],
    createdAt,
  };
}

/**
 * ExecutionCoordinator：编排 WP02—05 Port，按 Flag 值决定路径。
 *
 * 不变量：
 * - 无状态：所有 Execution 共享同一 Coordinator，但每次 createExecution 创建独立 Snapshot
 * - fail-closed：Port 抛错直接传播
 * - 不持久化：返回 ExecutionHandle，由调用方决定是否写 EventStore
 */
export class ExecutionCoordinator {
  constructor(private readonly deps: ExecutionCoordinatorDeps) {}

  /**
   * 创建 Execution。
   *
   * 步骤：
   * 1. 为本次 Execution 创建独立 FeatureFlagRegistry（基于 deps.env + deps.flagConfig + request.flagOverrides）
   * 2. Freeze FlagSnapshot
   * 3. 根据 Input flag 值决定路径：
   *    - '0'：只调用 Input Port，生成 RECEIVED 状态 Envelope
   *    - 'shadow'/'enforce'：调用全部 4 个 Port，生成 ROUTED/CONTEXT_READY 状态 Envelope
   * 4. 返回 ExecutionHandle
   *
   * @throws {FeatureFlagError} Flag 依赖不满足、值非法、Registry 已冻结
   * @throws Port 抛出的任何错误（fail-closed）
   */
  createExecution(request: CreateExecutionRequest): ExecutionHandle {
    const clock = this.deps.clock ?? defaultClock;
    const now = clock();
    const executionId = request.executionId ?? createAwknId('execution');
    const traceId = request.traceId ?? createAwknId('trace');

    // Step 1: 为本次 Execution 创建独立 Registry
    const registry = new FeatureFlagRegistry();
    if (this.deps.env !== undefined) registry.applyEnv(this.deps.env);
    if (this.deps.flagConfig !== undefined) registry.applyConfig(this.deps.flagConfig);
    if (request.flagOverrides !== undefined) {
      for (const [flag, value] of Object.entries(request.flagOverrides)) {
        registry.applyOverride(flag as AgentOsFlag, value as FeatureFlagValue);
      }
    }

    // Step 2: Freeze FlagSnapshot（验证依赖、生成 hash、标记 frozen）
    const flagSnapshot = registry.freeze();

    // Step 3: 调用 Input Port（所有 flag 值都需要）
    const parseResult = this.deps.ports.inputGateway.parse(request.rawInput);
    if (!parseResult.ok) {
      // Input 拒绝：生成 RECEIVED 状态 Envelope，状态标记为 BLOCKED
      const failedReceiptPayload = parseResult.receiptPayload;
      const failedInputReceipt = this.deps.inputReceiptBuilder.build({
        executionId,
        traceId,
        producer: request.actor,
        payload: failedReceiptPayload,
        createdAt: now,
      });
      const envelope = ExecutionEnvelopeSchema.parse({
        schema: 'awkn-execution-envelope/v1',
        executionId,
        traceId,
        revision: 0,
        actor: request.actor,
        scope: request.scope,
        inputRef: makeObjectRef(
          'input-json',
          failedReceiptPayload.sourceHash,
          failedReceiptPayload.schema,
          failedReceiptPayload.sourceHash,
        ),
        runRefs: [],
        deliveryRefs: [],
        memoryDecisionRefs: [],
        evolutionCandidateRefs: [],
        featureFlagsRef: makeObjectRef(
          'feature-flag-snapshot',
          flagSnapshot.snapshotId,
          flagSnapshot.schema,
          flagSnapshot.sourceHash,
        ),
        state: 'BLOCKED',
        createdAt: now,
        updatedAt: now,
      });
      return { envelope, flagSnapshot, inputReceipt: failedInputReceipt };
    }

    const document = parseResult.document;
    const inputReceiptPayload = parseResult.receiptPayload;
    const inputReceipt = this.deps.inputReceiptBuilder.build({
      executionId,
      traceId,
      producer: request.actor,
      payload: inputReceiptPayload,
      createdAt: now,
    });

    const inputFlagValue = flagSnapshot.flags.AWKN_INPUT_GATEWAY_V1;
    if (inputFlagValue === '0') {
      // Engine v2 接管后续：只生成 RECEIVED 状态 Envelope
      const envelope = ExecutionEnvelopeSchema.parse({
        schema: 'awkn-execution-envelope/v1',
        executionId,
        traceId,
        revision: 0,
        actor: request.actor,
        scope: request.scope,
        inputRef: makeObjectRef(
          'input-json',
          document.sourceHash,
          document.schema,
          document.sourceHash,
        ),
        runRefs: [],
        deliveryRefs: [],
        memoryDecisionRefs: [],
        evolutionCandidateRefs: [],
        featureFlagsRef: makeObjectRef(
          'feature-flag-snapshot',
          flagSnapshot.snapshotId,
          flagSnapshot.schema,
          flagSnapshot.sourceHash,
        ),
        state: 'RECEIVED',
        createdAt: now,
        updatedAt: now,
      });
      return { envelope, flagSnapshot, inputReceipt };
    }

    // 'shadow' 或 'enforce'：调用全部 4 个 Port
    // inputId 必须符合 `in_<32hex>` 格式（awknIdSchema('in')）
    // 用 inputReceipt.receiptId 会失败（receiptId 前缀是 'rcpt'）
    // 为本 Execution 生成独立的 inputId，并通过 inputRef 关联到 InputReceipt
    const intentId = createAwknId('intent');
    const inputId = createAwknId('input');
    const intentRouterInput = IntentRouterInputSchema.parse({
      ...request.intentRouterInput,
      schema: 'awkn-intent-router-input/v1',
      inputId,
      sourceHash: document.sourceHash,
      createdAt: now,
    });
    const intentDecision = this.deps.ports.intentRouter.route({
      intentId,
      input: intentRouterInput,
      routedAt: now,
    });
    IntentDecisionSchema.parse(intentDecision);
    const intentReceiptPayload = this.deps.intentReceiptPayloadBuilder.buildPayload(intentDecision);
    IntentReceiptPayloadSchema.parse(intentReceiptPayload);
    const intentReceipt = buildIntentReceiptEnvelope(
      executionId,
      traceId,
      request.actor,
      intentDecision,
      intentReceiptPayload,
      now,
    );

    // Context Planner
    const contextPlannerInput = ContextPlannerInputSchema.parse({
      ...request.contextPlannerInput,
      schema: 'awkn-context-planner-input/v1',
    });
    const contextManifest = this.deps.ports.contextPlanner.plan(contextPlannerInput);
    ContextManifestSchema.parse(contextManifest);
    const contextReceipt = buildContextReceiptEnvelope(
      executionId,
      traceId,
      request.actor,
      contextManifest,
      now,
    );

    // Claim Resolver（可选）
    let claimResolutionResult: ClaimResolutionResult | undefined;
    let claimReceipt: ReceiptEnvelope | undefined;
    if (request.claimResolutionInput !== undefined) {
      const claimInput = ClaimResolutionInputSchema.parse(request.claimResolutionInput);
      claimResolutionResult = this.deps.ports.claimResolver.resolve(claimInput);
      ClaimResolutionResultSchema.parse(claimResolutionResult);
      const claimPayload = {
        schema: 'awkn-claim-resolution-receipt/v1',
        usableClaimIds: claimResolutionResult.usableClaimIds,
        exclusions: claimResolutionResult.exclusions,
        groupCount: claimResolutionResult.groups.length,
        resolverVersion: claimResolutionResult.resolverVersion,
        createdAt: now,
      };
      claimReceipt = {
        schema: 'awkn-receipt-envelope/v1',
        receiptId: createAwknId('receipt'),
        receiptType: 'CONTEXT',
        payloadSchema: 'awkn-claim-resolution-receipt/v1',
        executionId,
        traceId,
        aggregateType: 'claim-resolution',
        aggregateId: claimResolutionResult.resolverVersion,
        producer: request.actor,
        status: 'SUCCESS',
        payload: claimPayload,
        payloadHash: receiptPayloadHash('awkn-claim-resolution-receipt/v1', claimPayload),
        artifactRefs: [
          makeObjectRef(
            'claim-resolution',
            claimResolutionResult.resolverVersion,
            claimResolutionResult.schema,
          ),
        ],
        createdAt: now,
      };
    }

    const envelopeState = contextManifest.status === 'READY' ? 'CONTEXT_READY' : 'BLOCKED';
    const envelope = ExecutionEnvelopeSchema.parse({
      schema: 'awkn-execution-envelope/v1',
      executionId,
      traceId,
      revision: 0,
      actor: request.actor,
      scope: request.scope,
      inputRef: makeObjectRef(
        'input-json',
        document.sourceHash,
        document.schema,
        document.sourceHash,
      ),
      intentRef: makeObjectRef(
        'intent-decision',
        intentDecision.intentId,
        intentDecision.schema,
      ),
      contextRef: makeObjectRef(
        'context-manifest',
        contextManifest.contextId,
        contextManifest.schema,
        contextManifest.manifestHash,
      ),
      runRefs: [],
      deliveryRefs: [],
      memoryDecisionRefs: [],
      evolutionCandidateRefs: [],
      featureFlagsRef: makeObjectRef(
        'feature-flag-snapshot',
        flagSnapshot.snapshotId,
        flagSnapshot.schema,
        flagSnapshot.sourceHash,
      ),
      state: envelopeState,
      createdAt: now,
      updatedAt: now,
    });

    void contextReceipt;
    void claimReceipt;

    return {
      envelope,
      flagSnapshot,
      inputReceipt,
      intentReceipt,
      intentDecision,
      contextManifest,
      claimResolutionResult,
    };
  }
}
