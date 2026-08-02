/**
 * 分层任务模型公共 API
 *
 * 注意：update*Status 仅允许非完成状态迁移（DRAFT → READY → ASSIGNED → RUNNING 等）。
 * 完成状态（ACCEPTED, INTEGRATED, CLOSED）必须经 Completion Governor 裁决，
 * 详见 src/governor/completion-governor.ts。
 */
export {
  createComponent,
  getComponent,
  getComponentsByMission,
  freezeComponentTarget,
  createModule,
  getModule,
  getModulesByComponent,
  createWorkPackage,
  getWorkPackage,
  getWorkPackagesByModule,
  assignWorkPackage,
  attachReceipt,
  freezeWorkPackageTarget,
  getMissionTree,
  type MissionTree,
} from './repository.js';
