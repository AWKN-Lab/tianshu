/**
 * Workflow Stage 模块公共 API
 *
 * 统一导出 StageGraph 模板、构建查询与 StageRun 持久化能力。
 */
export {
  MISSION_INIT_TEMPLATE,
  WORKPACKAGE_TEMPLATE,
  MODULE_TEMPLATE,
  COMPONENT_TEMPLATE,
  MISSION_CLOSURE_TEMPLATE,
  getTemplateForWorkItemType,
} from './stage-template.js';

export {
  buildStageGraph,
  resolveReadyStages,
  resolveNextStages,
  detectStageCycles,
  getStageDependencies,
  isStageOptional,
} from './stage-graph.js';

export {
  createStageRun,
  getStageRun,
  getStageRunsByWorkItem,
  getStageRunsByMission,
  updateStageRunState,
  assignStageRun,
  getActiveStageRunsByActor,
  getBlockedStageRuns,
} from './stage-store.js';
