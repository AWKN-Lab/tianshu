/**
 * WorkerProviderPort 注册与查询（内存态）
 *
 * Spiral 2: Provider 注册表为进程内 Map，不持久化。
 * findProvidersForSpecialty 通过 probe() 获取能力清单后再按 specialty 过滤。
 *
 * 对应契约: contracts/workflow-v2.ts — WorkerProviderPort
 */
import type {
  WorkerProviderCapabilityReceipt,
  WorkerProviderPort,
  WorkflowStageType,
} from '../contracts/workflow-v2.js';

const providers = new Map<string, WorkerProviderPort>();

export function registerProvider(provider: WorkerProviderPort): void {
  providers.set(provider.providerId, provider);
}

export function unregisterProvider(providerId: string): void {
  providers.delete(providerId);
}

export function getProvider(providerId: string): WorkerProviderPort | undefined {
  return providers.get(providerId);
}

export function getRegisteredProviders(): WorkerProviderPort[] {
  return [...providers.values()];
}

/**
 * 探测所有已注册 Provider 的能力。单个 Provider 探测失败时静默跳过，
 * 不影响其它 Provider 的探测结果。
 */
export async function probeAll(): Promise<WorkerProviderCapabilityReceipt[]> {
  const receipts: WorkerProviderCapabilityReceipt[] = [];
  for (const provider of providers.values()) {
    try {
      const receipt = await provider.probe();
      receipts.push(receipt);
    } catch {
      // 探测失败的 Provider 跳过：不纳入可用 Provider 列表。
    }
  }
  return receipts;
}

/**
 * 查询支持指定 specialty 的 Provider。先调用 probeAll() 获取能力清单，
 * 再按 supportedSpecialties 过滤出匹配的 Provider。
 */
export async function findProvidersForSpecialty(
  specialty: WorkflowStageType,
): Promise<WorkerProviderPort[]> {
  const receipts = await probeAll();
  const supportingIds = new Set(
    receipts
      .filter((receipt) => receipt.supportedSpecialties.includes(specialty))
      .map((receipt) => receipt.providerId),
  );
  return [...providers.values()].filter((provider) => supportingIds.has(provider.providerId));
}
