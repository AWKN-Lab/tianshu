/**
 * WorkGraph 模块公共 API
 *
 * 统一导出依赖图构建、就绪解析、冲突检测、环路检测与调度能力。
 */
export {
  buildGraph,
  resolveReady,
  detectConflicts,
  detectCycles,
} from './graph.js';

export {
  scheduleNext,
  isBlocked,
} from './scheduler.js';
