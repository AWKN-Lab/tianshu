/**
 * Worker 模块公共 API
 *
 * Spiral 2: Profile 注册表、Provider 注册表、分配服务、租约管理、
 * Receipt 规范化、本地 AgentLoop Provider。
 */
export * from './profile-registry.js';
export * from './provider-registry.js';
export * from './assignment-service.js';
export * from './lease-manager.js';
export * from './receipt-normalizer.js';
export { LocalAgentLoopProvider } from './local-agent-loop-provider.js';
export { HermesWorkerProvider, registerHermesProvider } from './hermes/hermes-worker-provider.js';
export { StubHermesCliPort } from './hermes/hermes-cli-port.js';
export type { HermesCliPort, HermesTaskSpec, HermesTaskState, HermesRunRecord, HermesDeadLetterEntry } from './hermes/hermes-cli-port.js';
export { HermesEventAdapter } from './hermes/hermes-event-adapter.js';
