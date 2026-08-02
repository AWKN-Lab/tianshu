/**
 * Local Canary Provider — 本地灰度部署提供方（测试用）
 *
 * Spiral 3: 实现 DeployProviderPort，模拟灰度部署流程。
 * 默认返回 HEALTHY；可通过 faultConfig 注入故障以测试自动回滚（AC-08）。
 *
 * 这是 LOCAL 提供方，仅用于测试，不执行真实外部部署。
 *
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 3 — AC-08 自动回滚测试
 */
import type {
  DeployInput,
  DeployProviderPort,
  DeployResult,
  HealthCheckInput,
  HealthCheckResult,
  RollbackInput,
  RollbackResult,
} from './deploy-provider-port.js';
import type { HealthStatus } from './contracts.js';

export interface LocalCanaryFaultConfig {
  /** 健康检查返回的状态；默认 'HEALTHY'。设为 'UNHEALTHY' 触发自动回滚。 */
  readonly healthStatus?: HealthStatus;
  /** deploy() 是否失败；默认 false。 */
  readonly deployFails?: boolean;
  /** healthCheck() 详情文本。 */
  readonly healthDetail?: string;
}

export class LocalCanaryProvider implements DeployProviderPort {
  readonly providerId = 'local-canary';
  private readonly fault: LocalCanaryFaultConfig;
  private deployCount = 0;
  private rollbackCount = 0;

  constructor(fault: LocalCanaryFaultConfig = {}) {
    this.fault = fault;
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    this.deployCount += 1;
    if (this.fault.deployFails) {
      throw new Error(`local-canary deploy failed for bundle ${input.releaseBundleId}`);
    }
    return {
      canaryEndpoint: `http://canary-${input.releaseBundleId.slice(0, 8)}.local:8080`,
      deployed: true,
    };
  }

  async healthCheck(_input: HealthCheckInput): Promise<HealthCheckResult> {
    const status: HealthStatus = this.fault.healthStatus ?? 'HEALTHY';
    return {
      status,
      detail: this.fault.healthDetail ?? `local-canary health check: ${status}`,
    };
  }

  async rollback(input: RollbackInput): Promise<RollbackResult> {
    this.rollbackCount += 1;
    return {
      rolledBack: true,
      reason: `rolled back bundle ${input.releaseBundleId} in ${input.targetEnvironment}`,
    };
  }

  /** 测试辅助：返回 deploy() 调用次数。 */
  getDeployCount(): number {
    return this.deployCount;
  }

  /** 测试辅助：返回 rollback() 调用次数。 */
  getRollbackCount(): number {
    return this.rollbackCount;
  }
}
