/**
 * 分层任务模型持久化
 *
 * Component → Module → WorkPackage 三层 CRUD。
 * 表由 Migration v18 创建。
 */
import { createAwknId } from '../contracts/ids.js';
import type {
  Component,
  Module,
  WorkPackage,
  ComponentSpec,
  ModuleSpec,
  WorkPackageSpec,
  WorkItemState,
} from '../contracts/workflow.js';
import { queryAll, queryOne, queryRun, transaction } from '../store/db.js';

// ─── Row 类型 ─────────────────────────────────────────────

interface ComponentRow {
  id: string;
  mission_id: string;
  name: string;
  status: string;
  acceptance_criteria: string;
  frozen_target_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface ModuleRow {
  id: string;
  component_id: string;
  name: string;
  status: string;
  boundary: string;
  acceptance_criteria: string;
  frozen_target_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkPackageRow {
  id: string;
  module_id: string;
  name: string;
  status: string;
  scope: string;
  acceptance_criteria: string;
  dependencies: string;
  assigned_actor_id: string | null;
  engineer_receipt_id: string | null;
  test_receipt_id: string | null;
  review_receipt_id: string | null;
  git_receipt_id: string | null;
  retro_receipt_id: string | null;
  frozen_target_hash: string | null;
  created_at: string;
  updated_at: string;
}

// ─── 转换函数 ─────────────────────────────────────────────

function rowToComponent(row: ComponentRow): Component {
  return {
    schema: 'awkn-component/v1',
    id: row.id,
    missionId: row.mission_id,
    name: row.name,
    status: row.status as WorkItemState,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria),
    frozenTargetHash: row.frozen_target_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToModule(row: ModuleRow): Module {
  return {
    schema: 'awkn-module/v1',
    id: row.id,
    componentId: row.component_id,
    name: row.name,
    status: row.status as WorkItemState,
    boundary: row.boundary,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria),
    frozenTargetHash: row.frozen_target_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWorkPackage(row: WorkPackageRow): WorkPackage {
  return {
    schema: 'awkn-work-package/v1',
    id: row.id,
    moduleId: row.module_id,
    name: row.name,
    status: row.status as WorkItemState,
    scope: row.scope,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria),
    dependencies: JSON.parse(row.dependencies),
    assignedActorId: row.assigned_actor_id ?? undefined,
    engineerReceiptId: row.engineer_receipt_id ?? undefined,
    testReceiptId: row.test_receipt_id ?? undefined,
    reviewReceiptId: row.review_receipt_id ?? undefined,
    gitReceiptId: row.git_receipt_id ?? undefined,
    retroReceiptId: row.retro_receipt_id ?? undefined,
    frozenTargetHash: row.frozen_target_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Component CRUD ───────────────────────────────────────

export function createComponent(missionId: string, spec: ComponentSpec): Component {
  const now = new Date().toISOString();
  const id = createAwknId('component');
  queryRun(
    `INSERT INTO workflow_component (id, mission_id, name, status, acceptance_criteria, created_at, updated_at)
     VALUES (?, ?, ?, 'DRAFT', ?, ?, ?)`,
    [id, missionId, spec.name, JSON.stringify(spec.acceptanceCriteria), now, now],
  );
  return {
    schema: 'awkn-component/v1',
    id,
    missionId,
    name: spec.name,
    status: 'DRAFT',
    acceptanceCriteria: spec.acceptanceCriteria,
    createdAt: now,
    updatedAt: now,
  };
}

export function getComponent(id: string): Component | undefined {
  const row = queryOne<ComponentRow>('SELECT * FROM workflow_component WHERE id = ?', [id]);
  return row ? rowToComponent(row) : undefined;
}

export function getComponentsByMission(missionId: string): Component[] {
  return queryAll<ComponentRow>('SELECT * FROM workflow_component WHERE mission_id = ? ORDER BY created_at', [missionId]).map(rowToComponent);
}

export function updateComponentStatus(id: string, status: WorkItemState): void {
  const now = new Date().toISOString();
  queryRun('UPDATE workflow_component SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
}

export function freezeComponentTarget(id: string, hash: string): void {
  const now = new Date().toISOString();
  queryRun('UPDATE workflow_component SET frozen_target_hash = ?, updated_at = ? WHERE id = ?', [hash, now, id]);
}

// ─── Module CRUD ──────────────────────────────────────────

export function createModule(componentId: string, spec: ModuleSpec): Module {
  const now = new Date().toISOString();
  const id = createAwknId('module');
  queryRun(
    `INSERT INTO workflow_module (id, component_id, name, status, boundary, acceptance_criteria, created_at, updated_at)
     VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [id, componentId, spec.name, spec.boundary, JSON.stringify(spec.acceptanceCriteria), now, now],
  );
  return {
    schema: 'awkn-module/v1',
    id,
    componentId,
    name: spec.name,
    status: 'DRAFT',
    boundary: spec.boundary,
    acceptanceCriteria: spec.acceptanceCriteria,
    createdAt: now,
    updatedAt: now,
  };
}

export function getModule(id: string): Module | undefined {
  const row = queryOne<ModuleRow>('SELECT * FROM workflow_module WHERE id = ?', [id]);
  return row ? rowToModule(row) : undefined;
}

export function getModulesByComponent(componentId: string): Module[] {
  return queryAll<ModuleRow>('SELECT * FROM workflow_module WHERE component_id = ? ORDER BY created_at', [componentId]).map(rowToModule);
}

export function updateModuleStatus(id: string, status: WorkItemState): void {
  const now = new Date().toISOString();
  queryRun('UPDATE workflow_module SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
}

// ─── WorkPackage CRUD ─────────────────────────────────────

export function createWorkPackage(moduleId: string, spec: WorkPackageSpec): WorkPackage {
  const now = new Date().toISOString();
  const id = createAwknId('workPackage');
  queryRun(
    `INSERT INTO workflow_work_package
       (id, module_id, name, status, scope, acceptance_criteria, dependencies, created_at, updated_at)
     VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
    [id, moduleId, spec.name, spec.scope, JSON.stringify(spec.acceptanceCriteria), JSON.stringify(spec.dependencies), now, now],
  );
  return {
    schema: 'awkn-work-package/v1',
    id,
    moduleId,
    name: spec.name,
    status: 'DRAFT',
    scope: spec.scope,
    acceptanceCriteria: spec.acceptanceCriteria,
    dependencies: spec.dependencies,
    createdAt: now,
    updatedAt: now,
  };
}

export function getWorkPackage(id: string): WorkPackage | undefined {
  const row = queryOne<WorkPackageRow>('SELECT * FROM workflow_work_package WHERE id = ?', [id]);
  return row ? rowToWorkPackage(row) : undefined;
}

export function getWorkPackagesByModule(moduleId: string): WorkPackage[] {
  return queryAll<WorkPackageRow>('SELECT * FROM workflow_work_package WHERE module_id = ? ORDER BY created_at', [moduleId]).map(rowToWorkPackage);
}

export function updateWorkPackageStatus(id: string, status: WorkItemState): void {
  const now = new Date().toISOString();
  queryRun('UPDATE workflow_work_package SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
}

export function assignWorkPackage(id: string, actorId: string): void {
  const now = new Date().toISOString();
  queryRun('UPDATE workflow_work_package SET assigned_actor_id = ?, status = ?, updated_at = ? WHERE id = ?', [actorId, 'ASSIGNED', now, id]);
}

export function attachReceipt(workPackageId: string, receiptType: 'engineer' | 'test' | 'review' | 'git' | 'retro', receiptId: string): void {
  const now = new Date().toISOString();
  const column = `${receiptType}_receipt_id`;
  queryRun(
    `UPDATE workflow_work_package SET ${column} = ?, updated_at = ? WHERE id = ?`,
    [receiptId, now, workPackageId],
  );
}

export function freezeWorkPackageTarget(id: string, hash: string): void {
  const now = new Date().toISOString();
  queryRun('UPDATE workflow_work_package SET frozen_target_hash = ?, updated_at = ? WHERE id = ?', [hash, now, id]);
}

// ─── 树查询 ───────────────────────────────────────────────

export interface MissionTree {
  components: Array<Component & {
    modules: Array<Module & {
      workPackages: WorkPackage[];
    }>;
  }>;
}

export function getMissionTree(missionId: string): MissionTree {
  return transaction(() => {
    const components = getComponentsByMission(missionId);
    return {
      components: components.map((component) => {
        const modules = getModulesByComponent(component.id);
        return {
          ...component,
          modules: modules.map((module) => ({
            ...module,
            workPackages: getWorkPackagesByModule(module.id),
          })),
        };
      }),
    };
  });
}
