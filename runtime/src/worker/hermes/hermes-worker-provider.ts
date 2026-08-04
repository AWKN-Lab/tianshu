/**
 * Hermes Worker Provider — 实现 WorkerProviderPort，委托给 HermesCliPort
 *
 * Spiral 5: 吸收 Hermes 思想（独立 Profile、持久任务、heartbeat、reclaim、dead-letter）。
 *
 * Feature Flag: AWKN_HERMES_PROVIDER_V1
 * - '0'（默认）: Provider 不注册，不影响运行时
 * - 'shadow': Provider 注册但返回 SHADOW 模式占位结果
 * - 'enforce': Provider 真正调用 Hermes CLI（需 Hermes 已安装且支持机器可读输出）
 *
 * 工程文档约束：缺少机器可读输出时保持 SHADOW/QUARANTINED。
 *
 * 对应契约: contracts/workflow-v2.ts — WorkerProviderPort
 */
import type {
  WorkerCancelReceipt,
  WorkerHeartbeatReceipt,
  WorkerProviderCapabilityReceipt,
  WorkerProviderPort,
  WorkerResultEnvelope,
  WorkerSpawnReceipt,
  WorkerSpawnRequest,
} from '../../contracts/workflow-v2.js';
import { createAwknId } from '../../contracts/ids.js';
import type { HermesCliPort, HermesTaskSpec } from './hermes-cli-port.js';
import { StubHermesCliPort } from './hermes-cli-port.js';
import { HermesEventAdapter, type HermesEventMapping } from './hermes-event-adapter.js';
import { registerProvider, unregisterProvider } from '../provider-registry.js';

const HERMES_SPECIALTIES = [
  'IMPLEMENT',
  'TEST',
  'CODE_REVIEW',
  'SECURITY_REVIEW',
  'GIT_INTEGRATE',
  'RELEASE_BUILD',
  'DEPLOY',
  'HEALTH_VERIFY',
  'RECOVERY',
  'RETROSPECTIVE',
] as const;

export class HermesWorkerProvider implements WorkerProviderPort {
  readonly providerId = 'hermes';
  private readonly cli: HermesCliPort;
  private readonly adapter: HermesEventAdapter;
  private readonly mappings = new Map<string, HermesEventMapping>();

  constructor(cli: HermesCliPort) {
    this.cli = cli;
    this.adapter = new HermesEventAdapter();
  }

  async probe(): Promise<WorkerProviderCapabilityReceipt> {
    await this.cli.probe();
    return {
      schema: 'awkn-worker-capability/v1',
      providerId: this.providerId,
      probedAt: new Date().toISOString(),
      maxConcurrentRuns: 2,
      supportedSpecialties: [...HERMES_SPECIALTIES],
      heartbeatIntervalMs: 60_000,
    };
  }

  async spawn(request: WorkerSpawnRequest): Promise<WorkerSpawnReceipt> {
    const spec: HermesTaskSpec = {
      profileName: `hermes-profile-${request.profileId}`,
      prompt: `[frozen-input:${request.frozenInputHash}]`,
      workspacePath: request.workspaceId,
      maxAttempts: 3,
      timeoutMs: 300_000,
      idempotencyKey: request.idempotencyKey,
    };

    const spawnResult = await this.cli.spawn(spec);
    const actorId = createAwknId('run');
    const sessionId = createAwknId('cycle');

    const mapping: HermesEventMapping = {
      providerRunId: spawnResult.hermesRunId,
      actorId,
      sessionId,
      spawnedAt: spawnResult.spawnedAt,
      request,
    };
    this.mappings.set(spawnResult.hermesRunId, mapping);

    return {
      schema: 'awkn-worker-spawn-receipt/v1',
      providerRunId: spawnResult.hermesRunId,
      providerId: this.providerId,
      actorId,
      sessionId,
      spawnedAt: spawnResult.spawnedAt,
    };
  }

  async inspect(providerRunId: string): Promise<{ state: string; lastHeartbeatAt: string }> {
    const record = await this.cli.inspect(providerRunId);
    return {
      state: this.adapter.mapHermesStateToAwknState(record.state),
      lastHeartbeatAt: record.lastHeartbeatAt,
    };
  }

  async heartbeat(providerRunId: string): Promise<WorkerHeartbeatReceipt> {
    const hbResult = await this.cli.heartbeat(providerRunId);
    const status = hbResult.alive ? 'alive' : 'stale';
    return {
      schema: 'awkn-worker-heartbeat/v1',
      providerRunId,
      observedAt: hbResult.observedAt,
      status: status as 'alive' | 'busy' | 'stale',
    };
  }

  async cancel(providerRunId: string, reason: string): Promise<WorkerCancelReceipt> {
    await this.cli.reclaim(providerRunId, reason);
    return {
      schema: 'awkn-worker-cancel/v1',
      providerRunId,
      reason,
      cancelledAt: new Date().toISOString(),
    };
  }

  async collect(providerRunId: string): Promise<WorkerResultEnvelope> {
    const mapping = this.mappings.get(providerRunId);
    const collectResult = await this.cli.collect(providerRunId);
    const deadLetters = await this.cli.listDeadLetters();
    const deadLetterForRun = deadLetters.find((d) => d.hermesRunId === providerRunId);

    let conclusion: 'SUCCESS' | 'FAILURE' | 'PARTIAL' = collectResult.conclusion;
    if (deadLetterForRun) {
      conclusion = 'FAILURE';
    }

    return {
      schema: 'awkn-worker-result/v1',
      providerRunId,
      actorId: mapping?.actorId ?? createAwknId('run'),
      conclusion,
      outputReceiptId: createAwknId('receipt'),
      evidenceRefs: collectResult.evidence,
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * 注册 Hermes Worker Provider（受 Feature Flag 控制）。
 *
 * AWKN_HERMES_PROVIDER_V1:
 * - '0'（默认）: 不注册，无副作用
 * - 'shadow': 注册并使用 StubHermesCliPort（SHADOW 模式占位结果）
 * - 'enforce': 注册并需提供真实 HermesCliPort（调用方注入）
 *
 * @returns 注销函数，调用后从注册表移除
 */
export function registerHermesProvider(cli?: HermesCliPort): () => void {
  const flag = process.env.AWKN_HERMES_PROVIDER_V1 ?? '0';
  if (flag === '0') return () => {};
  const port = cli ?? new StubHermesCliPort();
  const provider = new HermesWorkerProvider(port);
  registerProvider(provider);
  return () => unregisterProvider(provider.providerId);
}
