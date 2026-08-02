/**
 * Local AgentLoop Provider — WorkerProviderPort 的本地桩实现
 *
 * Spiral 2: 实现 WorkerProviderPort 接口但不真正调用 AgentLoop（feature flag 为
 * 'enforce' 时才接入）。当前 spawn/heartbeat/cancel/collect 返回 mock/placeholder 结果，
 * 保持接口契约形态完整，供 assignment-service 与 provider-registry 联调。
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
} from '../contracts/workflow-v2.js';
import { createAwknId } from '../contracts/ids.js';

interface RunRecord {
  request: WorkerSpawnRequest;
  actorId: string;
  sessionId: string;
  state: string;
  spawnedAt: string;
}

// 桩实现支持的全部 specialty（17 类 WorkflowStageType）。
const ALL_SPECIALTIES = [
  'PRODUCT_AUTHOR',
  'REQUIREMENTS_REVIEW',
  'ARCHITECTURE_AUTHOR',
  'ARCHITECTURE_REVIEW',
  'PLAN_AUTHOR',
  'PLAN_REVIEW',
  'IMPLEMENT',
  'TEST',
  'CODE_REVIEW',
  'SECURITY_REVIEW',
  'GIT_INTEGRATE',
  'RELEASE_BUILD',
  'DEPLOY',
  'HEALTH_VERIFY',
  'RETROSPECTIVE',
  'EVOLUTION_VALIDATE',
  'RECOVERY',
] as const;

export class LocalAgentLoopProvider implements WorkerProviderPort {
  readonly providerId = 'local-agent-loop';
  private readonly runs = new Map<string, RunRecord>();

  async probe(): Promise<WorkerProviderCapabilityReceipt> {
    return {
      schema: 'awkn-worker-capability/v1',
      providerId: this.providerId,
      probedAt: new Date().toISOString(),
      maxConcurrentRuns: 4,
      supportedSpecialties: [...ALL_SPECIALTIES],
      heartbeatIntervalMs: 30_000,
    };
  }

  async spawn(request: WorkerSpawnRequest): Promise<WorkerSpawnReceipt> {
    const providerRunId = createAwknId('run');
    const spawnedAt = new Date().toISOString();
    this.runs.set(providerRunId, {
      request,
      actorId: createAwknId('run'),
      sessionId: createAwknId('cycle'),
      state: 'running',
      spawnedAt,
    });
    const record = this.runs.get(providerRunId)!;
    return {
      schema: 'awkn-worker-spawn-receipt/v1',
      providerRunId,
      providerId: this.providerId,
      actorId: record.actorId,
      sessionId: record.sessionId,
      spawnedAt,
    };
  }

  async inspect(providerRunId: string): Promise<{ state: string; lastHeartbeatAt: string }> {
    const record = this.runs.get(providerRunId);
    if (!record) {
      return { state: 'unknown', lastHeartbeatAt: new Date().toISOString() };
    }
    return { state: record.state, lastHeartbeatAt: record.spawnedAt };
  }

  async heartbeat(providerRunId: string): Promise<WorkerHeartbeatReceipt> {
    return {
      schema: 'awkn-worker-heartbeat/v1',
      providerRunId,
      observedAt: new Date().toISOString(),
      status: 'alive',
    };
  }

  async cancel(providerRunId: string, reason: string): Promise<WorkerCancelReceipt> {
    const record = this.runs.get(providerRunId);
    if (record) {
      record.state = 'cancelled';
    }
    return {
      schema: 'awkn-worker-cancel/v1',
      providerRunId,
      reason,
      cancelledAt: new Date().toISOString(),
    };
  }

  async collect(providerRunId: string): Promise<WorkerResultEnvelope> {
    const record = this.runs.get(providerRunId);
    if (record) {
      record.state = 'completed';
    }
    // 桩实现：返回 SUCCESS 结果与占位 receipt id。
    // enforce 模式下此处将真正运行 AgentLoop 并产出证据。
    return {
      schema: 'awkn-worker-result/v1',
      providerRunId,
      actorId: record?.actorId ?? createAwknId('run'),
      conclusion: 'SUCCESS',
      outputReceiptId: createAwknId('receipt'),
      evidenceRefs: [],
      completedAt: new Date().toISOString(),
    };
  }
}
