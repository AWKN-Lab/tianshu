import { createAwknId } from '../contracts/ids.js';
import { stableHash } from '../contracts/canonical-json.js';
import {
  AGENT_OS_FLAGS,
  FLAG_VALUE_RANK,
  FEATURE_FLAG_DEPENDENCIES,
  FEATURE_FLAG_SNAPSHOT_SCHEMA,
  FeatureFlagError,
  type AgentOsFlag,
  type FeatureFlagSnapshot,
  type FeatureFlagValue,
} from '../contracts/feature-flag.js';

/**
 * Configuration source ranking determines precedence.
 *
 * 优先级（从低到高）：
 * 0. code-default   — 代码默认值
 * 1. env            — 环境变量
 * 2. deploy-config  — 部署配置文件
 * 3. execution-override — Execution 受控 Override
 *
 * 低 rank 的来源不能覆盖高 rank 的已设置值。
 */
type ConfigSourceRank = 0 | 1 | 2 | 3;

interface FlagEntry {
  value: FeatureFlagValue;
  source: string;
  rank: ConfigSourceRank;
}

const SOURCE_RANKS: Record<string, ConfigSourceRank> = {
  'code-default': 0,
  'env': 1,
  'deploy-config': 2,
  'execution-override': 3,
};

const VALID_VALUES: ReadonlySet<string> = new Set(['0', 'shadow', 'enforce']);

/**
 * FeatureFlagRegistry 管理 Agent OS Feature Flag 的配置、优先级和依赖校验。
 *
 * 使用方式：
 * 1. 构造 Registry（所有 flag 默认 '0'）
 * 2. applyEnv(process.env) — 从环境变量加载
 * 3. applyConfig(config) — 从部署配置加载
 * 4. applyOverride(flag, value) — Execution 受控 Override
 * 5. freeze() — 冻结 snapshot，验证依赖，返回不可变 FeatureFlagSnapshot
 *
 * 已冻结的 Registry 不接受进一步修改（AOS_FLAG_SNAPSHOT_FROZEN）。
 */
export class FeatureFlagRegistry {
  private readonly entries: Map<AgentOsFlag, FlagEntry> = new Map();
  private frozen = false;

  constructor(defaults?: Partial<Record<AgentOsFlag, FeatureFlagValue>>) {
    for (const flag of AGENT_OS_FLAGS) {
      const value = defaults?.[flag] ?? '0';
      this.validateValue(value, flag);
      this.entries.set(flag, { value, source: 'code-default', rank: 0 });
    }
  }

  /**
   * 从环境变量加载 flag 配置。
   * 只覆盖 code-default 的 flag；已由 deploy-config 或 execution-override 设置的 flag 不受影响。
   */
  applyEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): this {
    this.assertNotFrozen();
    for (const flag of AGENT_OS_FLAGS) {
      const envValue = env[flag];
      if (envValue === undefined) continue;
      this.validateValue(envValue, flag);
      this.trySet(flag, envValue as FeatureFlagValue, 'env');
    }
    return this;
  }

  /**
   * 从部署配置加载 flag 配置。
   * 覆盖 code-default 和 env；不覆盖 execution-override。
   */
  applyConfig(config: Partial<Record<AgentOsFlag, FeatureFlagValue>>): this {
    this.assertNotFrozen();
    for (const flag of AGENT_OS_FLAGS) {
      const configValue = config[flag];
      if (configValue === undefined) continue;
      this.validateValue(configValue, flag);
      this.trySet(flag, configValue, 'deploy-config');
    }
    return this;
  }

  /**
   * 应用 Execution 受控 Override（最高优先级）。
   * 覆盖所有其他来源。
   */
  applyOverride(flag: AgentOsFlag, value: FeatureFlagValue): this {
    this.assertNotFrozen();
    this.validateFlag(flag);
    this.validateValue(value, flag);
    this.entries.set(flag, { value, source: 'execution-override', rank: 3 });
    return this;
  }

  /**
   * 冻结当前配置为不可变 FeatureFlagSnapshot。
   *
   * 步骤：
   * 1. 验证所有依赖关系（AOS_FLAG_DEPENDENCY_INVALID）
   * 2. 生成 snapshotId
   * 3. 计算 sourceHash（flags + sourceVersions 的 SHA256）
   * 4. 标记 Registry 为 frozen（后续修改抛出 AOS_FLAG_SNAPSHOT_FROZEN）
   */
  freeze(): FeatureFlagSnapshot {
    this.assertNotFrozen();
    this.validateDependencies();

    const flags = {} as Record<AgentOsFlag, FeatureFlagValue>;
    const sourceVersions: Record<string, string> = {};
    for (const flag of AGENT_OS_FLAGS) {
      const entry = this.entries.get(flag)!;
      flags[flag] = entry.value;
      sourceVersions[flag] = entry.source;
    }

    const snapshotId = createAwknId('flagSnapshot');
    const sourceHash = stableHash(FEATURE_FLAG_SNAPSHOT_SCHEMA, {
      flags,
      sourceVersions,
    });
    const frozenAt = new Date().toISOString();

    this.frozen = true;

    return {
      schema: FEATURE_FLAG_SNAPSHOT_SCHEMA,
      snapshotId,
      flags: Object.freeze({ ...flags }),
      sourceVersions: Object.freeze({ ...sourceVersions }),
      sourceHash,
      frozenAt,
    };
  }

  /** 获取 flag 当前值（未冻结时也可查询）。 */
  getValue(flag: AgentOsFlag): FeatureFlagValue {
    this.validateFlag(flag);
    return this.entries.get(flag)!.value;
  }

  /** 获取 flag 当前配置来源。 */
  getSource(flag: AgentOsFlag): string {
    this.validateFlag(flag);
    return this.entries.get(flag)!.source;
  }

  /** 是否已冻结。 */
  isFrozen(): boolean {
    return this.frozen;
  }

  private trySet(flag: AgentOsFlag, value: FeatureFlagValue, source: string): void {
    const newRank = SOURCE_RANKS[source];
    const current = this.entries.get(flag)!;
    if (newRank >= current.rank) {
      this.entries.set(flag, { value, source, rank: newRank });
    }
  }

  private validateValue(value: string, flag: AgentOsFlag): void {
    if (!VALID_VALUES.has(value)) {
      throw new FeatureFlagError(
        'AOS_FLAG_INVALID_VALUE',
        `flag ${flag} has unknown value "${value}" — must be '0', 'shadow', or 'enforce'`,
      );
    }
  }

  private validateFlag(flag: string): asserts flag is AgentOsFlag {
    if (!AGENT_OS_FLAGS.includes(flag as AgentOsFlag)) {
      throw new FeatureFlagError(
        'AOS_FLAG_UNKNOWN',
        `unknown flag "${flag}" — must be one of ${AGENT_OS_FLAGS.join(', ')}`,
      );
    }
  }

  private validateDependencies(): void {
    for (const dep of FEATURE_FLAG_DEPENDENCIES) {
      const flagValue = this.entries.get(dep.flag)!.value;
      if (flagValue === '0') continue; // '0' 不触发依赖检查

      for (const req of dep.requires) {
        const reqValue = this.entries.get(req.flag)!.value;
        const reqActualRank = FLAG_VALUE_RANK[reqValue];
        const reqRequiredRank = FLAG_VALUE_RANK[req.minimumValue];
        if (reqActualRank < reqRequiredRank) {
          throw new FeatureFlagError(
            'AOS_FLAG_DEPENDENCY_INVALID',
            `${dep.flag}=${flagValue} requires ${req.flag}>=${req.minimumValue}, but got ${reqValue}`,
          );
        }
      }
    }
  }

  private assertNotFrozen(): void {
    if (this.frozen) {
      throw new FeatureFlagError(
        'AOS_FLAG_SNAPSHOT_FROZEN',
        'registry is frozen — cannot modify flags after freeze()',
      );
    }
  }
}
