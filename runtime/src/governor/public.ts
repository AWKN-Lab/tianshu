/**
 * Governor 模块公共 API
 *
 * 职责:
 *   1. Separation Matrix — 强制角色分离
 *   2. Completion Governor — 唯一可将工作项迁移到完成状态的实体
 */
export { enforceSeparation, type SeparationScope } from './separation-matrix.js';
export {
  transitionState,
  type ItemType,
  type TransitionParams,
  type TransitionResult,
} from './completion-governor.js';
