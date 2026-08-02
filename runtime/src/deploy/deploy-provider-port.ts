/**
 * Deploy Provider Port — 部署提供方端口
 *
 * Spiral 3: Deploy Agent 通过此端口执行实际部署、健康检查与回滚。
 * 端口实现可以是本地 canary 提供方（测试用）、K8s 提供方、云平台提供方等。
 * Deploy Agent 不直接执行部署，仅通过端口调用。
 *
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 3
 */
import type { HealthStatus } from './contracts.js';

export interface DeployInput {
  readonly releaseBundleId: string;
  readonly targetEnvironment: string;
  readonly artifactDigest: string;
}

export interface DeployResult {
  readonly canaryEndpoint: string;
  readonly deployed: boolean;
}

export interface HealthCheckInput {
  readonly releaseBundleId: string;
  readonly canaryEndpoint: string;
  readonly targetEnvironment: string;
}

export interface HealthCheckResult {
  readonly status: HealthStatus;
  readonly detail: string;
}

export interface RollbackInput {
  readonly releaseBundleId: string;
  readonly targetEnvironment: string;
  readonly previousSourceSha?: string;
}

export interface RollbackResult {
  readonly rolledBack: boolean;
  readonly reason: string;
}

/**
 * Deploy Provider Port — 执行部署、健康检查与回滚。
 *
 * 实现方负责实际的基础设施操作。Deploy Agent 仅消费结果并协调灰度流程。
 */
export interface DeployProviderPort {
  readonly providerId: string;
  deploy(input: DeployInput): Promise<DeployResult>;
  healthCheck(input: HealthCheckInput): Promise<HealthCheckResult>;
  rollback(input: RollbackInput): Promise<RollbackResult>;
}
