import { z } from 'zod';
import { awknIdSchema } from './ids.js';

/**
 * Feature Flag Snapshot Contract (R2 Shadow Integration)
 *
 * 文档 16 (Adapter-Shadow-FeatureFlag 迁移手册) 的合约层实现。
 *
 * Flag 值语义：
 * - '0'       仅 Engine v2 权威路径运行
 * - 'shadow'  Engine v2 权威；新路径计算并比较，不提交外部副作用
 * - 'enforce'  Agent OS 3.0 权威；Engine v2 作为只读对照或回退入口
 *
 * 未知值启动失败 (AOS_FLAG_INVALID_VALUE)。
 * 配置优先级：Execution Override > 部署配置 > 环境变量 > 代码默认。
 * 已启动 Execution 不接受热更新；L3/L4 恢复使用原 Snapshot。
 */

export const FEATURE_FLAG_SNAPSHOT_SCHEMA = 'awkn-feature-flag-snapshot/v1';

export type FeatureFlagValue = '0' | 'shadow' | 'enforce';

/**
 * R2 范围的 Agent OS Feature Flag 清单。
 *
 * 后续 WP 会扩展（Policy/Skill/Model/Tool Broker 等）。
 * Claim Ledger 不设独立 flag，归属 Context Planner。
 */
export const AGENT_OS_FLAGS = [
  'AWKN_INPUT_GATEWAY_V1',
  'AWKN_INTENT_ROUTER_V1',
  'AWKN_CONTEXT_PLANNER_V1',
] as const;

export type AgentOsFlag = (typeof AGENT_OS_FLAGS)[number];

/**
 * Flag 值的排序权重，用于依赖校验。
 * '0' < 'shadow' < 'enforce'
 */
export const FLAG_VALUE_RANK: Readonly<Record<FeatureFlagValue, number>> = {
  '0': 0,
  shadow: 1,
  enforce: 2,
};

/**
 * Feature Flag 依赖声明。
 *
 * enforce/shadow 前置条件：如果 flag 值 >= shadow，
 * 则其依赖的 flag 必须满足 minimumValue。
 *
 * 根据文档 16 第三节 Flag 清单与依赖：
 * - Intent: Input >= shadow
 * - Context: Intent >= shadow（Claim v3 可用性由调用方检查，不在 flag 依赖里）
 */
export interface FeatureFlagDependency {
  readonly flag: AgentOsFlag;
  readonly requires: ReadonlyArray<{
    readonly flag: AgentOsFlag;
    readonly minimumValue: FeatureFlagValue;
  }>;
}

export const FEATURE_FLAG_DEPENDENCIES: ReadonlyArray<FeatureFlagDependency> = [
  {
    flag: 'AWKN_INTENT_ROUTER_V1',
    requires: [{ flag: 'AWKN_INPUT_GATEWAY_V1', minimumValue: 'shadow' }],
  },
  {
    flag: 'AWKN_CONTEXT_PLANNER_V1',
    requires: [{ flag: 'AWKN_INTENT_ROUTER_V1', minimumValue: 'shadow' }],
  },
];

/**
 * Feature Flag Snapshot：Execution 创建时冻结的不可变配置。
 *
 * schema: 'awkn-feature-flag-snapshot/v1'
 * snapshotId: 'fsnap_<32hex>'
 * flags: 每个 flag 的冻结值
 * sourceVersions: 每个 flag 的配置来源（code-default/env/deploy-config/execution-override）
 * sourceHash: 冻结内容的 SHA256 hash（用于 Replay 一致性）
 * frozenAt: 冻结时间（ISO 8601 UTC）
 */
export interface FeatureFlagSnapshot {
  readonly schema: typeof FEATURE_FLAG_SNAPSHOT_SCHEMA;
  readonly snapshotId: string;
  readonly flags: Readonly<Record<AgentOsFlag, FeatureFlagValue>>;
  readonly sourceVersions: Readonly<Record<string, string>>;
  readonly sourceHash: string;
  readonly frozenAt: string;
}

export const FeatureFlagValueSchema = z.enum(['0', 'shadow', 'enforce']);

export const FeatureFlagSnapshotSchema = z.object({
  schema: z.literal(FEATURE_FLAG_SNAPSHOT_SCHEMA),
  snapshotId: awknIdSchema('fsnap'),
  flags: z.object({
    AWKN_INPUT_GATEWAY_V1: FeatureFlagValueSchema,
    AWKN_INTENT_ROUTER_V1: FeatureFlagValueSchema,
    AWKN_CONTEXT_PLANNER_V1: FeatureFlagValueSchema,
  }),
  sourceVersions: z.record(z.string(), z.string()),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/, 'invalid sha256 hash'),
  frozenAt: z.string().datetime(),
});

/**
 * Feature Flag 错误类型。
 *
 * AOS_FLAG_INVALID_VALUE: 未知 flag 值（非 '0'/'shadow'/'enforce'）
 * AOS_FLAG_UNKNOWN: 未知 flag 名（不在 AGENT_OS_FLAGS 清单里）
 * AOS_FLAG_DEPENDENCY_INVALID: 依赖不满足（如 Intent=shadow 但 Input='0'）
 * AOS_FLAG_SNAPSHOT_FROZEN: 尝试修改已冻结的 snapshot
 */
export class FeatureFlagError extends Error {
  constructor(
    readonly code:
      | 'AOS_FLAG_INVALID_VALUE'
      | 'AOS_FLAG_UNKNOWN'
      | 'AOS_FLAG_DEPENDENCY_INVALID'
      | 'AOS_FLAG_SNAPSHOT_FROZEN',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'FeatureFlagError';
  }
}
