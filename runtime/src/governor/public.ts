/**
 * Governor 模块公共 API
 *
 * 职责:
 *   1. Separation Matrix — 强制角色分离（v1）
 *   2. Completion Governor — 唯一可将工作项迁移到完成状态的实体
 *   3. Separation Policy v2 — 20 不相容对 + 10 步判定（Stage 级）
 *   4. Stage Governor — 唯一可将 StageRun 迁移到终态的实体
 */
export { enforceSeparation, type SeparationScope } from './separation-matrix.js';
export {
  transitionState,
  type ItemType,
  type TransitionParams,
  type TransitionResult,
} from './completion-governor.js';
export {
  enforceSeparationV2,
  isIncompatiblePairV2,
  type SeparationCheckParams,
  type SeparationResult,
} from './separation-policy-v2.js';
export {
  transitionStageState,
  type StageTransitionParams,
  type StageTransitionResult,
} from './stage-governor.js';
