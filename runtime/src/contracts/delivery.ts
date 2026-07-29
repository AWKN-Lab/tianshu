/**
 * Delivery Router Contracts (Phase 6 / C07 / WP-AOS-13)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第二节
 *
 * 本文件冻结 Delivery Router 的所有公开 Contract：
 * - DeliveryModeSchema: 6 种交付模式（CHAT/FILE/VISUAL/ARTIFACT_APP/CONNECTED_SYSTEM/SCHEDULED_TASK）
 * - DeliverySideEffectSchema: 副作用类型
 * - ArtifactRequirementSchema: 产物要求
 * - DeliveryStateSchema: 交付状态
 * - DeliveryFailurePolicySchema: 失败策略
 * - DeliveryContractSchema (awkn-delivery-contract/v1): 交付契约
 * - DeliveryReceiptSchema (awkn-delivery-receipt/v1): 交付回执
 * - DeliveryBundleSchema (awkn-delivery-bundle/v1): 交付捆绑包
 *
 * 不变量：
 * - 所有 schema 使用 zod strict + superRefine
 * - 所有 hash 使用 stableHash（canonical-json.ts）
 * - 所有 ID 使用 createAwknId / awknIdSchema
 * - 所有时间戳使用 UtcTimestampSchema
 * - canonical JSON 不允许 undefined 字段，哈希前需 stripUndefined
 * - 同一 Execution 可以产生多个 Delivery，但必须指定 Primary Delivery
 * - 交付状态独立于执行状态（设计文档 3.1）
 * - 失败策略 ROLLBACK 必须有 compensationRef
 * - 成功交付必须携带产物 Hash
 */

import { z } from 'zod';
import { ObjectRefSchema } from './actors.js';
import { stableHash } from './canonical-json.js';
import { DeliveryModeSchema } from './goal.js';
import { awknIdSchema, createAwknId } from './ids.js';
import type { JsonValue } from './json-value.js';
import { JsonValueSchema } from './json-value.js';
import { SafeNonNegativeIntegerSchema } from './numbers.js';
import { UtcTimestampSchema } from './time.js';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ===== Section 1: Enums =====

// DeliveryModeSchema 复用自 goal.ts（已定义 DeliveryExpectation）

export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

export const DeliverySideEffectSchema = z.enum([
  'none',
  'local_write',
  'external_write',
  'scheduled',
]);
export type DeliverySideEffect = z.infer<typeof DeliverySideEffectSchema>;

export const DeliveryStateSchema = z.enum([
  'PENDING',
  'RUNNING',
  'PARTIAL',
  'SUCCEEDED',
  'FAILED',
]);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

export const DeliveryFailurePolicySchema = z.enum([
  'RETRY',
  'PARTIAL',
  'ROLLBACK',
  'WAIT_USER',
  'FAIL',
]);
export type DeliveryFailurePolicy = z.infer<typeof DeliveryFailurePolicySchema>;

// ===== Section 2: Artifact Requirement =====

export const ArtifactRequirementSchema = z.object({
  artifactType: z.string().min(1),
  format: z.string().min(1),
  contentHashRequired: z.boolean(),
  sizeBytes: SafeNonNegativeIntegerSchema.optional(),
  schemaRef: z.string().min(1).optional(),
}).strict();
export type ArtifactRequirement = z.infer<typeof ArtifactRequirementSchema>;

// ===== Section 3: Resource Reference =====

export const ResourceRefSchema = z.object({
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
  externalSystem: z.string().min(1).optional(),
  accessUri: z.string().min(1).optional(),
}).strict();
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

// ===== Section 4: Delivery Contract (awkn-delivery-contract/v1) =====

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
  successPredicate: z.record(JsonValueSchema),
  failurePolicy: DeliveryFailurePolicySchema,
}).strict().superRefine((value, context) => {
  // CONNECTED_SYSTEM 必须有 target
  if (value.mode === 'CONNECTED_SYSTEM' && value.target === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'CONNECTED_SYSTEM delivery requires target resource ref',
    });
  }
  // SCHEDULED_TASK 必须有 target
  if (value.mode === 'SCHEDULED_TASK' && value.target === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'SCHEDULED_TASK delivery requires target resource ref',
    });
  }
  // 副作用 external_write/scheduled 必须需要授权
  if ((value.sideEffect === 'external_write' || value.sideEffect === 'scheduled')
    && !value.requiresAuthorization) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requiresAuthorization'],
      message: `${value.sideEffect} side effect requires authorization`,
    });
  }
});
export type DeliveryContract = z.infer<typeof DeliveryContractSchema>;

export const DELIVERY_CONTRACT_SCHEMA_ID = 'awkn-delivery-contract/v1';

// ===== Section 5: Delivery Receipt (awkn-delivery-receipt/v1) =====

export const DeliveryReceiptSchema = z.object({
  schema: z.literal('awkn-delivery-receipt/v1'),
  receiptId: awknIdSchema('rcpt'),
  deliveryId: awknIdSchema('dlv'),
  executionId: awknIdSchema('exec'),
  mode: DeliveryModeSchema,
  state: DeliveryStateSchema,
  actualTarget: ResourceRefSchema.optional(),
  artifactRefs: z.array(ObjectRefSchema),
  artifactHashes: z.array(z.string().regex(SHA256_HEX_PATTERN)),
  externalResourceId: z.string().min(1).optional(),
  toolReportedSuccess: z.boolean(),
  verifiedSuccess: z.boolean(),
  reversible: z.boolean(),
  failureReason: z.string().min(1).optional(),
  retryCount: SafeNonNegativeIntegerSchema,
  compensationRef: z.string().min(1).optional(),
  deliveredAt: UtcTimestampSchema.optional(),
  createdAt: UtcTimestampSchema,
}).strict().superRefine((value, context) => {
  // SUCCEEDED 必须有 deliveredAt 和至少一个 artifactHash
  if (value.state === 'SUCCEEDED') {
    if (value.deliveredAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deliveredAt'],
        message: 'SUCCEEDED delivery requires deliveredAt',
      });
    }
    if (value.artifactHashes.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactHashes'],
        message: 'SUCCEEDED delivery requires at least one artifact hash',
      });
    }
  }
  // FAILED 必须有 failureReason
  if (value.state === 'FAILED' && value.failureReason === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['failureReason'],
      message: 'FAILED delivery requires failureReason',
    });
  }
  // FAILED 不能有 deliveredAt
  if (value.state === 'FAILED' && value.deliveredAt !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveredAt'],
      message: 'FAILED delivery must not have deliveredAt',
    });
  }
  // reversible=false 且 state=FAILED/SUCCEEDED 时 compensationRef 可选
  // reversible=true 且失败时可考虑 compensationRef
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

export const DELIVERY_RECEIPT_SCHEMA_ID = 'awkn-delivery-receipt/v1';

// ===== Section 6: Delivery Bundle (awkn-delivery-bundle/v1) =====

export const DeliveryBundleSchema = z.object({
  schema: z.literal('awkn-delivery-bundle/v1'),
  bundleId: awknIdSchema('dlv'),
  executionId: awknIdSchema('exec'),
  contracts: z.array(DeliveryContractSchema).min(1),
  artifactRefs: z.array(ObjectRefSchema),
  receipts: z.array(DeliveryReceiptSchema),
  primaryDeliveryId: awknIdSchema('dlv'),
  state: DeliveryStateSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  closedAt: UtcTimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  // 必须有且仅有一个 Primary Delivery
  const primaryContracts = value.contracts.filter((c) => c.primary);
  if (primaryContracts.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contracts'],
      message: 'bundle must contain exactly one primary delivery contract',
    });
  } else if (primaryContracts.length > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contracts'],
      message: 'bundle must contain at most one primary delivery contract',
    });
  }
  // primaryDeliveryId 必须对应一个 primary contract
  const primaryMatch = value.contracts.find(
    (c) => c.deliveryId === value.primaryDeliveryId && c.primary,
  );
  if (primaryMatch === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['primaryDeliveryId'],
      message: 'primaryDeliveryId must match a primary contract deliveryId',
    });
  }
  // CLOSED 状态需要 closedAt
  if (value.state === 'SUCCEEDED' || value.state === 'FAILED') {
    if (value.closedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['closedAt'],
        message: `${value.state} bundle requires closedAt`,
      });
    }
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt cannot precede createdAt',
    });
  }
});
export type DeliveryBundle = z.infer<typeof DeliveryBundleSchema>;

export const DELIVERY_BUNDLE_SCHEMA_ID = 'awkn-delivery-bundle/v1';

// ===== Section 7: Hash Computation =====

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

export function computeDeliveryContractHash(
  contract: Omit<DeliveryContract, 'deliveryId'>,
): string {
  const stripped = stripUndefined(contract as unknown as JsonValue);
  return stableHash(DELIVERY_CONTRACT_SCHEMA_ID, stripped);
}

export function computeDeliveryBundleHash(
  bundle: Omit<DeliveryBundle, 'bundleId' | 'updatedAt' | 'closedAt'>,
): string {
  const { bundleId: _bundleId, updatedAt: _updatedAt, closedAt: _closedAt, ...contentFields } =
    bundle as DeliveryBundle;
  void _bundleId;
  void _updatedAt;
  void _closedAt;
  const stripped = stripUndefined(contentFields as unknown as JsonValue);
  return stableHash(DELIVERY_BUNDLE_SCHEMA_ID, stripped);
}

// ===== Section 8: ID 生成辅助 =====

export function createDeliveryId(): string {
  return createAwknId('delivery');
}

// ===== Section 9: 路由规则辅助 =====

/**
 * 根据用户目标推断 Delivery Mode（设计文档 2.1）
 */
export function inferDeliveryModeFromGoal(
  goalKeywords: ReadonlyArray<string>,
): DeliveryMode {
  const text = goalKeywords.join(' ').toLowerCase();
  if (/(理解|解释|判断|分析|understand|explain|analyze)/.test(text)) {
    return 'CHAT';
  }
  if (/(保存|下载|提交|分享|save|download|commit|share)/.test(text)) {
    return 'FILE';
  }
  if (/(查看|结构|关系|流程|view|structure|relation|flow)/.test(text)) {
    return 'VISUAL';
  }
  if (/(持续交互|应用状态|interactive|stateful app)/.test(text)) {
    return 'ARTIFACT_APP';
  }
  if (/(邮件|日历|github|calendar|email|external system)/.test(text)) {
    return 'CONNECTED_SYSTEM';
  }
  if (/(未来|周期|定时|schedule|cron|recurring)/.test(text)) {
    return 'SCHEDULED_TASK';
  }
  return 'CHAT';
}
