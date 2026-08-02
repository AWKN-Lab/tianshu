/**
 * StageGraph 标准模板
 *
 * 对应工程文档 5.2 节定义的五种标准 StageGraph 模板：
 * - MISSION_INIT: Mission 初始化（产品→需求评审→架构→架构评审→计划→计划评审）
 * - WORKPACKAGE: 单个 WorkPackage 执行（实现→测试→代码评审→安全评审→Git→复盘）
 * - MODULE: 单个 Module 执行（简化版，无安全评审）
 * - COMPONENT: 单个 Component 执行（含发布构建与健康验证）
 * - MISSION_CLOSURE: Mission 收尾（含部署与进化验证）
 *
 * 对应契约: contracts/workflow-v2.ts — StageTemplateSchema
 */
import type {
  StageTemplate,
  StageWorkItemType,
} from '../contracts/workflow-v2.js';

// ─── MISSION_INIT_TEMPLATE ───────────────────────────────
//
// Mission 初始化流程：
// PRODUCT_AUTHOR → REQUIREMENTS_REVIEW → ARCHITECTURE_AUTHOR →
// ARCHITECTURE_REVIEW → PLAN_AUTHOR → PLAN_REVIEW → (WorkGraph 冻结)
//
// PLAN_REVIEW 通过后触发 WorkGraph 冻结（非 Stage，由调度层处理）。
export const MISSION_INIT_TEMPLATE: StageTemplate = {
  templateName: 'mission-init',
  workItemType: 'mission',
  stages: [
    { stageType: 'PRODUCT_AUTHOR', requiredRole: 'Product', optional: false },
    { stageType: 'REQUIREMENTS_REVIEW', requiredRole: 'Review', optional: false },
    { stageType: 'ARCHITECTURE_AUTHOR', requiredRole: 'Architect', optional: false },
    { stageType: 'ARCHITECTURE_REVIEW', requiredRole: 'Review', optional: false },
    { stageType: 'PLAN_AUTHOR', requiredRole: 'Planner', optional: false },
    { stageType: 'PLAN_REVIEW', requiredRole: 'Review', optional: false },
  ],
  edges: [
    { from: 'PRODUCT_AUTHOR', to: 'REQUIREMENTS_REVIEW', condition: 'on_pass' },
    { from: 'REQUIREMENTS_REVIEW', to: 'ARCHITECTURE_AUTHOR', condition: 'on_pass' },
    { from: 'ARCHITECTURE_AUTHOR', to: 'ARCHITECTURE_REVIEW', condition: 'on_pass' },
    { from: 'ARCHITECTURE_REVIEW', to: 'PLAN_AUTHOR', condition: 'on_pass' },
    { from: 'PLAN_AUTHOR', to: 'PLAN_REVIEW', condition: 'on_pass' },
  ],
};

// ─── WORKPACKAGE_TEMPLATE ────────────────────────────────
//
// 单个 WorkPackage 执行流程：
// IMPLEMENT → TEST → CODE_REVIEW → SECURITY_REVIEW (optional) →
// GIT_INTEGRATE → RETROSPECTIVE
export const WORKPACKAGE_TEMPLATE: StageTemplate = {
  templateName: 'workpackage',
  workItemType: 'workpackage',
  stages: [
    { stageType: 'IMPLEMENT', requiredRole: 'Engineer', optional: false },
    { stageType: 'TEST', requiredRole: 'Test', optional: false },
    { stageType: 'CODE_REVIEW', requiredRole: 'Review', optional: false },
    { stageType: 'SECURITY_REVIEW', requiredRole: 'Review', optional: true },
    { stageType: 'GIT_INTEGRATE', requiredRole: 'Git', optional: false },
    { stageType: 'RETROSPECTIVE', requiredRole: 'Retrospective', optional: false },
  ],
  edges: [
    { from: 'IMPLEMENT', to: 'TEST', condition: 'on_pass' },
    { from: 'TEST', to: 'CODE_REVIEW', condition: 'on_pass' },
    { from: 'CODE_REVIEW', to: 'SECURITY_REVIEW', condition: 'on_pass' },
    { from: 'SECURITY_REVIEW', to: 'GIT_INTEGRATE', condition: 'on_pass' },
    { from: 'GIT_INTEGRATE', to: 'RETROSPECTIVE', condition: 'on_pass' },
  ],
};

// ─── MODULE_TEMPLATE ─────────────────────────────────────
//
// 单个 Module 执行流程（简化版，无安全评审）：
// IMPLEMENT → TEST → CODE_REVIEW → GIT_INTEGRATE → RETROSPECTIVE
export const MODULE_TEMPLATE: StageTemplate = {
  templateName: 'module',
  workItemType: 'module',
  stages: [
    { stageType: 'IMPLEMENT', requiredRole: 'Engineer', optional: false },
    { stageType: 'TEST', requiredRole: 'Test', optional: false },
    { stageType: 'CODE_REVIEW', requiredRole: 'Review', optional: false },
    { stageType: 'GIT_INTEGRATE', requiredRole: 'Git', optional: false },
    { stageType: 'RETROSPECTIVE', requiredRole: 'Retrospective', optional: false },
  ],
  edges: [
    { from: 'IMPLEMENT', to: 'TEST', condition: 'on_pass' },
    { from: 'TEST', to: 'CODE_REVIEW', condition: 'on_pass' },
    { from: 'CODE_REVIEW', to: 'GIT_INTEGRATE', condition: 'on_pass' },
    { from: 'GIT_INTEGRATE', to: 'RETROSPECTIVE', condition: 'on_pass' },
  ],
};

// ─── COMPONENT_TEMPLATE ──────────────────────────────────
//
// 单个 Component 执行流程（含发布构建与健康验证）：
// IMPLEMENT → TEST → CODE_REVIEW → SECURITY_REVIEW →
// RELEASE_BUILD → HEALTH_VERIFY → RETROSPECTIVE
export const COMPONENT_TEMPLATE: StageTemplate = {
  templateName: 'component',
  workItemType: 'component',
  stages: [
    { stageType: 'IMPLEMENT', requiredRole: 'Engineer', optional: false },
    { stageType: 'TEST', requiredRole: 'Test', optional: false },
    { stageType: 'CODE_REVIEW', requiredRole: 'Review', optional: false },
    { stageType: 'SECURITY_REVIEW', requiredRole: 'Review', optional: false },
    { stageType: 'RELEASE_BUILD', requiredRole: 'Release', optional: false },
    { stageType: 'HEALTH_VERIFY', requiredRole: 'Review', optional: false },
    { stageType: 'RETROSPECTIVE', requiredRole: 'Retrospective', optional: false },
  ],
  edges: [
    { from: 'IMPLEMENT', to: 'TEST', condition: 'on_pass' },
    { from: 'TEST', to: 'CODE_REVIEW', condition: 'on_pass' },
    { from: 'CODE_REVIEW', to: 'SECURITY_REVIEW', condition: 'on_pass' },
    { from: 'SECURITY_REVIEW', to: 'RELEASE_BUILD', condition: 'on_pass' },
    { from: 'RELEASE_BUILD', to: 'HEALTH_VERIFY', condition: 'on_pass' },
    { from: 'HEALTH_VERIFY', to: 'RETROSPECTIVE', condition: 'on_pass' },
  ],
};

// ─── MISSION_CLOSURE_TEMPLATE ────────────────────────────
//
// Mission 收尾流程（含部署与进化验证）：
// IMPLEMENT → TEST → CODE_REVIEW → SECURITY_REVIEW →
// RELEASE_BUILD → DEPLOY (optional) → HEALTH_VERIFY (optional) →
// RETROSPECTIVE → EVOLUTION_VALIDATE
export const MISSION_CLOSURE_TEMPLATE: StageTemplate = {
  templateName: 'mission-closure',
  workItemType: 'mission',
  stages: [
    { stageType: 'IMPLEMENT', requiredRole: 'Engineer', optional: false },
    { stageType: 'TEST', requiredRole: 'Test', optional: false },
    { stageType: 'CODE_REVIEW', requiredRole: 'Review', optional: false },
    { stageType: 'SECURITY_REVIEW', requiredRole: 'Review', optional: false },
    { stageType: 'RELEASE_BUILD', requiredRole: 'Release', optional: false },
    { stageType: 'DEPLOY', requiredRole: 'Deploy', optional: true },
    { stageType: 'HEALTH_VERIFY', requiredRole: 'Review', optional: true },
    { stageType: 'RETROSPECTIVE', requiredRole: 'Retrospective', optional: false },
    { stageType: 'EVOLUTION_VALIDATE', requiredRole: 'Evolution', optional: false },
  ],
  edges: [
    { from: 'IMPLEMENT', to: 'TEST', condition: 'on_pass' },
    { from: 'TEST', to: 'CODE_REVIEW', condition: 'on_pass' },
    { from: 'CODE_REVIEW', to: 'SECURITY_REVIEW', condition: 'on_pass' },
    { from: 'SECURITY_REVIEW', to: 'RELEASE_BUILD', condition: 'on_pass' },
    { from: 'RELEASE_BUILD', to: 'DEPLOY', condition: 'on_pass' },
    { from: 'DEPLOY', to: 'HEALTH_VERIFY', condition: 'on_pass' },
    { from: 'HEALTH_VERIFY', to: 'RETROSPECTIVE', condition: 'on_pass' },
    { from: 'RETROSPECTIVE', to: 'EVOLUTION_VALIDATE', condition: 'on_pass' },
  ],
};

// ─── 模板选择 ─────────────────────────────────────────────

/**
 * 根据工作项类型返回对应的标准 StageGraph 模板。
 *
 * - 'mission' → MISSION_INIT_TEMPLATE（Mission 初始化为默认模板；
 *   收尾流程使用 MISSION_CLOSURE_TEMPLATE，需显式引用）
 * - 'component' → COMPONENT_TEMPLATE
 * - 'module' → MODULE_TEMPLATE
 * - 'workpackage' → WORKPACKAGE_TEMPLATE
 */
export function getTemplateForWorkItemType(workItemType: StageWorkItemType): StageTemplate {
  switch (workItemType) {
    case 'mission':
      return MISSION_INIT_TEMPLATE;
    case 'component':
      return COMPONENT_TEMPLATE;
    case 'module':
      return MODULE_TEMPLATE;
    case 'workpackage':
      return WORKPACKAGE_TEMPLATE;
    default:
      throw new Error(`unhandled work item type: ${workItemType}`);
  }
}
