/**
 * AgentTeams — 公共出口（C1/C2/C3/C4/C5 接口契约门面）
 *
 * 影响层级 [S]：AgentTeams 模块对外唯一入口。
 * 接口契约：persona.list/get/pick + team.start/status/intervene
 */

// C1 人格库
export { persona, PersonaRegistry, getPersonaRegistry, STAGE_PRIMARY_PERSONA, STAGE_COUNCIL_PERSONAS } from './persona/registry.js';
export { personaSchema, validatePersona, checkPersona } from './persona/schema.js';
export { importPersonas, renderPersonaPrompt, type ImportResult } from './persona/importer.js';
export { PERSONA_CATALOG, getCatalogPersona } from './persona/catalog.js';
export type { PersonaRole, PersonaTraits, ThinkingModel, CollaborationMap, AgentCategory, PersonaTier, PersonaIndex } from './persona/types.js';

// C2 团队编排
export { team, TeamLoop, getTeamLoop, type TeamLoopOptions } from './team/team-loop.js';
export { teamSchema, validateTeam } from './team/team-schema.js';
export { buildTeamDag, topoWaves, type TeamDag } from './team/dag-builder.js';
export { runBrainstorm, extractJson, type BrainstormCard, type BrainstormResult } from './team/brainstorm.js';
export type {
  TeamDef,
  TeamWorkerDef,
  TeamEdge,
  TeamGateDef,
  TeamRunState,
  WorkerNodeResult,
  CollaborationMode,
  TeamRunStatus,
  WorkerExecutor,
  WorkerTaskInput,
  WorkerTaskOutput,
} from './team/types.js';

// C3 Worker 执行
export { WORKER_MANIFEST, getSkeleton, loadSkeletonCard, type WorkerSkeleton } from './worker/manifest.js';
export { buildWorkerSystemPrompt, renderPersonaSection, type InjectOptions } from './worker/persona-injector.js';
export { extractVerdict, writeVerdict, type VerdictRecord } from './worker/verdict-writer.js';
export { createDefaultExecutor, buildWorkerUserPrompt, type DefaultExecutorOptions } from './worker/executor.js';

// C4 协作通信
export { ArtifactStore, getArtifactStore, sanitizeMissionName } from './artifacts/artifact-store.js';
export { CollabEventLog, type CollabEvent, type CollabEventType } from './artifacts/collab-event-log.js';

// C5 人工介入
export { nextPendingGate, allGatesCleared } from './gates/gate-hook.js';
export { HeartbeatMonitor, type HeartbeatEntry } from './gates/heartbeat.js';
