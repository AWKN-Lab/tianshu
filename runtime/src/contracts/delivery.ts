/**
 * Delivery Router Contracts (Phase 6 / C07 / WP-AOS-12)
 *
 * 设计文档: `docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md` 第二节
 *
 * 本文件冻结 Delivery Router 的所有公开 Contract：
 * - ResourceRefSchema: 资源引用（路径/URI）
 * - ArtifactRequirementSchema: 产物需求声明
 * - ArtifactRefSchema: 已生成产物引用
 * - DeliveryModeSchema: 交付模式枚举
 * - DeliverySideEffectSchema: 副作用枚举
 * - DeliveryFailurePolicySchema: 失败策略枚举
 * - DeliveryBundleStateSchema: Bundle 状态枚举
 * - DeliveryVerificationStatusSchema: 验证状态枚举
 * - DeliveryContractSchema (awkn-delivery-contract/v1): 单次交付契约
 * - DeliveryBundleSchema (awkn-delivery-bundle/v1): 同一 Execution 的交付束
 * - DeliveryReceiptSchema (awkn-delivery-receipt/v1): 交付回执
 *
 * 不变量：
 * - 所有 schema 使用 zod strict + superRefine
 * - 所有 hash 使用 stableHash（canonical-json.ts）
 * - 所有 ID 使用 createAwknId / awknIdSchema
 * - 所有时间戳使用 UtcTimestampSchema
 * - canonical JSON 不允许 undefined 字段，哈希前需 stripUndefined
 * - fail-closed：未知状态归为 UNKNOWN
 * - Delivery 与 Execution 状态完全分离
 * - 同一 Execution 可产生多个 Delivery，必须指定 Primary
 * - Delivery Receipt 必须包含产物 Hash 和验证状态
 */

import { z } from 'zod';
import { stableHash } from './canonical-json.js';
import { awknIdSchema, createAwknId } from './ids.js';
import { JsonValueSchema, type JsonValue } from './json-value.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ===== Section 1: Enums =====

/**
 * 交付模式（设计文档 2.1）
 *
 * | 用户目标 | Mode |
 * |---|---|
 * | 理解、解释、判断 | CHAT |
 * | 保存、下载、提交、分享 | FILE |
 * | 查看结构、关系、流程 | VISUAL |
 * | 持续交互和保存应用状态 | ARTIFACT_APP |
 * | 修改邮件、日历、GitHub等外部系统 | CONNECTED_SYSTEM |
 * | 未来或周期执行 | SCHEDULED_TASK |
 */
export const DeliveryModeSchema = z.enum([
  'CHAT',
  'FILE',
  'VISUAL',
  'ARTIFACT_APP',
  'CONNECTED_SYSTEM',
  'SCHEDULED_TASK',
]);
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

/**
 * 交付副作用类型
 *
 * - none: 无副作用（如 CHAT 纯展示）
 * - local_write: 本地可逆写入（如 FILE 写入工作区）
 * - external_write: 外部系统写入（如 CONNECTED_SYSTEM 修改 Gmail）
 * - scheduled: 周期或未来执行（如 SCHEDULED_TASK）
 */
export const DeliverySideEffectSchema = z.enum([
  'none',
  'local_write',
  'external_write',
  'scheduled',
]);
export type DeliverySideEffect = z.infer<typeof DeliverySideEffectSchema>;

/**
 * 交付失败处理策略
 *
 * - RETRY: 重试
 * - PARTIAL: 部分成功可接受
 * - ROLLBACK: 回滚已执行副作用
 * - WAIT_USER: 等待用户介入
 * - FAIL: 直接失败
 */
export const DeliveryFailurePolicySchema = z.enum([
  'RETRY',
  'PARTIAL',
  'ROLLBACK',
  'WAIT_USER',
  'FAIL',
]);
export type DeliveryFailurePolicy = z.infer<typeof DeliveryFailurePolicySchema>;

/**
 * Delivery Bundle 状态（设计文档 2.3）
 *
 * 状态机：
 *   PENDING → RUNNING → SUCCEEDED
 *                     → FAILED
 *                     → PARTIAL（部分成功且 failurePolicy=PARTIAL）
 *
 * fail-closed：未知状态归为 PENDING 重新评估，禁止伪装成功。
 */
export const DeliveryBundleStateSchema = z.enum([
  'PENDING',
  'RUNNING',
  'PARTIAL',
  'SUCCEEDED',
  'FAILED',
]);
export type DeliveryBundleState = z.infer<typeof DeliveryBundleStateSchema>;

/**
 * 交付验证状态
 *
 * - UNVERIFIED: 未验证
 * - TOOL_REPORTED: 仅工具报告（未独立验证）
 * - VERIFIED: 已独立验证
 * - MISMATCH: 工具报告与验证结果不一致
 * - UNKNOWN: 未知（fail-closed）
 */
export const DeliveryVerificationStatusSchema = z.enum([
  'UNVERIFIED',
  'TOOL_REPORTED',
  'VERIFIED',
  'MISMATCH',
  'UNKNOWN',
]);
export type DeliveryVerificationStatus = z.infer<typeof DeliveryVerificationStatusSchema>;

// ===== Section 2: ResourceRef & Artifact =====

/**
 * 资源引用 Schema
 *
 * 用于指定 Delivery 的目标资源位置（路径、URI、外部系统资源 ID 等）。
 */
export const ResourceRefSchema = z.object({
  schema: z.literal('awkn-resource-ref/v1'),
  /** 资源类型：file_path / uri / external_resource / artifact_app 等 */
  resourceType: z.string().min(1),
  /** 资源标识（路径、URI、外部资源 ID） */
  resourceId: z.string().min(1),
  /** 资源所属系统（如 local / gmail / github / artifact_app） */
  system: z.string().min(1).optional(),
  /** 附加约束（如 gmail message ID、github repo 等） */
  constraints: z.record(JsonValueSchema).default({}),
}).strict();
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

/**
 * 产物需求 Schema
 *
 * 在 Delivery Contract 中声明的产物需求：执行后必须产生哪些产物才能交付。
 */
export const ArtifactRequirementSchema = z.object({
  artifactId: z.string().min(1),
  /** 产物类型：file / content / artifact_app_state / external_resource 等 */
  artifactType: z.string().min(1),
  /** 产物描述（用于人类可读） */
  description: z.string().min(1),
  /** 是否必需（true 表示交付前必须生成） */
  required: z.boolean(),
  /** 接受的内容 Hash 算法（默认 sha256） */
  hashAlgorithm: z.string().min(1).default('sha256'),
}).strict();
export type ArtifactRequirement = z.infer<typeof ArtifactRequirementSchema>;

/**
 * 产物引用 Schema
 *
 * 实际生成的产物引用，包含内容 Hash 用于完整性校验。
 */
export const ArtifactRefSchema = z.object({
  schema: z.literal('awkn-artifact-ref/v1'),
  artifactId: z.string().min(1),
  artifactType: z.string().min(1),
  /** 产物内容 Hash（SHA256 hex） */
  contentHash: z.string().regex(SHA256_HEX_PATTERN),
  /** 产物位置（路径、URI、外部资源 ID） */
  location: z.string().min(1),
  /** 生成产物的工具调用 ID（可选，用于溯源） */
  producedByToolCallId: awknIdSchema('tc').optional(),
  /** 生成时间 */
  createdAt: UtcTimestampSchema,
}).strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

// ===== Section 3: Delivery Contract (awkn-delivery-contract/v1) =====

/**
 * Delivery Contract Schema (awkn-delivery-contract/v1)
 *
 * 设计文档 2.2。
 *
 * 不变量：
 * - 同一 Bundle 中只能有一个 primary=true 的 Contract
 * - mode=CONNECTED_SYSTEM / SCHEDULED_TASK 时 requiresAuthorization 通常为 true
 * - mode=CHAT / VISUAL 时 sideEffect 通常为 none
 * - mode=FILE 时 sideEffect 通常为 local_write
 * - requiredArtifacts 至少包含一项 required=true（除非 mode=CHAT 纯对话）
 * - deliveryId 必须是 dlv_ 前缀
 */
export const DeliveryContractSchema = z.object({
  schema: z.literal('awkn-delivery-contract/v1'),
  deliveryId: awknIdSchema('dlv'),
  executionId: awknIdSchema('exec'),
  mode: DeliveryModeSchema,
  target: ResourceRefSchema.optional(),
  format: z.string().min(1).optional(),
  primary: z.boolean(),
  sideEffect: DeliverySideEffectSchema,
  requiresAuthorization: z.boolean(),
  requiredArtifacts: z.array(ArtifactRequirementSchema),
  successPredicate: JsonValueSchema,
  failurePolicy: DeliveryFailurePolicySchema,
}).strict().superRefine((value, context) => {
  // 外部写入或调度任务必须要求授权
  if ((value.sideEffect === 'external_write' || value.sideEffect === 'scheduled')
    && !value.requiresAuthorization) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requiresAuthorization'],
      message: `${value.sideEffect} sideEffect requires authorization`,
    });
  }
  // CHAT 模式不应有副作用
  if (value.mode === 'CHAT' && value.sideEffect !== 'none') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sideEffect'],
      message: 'CHAT mode must have none sideEffect',
    });
  }
  // CONNECTED_SYSTEM 必须有 target
  if (value.mode === 'CONNECTED_SYSTEM' && value.target === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'CONNECTED_SYSTEM mode requires target resource',
    });
  }
  // SCHEDULED_TASK 必须有 target（指向调度器）
  if (value.mode === 'SCHEDULED_TASK' && value.target === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'SCHEDULED_TASK mode requires target scheduler resource',
    });
  }
});
export type DeliveryContract = z.infer<typeof DeliveryContractSchema>;

export const DELIVERY_CONTRACT_SCHEMA_ID = 'awkn-delivery-contract/v1';

// ===== Section 4: Delivery Receipt (awkn-delivery-receipt/v1) =====

/**
 * Delivery Receipt Schema (awkn-delivery-receipt/v1)
 *
 * 设计文档 2.4。每次实际交付完成后必须生成 Receipt。
 *
 * 必须包含：
 * - 实际交付位置（actualLocation）
 * - 产物 Hash（artifactHash，若产物存在）
 * - 外部资源 ID（externalResourceId，若涉及外部系统）
 * - 工具报告状态和验证状态
 * - 是否可撤回
 * - 失败原因和重试语义
 *
 * 不变量：
 * - 失败时 failureReason 必须非空
 * - verificationStatus=VERIFIED 时 toolReportedStatus 应为 SUCCESS（不一致归为 MISMATCH）
 * - reversible=true 时应记录补偿路径（外部系统写入应有补偿方案）
 */
export const DeliveryReceiptSchema = z.object({
  schema: z.literal('awkn-delivery-receipt/v1'),
  receiptId: awknIdSchema('rcpt'),
  deliveryId: awknIdSchema('dlv'),
  /** 实际交付位置（路径、URI、消息 ID 等） */
  actualLocation: z.string().min(1),
  /** 产物 Hash（SHA256 hex，若产物存在） */
  artifactHash: z.string().regex(SHA256_HEX_PATTERN).optional(),
  /** 外部资源 ID（如 gmail message ID、github commit SHA） */
  externalResourceId: z.string().min(1).optional(),
  /** 工具报告状态 */
  toolReportedStatus: z.enum(['SUCCESS', 'FAILURE', 'PARTIAL', 'UNKNOWN']),
  /** 独立验证状态 */
  verificationStatus: DeliveryVerificationStatusSchema,
  /** 是否可撤回 */
  reversible: z.boolean(),
  /** 失败原因（失败时必填） */
  failureReason: z.string().min(1).optional(),
  /** 重试语义（描述如何重试：retry_count/max_retries/backoff 等） */
  retrySemantics: z.string().min(1).optional(),
  /** 补偿路径（reversible=true 时建议填写） */
  compensationRef: z.string().min(1).optional(),
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  // 失败状态必须填写 failureReason
  if (value.toolReportedStatus !== 'SUCCESS' && value.failureReason === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['failureReason'],
      message: 'failureReason is required when toolReportedStatus is not SUCCESS',
    });
  }
  // MISMATCH 状态应有 failureReason（工具报告与验证不一致）
  if (value.verificationStatus === 'MISMATCH' && value.failureReason === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['failureReason'],
      message: 'MISMATCH verification requires failureReason explaining the discrepancy',
    });
  }
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

export const DELIVERY_RECEIPT_SCHEMA_ID = 'awkn-delivery-receipt/v1';

// ===== Section 5: Delivery Bundle (awkn-delivery-bundle/v1) =====

/**
 * Delivery Bundle Schema (awkn-delivery-bundle/v1)
 *
 * 设计文档 2.3。同一 Execution 的所有 Delivery Contract 集合。
 *
 * 不变量：
 * - 必须有且仅有一个 primary=true 的 Contract（primaryDeliveryId 指向它）
 * - contracts 至少包含一项
 * - primaryDeliveryId 必须存在于 contracts 中
 * - receipts 引用的 deliveryId 必须存在于 contracts 中
 * - state=PENDING 时 receipts 应为空
 * - state=SUCCEEDED 时所有 receipts 的 toolReportedStatus=SUCCESS
 * - state=FAILED 时至少有一个 receipt 的 toolReportedStatus != SUCCESS
 */
export const DeliveryBundleSchema = z.object({
  schema: z.literal('awkn-delivery-bundle/v1'),
  bundleId: awknIdSchema('dlv'),
  executionId: awknIdSchema('exec'),
  contracts: z.array(DeliveryContractSchema).min(1),
  artifacts: z.array(ArtifactRefSchema),
  receipts: z.array(DeliveryReceiptSchema),
  primaryDeliveryId: awknIdSchema('dlv'),
  state: DeliveryBundleStateSchema,
  createdAt: UtcTimestampSchema,
  finalizedAt: UtcTimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  // 必须有且仅有一个 primary
  const primaries = value.contracts.filter((c) => c.primary);
  if (primaries.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contracts'],
      message: 'at least one primary delivery contract is required',
    });
  } else if (primaries.length > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contracts'],
      message: `exactly one primary delivery contract is required, found ${primaries.length}`,
    });
  }
  // primaryDeliveryId 必须指向 primary=true 的 contract
  if (primaries.length === 1) {
    const primaryContract = primaries[0];
    if (primaryContract && primaryContract.deliveryId !== value.primaryDeliveryId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['primaryDeliveryId'],
        message: 'primaryDeliveryId must match the primary contract deliveryId',
      });
    }
  }
  // primaryDeliveryId 必须存在于 contracts
  const contractIds = new Set(value.contracts.map((c) => c.deliveryId));
  if (!contractIds.has(value.primaryDeliveryId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['primaryDeliveryId'],
      message: 'primaryDeliveryId must reference an existing contract',
    });
  }
  // 同一 Bundle 内 deliveryId 不能重复
  const seenDeliveryIds = new Set<string>();
  const duplicateDeliveryIds = new Set<string>();
  for (const contract of value.contracts) {
    if (seenDeliveryIds.has(contract.deliveryId)) {
      duplicateDeliveryIds.add(contract.deliveryId);
    }
    seenDeliveryIds.add(contract.deliveryId);
  }
  if (duplicateDeliveryIds.size > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contracts'],
      message: `duplicate deliveryId in bundle: ${[...duplicateDeliveryIds].sort().join(', ')}`,
    });
  }
  // receipts 引用的 deliveryId 必须存在于 contracts
  for (const [index, receipt] of value.receipts.entries()) {
    if (!contractIds.has(receipt.deliveryId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receipts', index, 'deliveryId'],
        message: `receipt references unknown deliveryId: ${receipt.deliveryId}`,
      });
    }
  }
  // PENDING 状态时不应有 receipts
  if (value.state === 'PENDING' && value.receipts.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['receipts'],
      message: 'PENDING bundle must not have receipts',
    });
  }
  // SUCCEEDED 状态时所有 receipts 必须 SUCCESS
  if (value.state === 'SUCCEEDED') {
    for (const [index, receipt] of value.receipts.entries()) {
      if (receipt.toolReportedStatus !== 'SUCCESS') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['receipts', index, 'toolReportedStatus'],
          message: 'SUCCEEDED bundle requires all receipts to be SUCCESS',
        });
      }
    }
  }
  // FAILED 状态时至少有一个非 SUCCESS receipt
  if (value.state === 'FAILED' && !value.receipts.some((r) => r.toolReportedStatus !== 'SUCCESS')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: 'FAILED bundle requires at least one non-SUCCESS receipt',
    });
  }
});
export type DeliveryBundle = z.infer<typeof DeliveryBundleSchema>;

export const DELIVERY_BUNDLE_SCHEMA_ID = 'awkn-delivery-bundle/v1';

// ===== Section 6: Hash Computation =====

/**
 * 深度剥离 undefined 字段（递归处理对象和数组）.
 *
 * canonical JSON 不允许 undefined 字段，而 DeliveryContract 中有 optional 字段
 * （如 target / format）。在哈希前剥离它们以保证哈希稳定且不抛错。
 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val !== undefined) {
      result[key] = stripUndefined(val);
    }
  }
  return result;
}

/**
 * 计算 DeliveryContract 的稳定哈希（跨平台一致）.
 *
 * 排除运行时字段 deliveryId / executionId —— 同一契约内容（包含 mode、target、
 * format、sideEffect、requiredArtifacts 等）应产生相同哈希。
 * deliveryId 由系统在创建时分配，不影响契约内容身份。
 */
export function computeDeliveryContractHash(
  contract: Omit<DeliveryContract, 'deliveryId' | 'executionId'>,
): string {
  const { deliveryId: _deliveryId, executionId: _executionId, ...contentFields } = contract as DeliveryContract;
  void _deliveryId;
  void _executionId;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(DELIVERY_CONTRACT_SCHEMA_ID, stripped);
}

/**
 * 计算 DeliveryBundle 的稳定哈希.
 *
 * 排除运行时字段 bundleId / executionId / createdAt / finalizedAt ——
 * 同一 Bundle 内容（包含 contracts、artifacts、receipts、primaryDeliveryId、state）
 * 应产生相同哈希。
 */
export function computeDeliveryBundleHash(
  bundle: Omit<DeliveryBundle, 'bundleId' | 'executionId' | 'createdAt' | 'finalizedAt'>,
): string {
  const {
    bundleId: _bundleId,
    executionId: _executionId,
    createdAt: _createdAt,
    finalizedAt: _finalizedAt,
    ...contentFields
  } = bundle as DeliveryBundle;
  void _bundleId;
  void _executionId;
  void _createdAt;
  void _finalizedAt;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(DELIVERY_BUNDLE_SCHEMA_ID, stripped);
}

// ===== Section 7: ID 生成辅助 =====

/** 生成 Delivery ID */
export function createDeliveryId(): string {
  return createAwknId('delivery');
}

/** 生成 Artifact ID */
export function createArtifactId(): string {
  return createAwknId('artifact');
}

/** 生成 Receipt ID */
export function createDeliveryReceiptId(): string {
  return createAwknId('receipt');
}
