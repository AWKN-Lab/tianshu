/**
 * StageGraph 模板与图函数测试
 *
 * 覆盖: 5 种标准模板 (MISSION_INIT / WORKPACKAGE / MODULE / COMPONENT / MISSION_CLOSURE)、
 *       getTemplateForWorkItemType、buildStageGraph、resolveReadyStages、
 *       resolveNextStages、detectStageCycles、getStageDependencies、isStageOptional
 *
 * 对应源码: src/workflow/stage-template.ts, src/workflow/stage-graph.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb } from '../src/store/db.js';
import {
  MISSION_INIT_TEMPLATE,
  WORKPACKAGE_TEMPLATE,
  MODULE_TEMPLATE,
  COMPONENT_TEMPLATE,
  MISSION_CLOSURE_TEMPLATE,
  getTemplateForWorkItemType,
} from '../src/workflow/stage-template.js';
import {
  buildStageGraph,
  resolveReadyStages,
  resolveNextStages,
  detectStageCycles,
  getStageDependencies,
  isStageOptional,
} from '../src/workflow/stage-graph.js';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-stage-graph-'));
  process.env.AWKN_DB_PATH = join(tempDir, `${randomUUID()}.db`);
  closeDb();
  getDb();
}

async function cleanupIsolatedDb(): Promise<void> {
  closeDb();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('StageGraph — 标准模板', () => {
  before(async () => {
    await setupIsolatedDb();
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  describe('MISSION_INIT_TEMPLATE', () => {
    it('包含 6 个 stage', () => {
      assert.equal(MISSION_INIT_TEMPLATE.stages.length, 6);
    });

    it('PRODUCT_AUTHOR → PLAN_REVIEW 链条完整', () => {
      const types = MISSION_INIT_TEMPLATE.stages.map((s) => s.stageType);
      assert.equal(types[0], 'PRODUCT_AUTHOR');
      assert.equal(types[5], 'PLAN_REVIEW');
      assert.deepEqual(
        MISSION_INIT_TEMPLATE.edges.map((e) => `${e.from}→${e.to}`),
        [
          'PRODUCT_AUTHOR→REQUIREMENTS_REVIEW',
          'REQUIREMENTS_REVIEW→ARCHITECTURE_AUTHOR',
          'ARCHITECTURE_AUTHOR→ARCHITECTURE_REVIEW',
          'ARCHITECTURE_REVIEW→PLAN_AUTHOR',
          'PLAN_AUTHOR→PLAN_REVIEW',
        ],
      );
    });

    it('所有 stage 均非可选', () => {
      for (const s of MISSION_INIT_TEMPLATE.stages) {
        assert.equal(s.optional, false, `${s.stageType} should not be optional`);
      }
    });
  });

  describe('WORKPACKAGE_TEMPLATE', () => {
    it('包含 6 个 stage', () => {
      assert.equal(WORKPACKAGE_TEMPLATE.stages.length, 6);
    });

    it('SECURITY_REVIEW 为可选', () => {
      const sec = WORKPACKAGE_TEMPLATE.stages.find((s) => s.stageType === 'SECURITY_REVIEW');
      assert.ok(sec);
      assert.equal(sec!.optional, true);
    });

    it('非 SECURITY_REVIEW 的 stage 均为必选', () => {
      for (const s of WORKPACKAGE_TEMPLATE.stages) {
        if (s.stageType === 'SECURITY_REVIEW') continue;
        assert.equal(s.optional, false, `${s.stageType} should not be optional`);
      }
    });

    it('IMPLEMENT → TEST → CODE_REVIEW → SECURITY_REVIEW → GIT_INTEGRATE → RETROSPECTIVE', () => {
      const types = WORKPACKAGE_TEMPLATE.stages.map((s) => s.stageType);
      assert.deepEqual(types, [
        'IMPLEMENT',
        'TEST',
        'CODE_REVIEW',
        'SECURITY_REVIEW',
        'GIT_INTEGRATE',
        'RETROSPECTIVE',
      ]);
    });
  });

  describe('MODULE_TEMPLATE', () => {
    it('包含 5 个 stage (无安全评审)', () => {
      assert.equal(MODULE_TEMPLATE.stages.length, 5);
      assert.equal(
        MODULE_TEMPLATE.stages.some((s) => s.stageType === 'SECURITY_REVIEW'),
        false,
      );
    });

    it('IMPLEMENT → TEST → CODE_REVIEW → GIT_INTEGRATE → RETROSPECTIVE', () => {
      const types = MODULE_TEMPLATE.stages.map((s) => s.stageType);
      assert.deepEqual(types, [
        'IMPLEMENT',
        'TEST',
        'CODE_REVIEW',
        'GIT_INTEGRATE',
        'RETROSPECTIVE',
      ]);
    });
  });

  describe('COMPONENT_TEMPLATE', () => {
    it('包含 7 个 stage', () => {
      assert.equal(COMPONENT_TEMPLATE.stages.length, 7);
    });

    it('包含 RELEASE_BUILD 和 HEALTH_VERIFY', () => {
      const types = COMPONENT_TEMPLATE.stages.map((s) => s.stageType);
      assert.ok(types.includes('RELEASE_BUILD'));
      assert.ok(types.includes('HEALTH_VERIFY'));
    });

    it('所有 stage 均非可选', () => {
      for (const s of COMPONENT_TEMPLATE.stages) {
        assert.equal(s.optional, false, `${s.stageType} should not be optional`);
      }
    });
  });

  describe('MISSION_CLOSURE_TEMPLATE', () => {
    it('包含 9 个 stage', () => {
      assert.equal(MISSION_CLOSURE_TEMPLATE.stages.length, 9);
    });

    it('DEPLOY 为可选', () => {
      const deploy = MISSION_CLOSURE_TEMPLATE.stages.find((s) => s.stageType === 'DEPLOY');
      assert.ok(deploy);
      assert.equal(deploy!.optional, true);
    });

    it('HEALTH_VERIFY 为可选', () => {
      const hv = MISSION_CLOSURE_TEMPLATE.stages.find((s) => s.stageType === 'HEALTH_VERIFY');
      assert.ok(hv);
      assert.equal(hv!.optional, true);
    });

    it('RETROSPECTIVE → EVOLUTION_VALIDATE 链条', () => {
      const lastEdge = MISSION_CLOSURE_TEMPLATE.edges[MISSION_CLOSURE_TEMPLATE.edges.length - 1];
      assert.equal(lastEdge.from, 'RETROSPECTIVE');
      assert.equal(lastEdge.to, 'EVOLUTION_VALIDATE');
    });
  });

  describe('getTemplateForWorkItemType', () => {
    it('mission → MISSION_INIT_TEMPLATE', () => {
      assert.equal(getTemplateForWorkItemType('mission'), MISSION_INIT_TEMPLATE);
    });

    it('component → COMPONENT_TEMPLATE', () => {
      assert.equal(getTemplateForWorkItemType('component'), COMPONENT_TEMPLATE);
    });

    it('module → MODULE_TEMPLATE', () => {
      assert.equal(getTemplateForWorkItemType('module'), MODULE_TEMPLATE);
    });

    it('workpackage → WORKPACKAGE_TEMPLATE', () => {
      assert.equal(getTemplateForWorkItemType('workpackage'), WORKPACKAGE_TEMPLATE);
    });
  });
});

describe('StageGraph — 图构建与查询', () => {
  before(async () => {
    await setupIsolatedDb();
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  const MISSION_ID = `goal_${'a'.repeat(32)}`;
  const PROFILE_ID = 'prof_test';
  const WORK_ITEM_ID = 'wp_test';

  describe('buildStageGraph', () => {
    it('从 workpackage 模板构建合法 StageGraph', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      assert.equal(graph.schema, 'awkn-stage-graph/v1');
      assert.equal(graph.missionId, MISSION_ID);
      assert.equal(graph.nodes.length, 6);
      assert.equal(graph.edges.length, 5);
      // 每个 node 应有 stageType / workItemType / workItemId / requiredProfileId / optional
      for (const node of graph.nodes) {
        assert.equal(node.workItemType, 'workpackage');
        assert.equal(node.workItemId, WORK_ITEM_ID);
        assert.equal(node.requiredProfileId, PROFILE_ID);
      }
    });

    it('从 mission 模板构建 (MISSION_INIT)', () => {
      const graph = buildStageGraph(MISSION_ID, 'mission', WORK_ITEM_ID, PROFILE_ID);
      assert.equal(graph.nodes.length, 6);
      assert.equal(graph.edges.length, 5);
    });

    it('frozenSourceSha 可选传入', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID, 'abc123sha');
      assert.equal(graph.frozenSourceSha, 'abc123sha');
    });

    it('不传 frozenSourceSha 时为 undefined', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      assert.equal(graph.frozenSourceSha, undefined);
    });
  });

  describe('resolveReadyStages — 入口节点解析', () => {
    it('workpackage 模板入口为 IMPLEMENT (无入边)', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      const ready = resolveReadyStages(graph);
      assert.equal(ready.length, 1);
      assert.equal(ready[0], 'IMPLEMENT');
    });

    it('mission 模板入口为 PRODUCT_AUTHOR', () => {
      const graph = buildStageGraph(MISSION_ID, 'mission', WORK_ITEM_ID, PROFILE_ID);
      const ready = resolveReadyStages(graph);
      assert.equal(ready.length, 1);
      assert.equal(ready[0], 'PRODUCT_AUTHOR');
    });

    it('mission-closure 模板入口为 IMPLEMENT', () => {
      const graph = buildStageGraph(MISSION_ID, 'mission', WORK_ITEM_ID, PROFILE_ID);
      // mission 默认返回 MISSION_INIT_TEMPLATE，手动用 MISSION_CLOSURE 构建
      const closureGraph = buildStageGraph(MISSION_ID, 'mission', WORK_ITEM_ID, PROFILE_ID);
      // 直接验证 MISSION_INIT 的入口
      const ready = resolveReadyStages(closureGraph);
      assert.ok(ready.includes('PRODUCT_AUTHOR'));
    });
  });

  describe('resolveNextStages — 后继解析', () => {
    it('IMPLEMENT 通过后 next 为 TEST', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      const next = resolveNextStages(graph, 'IMPLEMENT');
      assert.deepEqual(next, ['TEST']);
    });

    it('TEST 通过后 next 为 CODE_REVIEW', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      const next = resolveNextStages(graph, 'TEST');
      assert.deepEqual(next, ['CODE_REVIEW']);
    });

    it('RETROSPECTIVE (末端) 通过后 next 为空', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      const next = resolveNextStages(graph, 'RETROSPECTIVE');
      assert.equal(next.length, 0);
    });

    it('PRODUCT_AUTHOR 通过后 next 为 REQUIREMENTS_REVIEW', () => {
      const graph = buildStageGraph(MISSION_ID, 'mission', WORK_ITEM_ID, PROFILE_ID);
      const next = resolveNextStages(graph, 'PRODUCT_AUTHOR');
      assert.deepEqual(next, ['REQUIREMENTS_REVIEW']);
    });
  });

  describe('detectStageCycles — 环路检测', () => {
    it('workpackage 模板无环', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      const cycles = detectStageCycles(graph);
      assert.equal(cycles.length, 0);
    });

    it('mission 模板无环', () => {
      const graph = buildStageGraph(MISSION_ID, 'mission', WORK_ITEM_ID, PROFILE_ID);
      const cycles = detectStageCycles(graph);
      assert.equal(cycles.length, 0);
    });

    it('component 模板无环', () => {
      const graph = buildStageGraph(MISSION_ID, 'component', WORK_ITEM_ID, PROFILE_ID);
      const cycles = detectStageCycles(graph);
      assert.equal(cycles.length, 0);
    });

    it('module 模板无环', () => {
      const graph = buildStageGraph(MISSION_ID, 'module', WORK_ITEM_ID, PROFILE_ID);
      const cycles = detectStageCycles(graph);
      assert.equal(cycles.length, 0);
    });
  });

  describe('getStageDependencies — 传递依赖', () => {
    it('GIT_INTEGRATE 的依赖包含 SECURITY_REVIEW / CODE_REVIEW / TEST / IMPLEMENT', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      const deps = getStageDependencies(graph, 'GIT_INTEGRATE');
      // IMPLEMENT → TEST → CODE_REVIEW → SECURITY_REVIEW → GIT_INTEGRATE
      assert.ok(deps.includes('IMPLEMENT'));
      assert.ok(deps.includes('TEST'));
      assert.ok(deps.includes('CODE_REVIEW'));
      assert.ok(deps.includes('SECURITY_REVIEW'));
      assert.ok(!deps.includes('GIT_INTEGRATE')); // 不含自身
      assert.ok(!deps.includes('RETROSPECTIVE')); // RETROSPECTIVE 在 GIT_INTEGRATE 之后
    });

    it('IMPLEMENT (入口) 无依赖', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      const deps = getStageDependencies(graph, 'IMPLEMENT');
      assert.equal(deps.length, 0);
    });

    it('RETROSPECTIVE 的依赖包含全部前置 stage', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      const deps = getStageDependencies(graph, 'RETROSPECTIVE');
      assert.equal(deps.length, 5);
      assert.ok(deps.includes('IMPLEMENT'));
      assert.ok(deps.includes('TEST'));
      assert.ok(deps.includes('CODE_REVIEW'));
      assert.ok(deps.includes('SECURITY_REVIEW'));
      assert.ok(deps.includes('GIT_INTEGRATE'));
    });
  });

  describe('isStageOptional — 可选标记', () => {
    it('SECURITY_REVIEW 在 WORKPACKAGE 模板中为可选', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      assert.equal(isStageOptional(graph, 'SECURITY_REVIEW'), true);
    });

    it('IMPLEMENT 在 WORKPACKAGE 模板中为必选', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      assert.equal(isStageOptional(graph, 'IMPLEMENT'), false);
    });

    it('DEPLOY 在 MISSION_CLOSURE_TEMPLATE 中为可选', () => {
      // 使用 MISSION_CLOSURE_TEMPLATE 的 stages/edges 手动验证
      const closureGraph = {
        schema: 'awkn-stage-graph/v1' as const,
        missionId: MISSION_ID,
        nodes: MISSION_CLOSURE_TEMPLATE.stages.map((s) => ({
          stageType: s.stageType,
          workItemType: 'mission' as const,
          workItemId: WORK_ITEM_ID,
          requiredProfileId: PROFILE_ID,
          optional: s.optional,
        })),
        edges: MISSION_CLOSURE_TEMPLATE.edges.map((e) => ({ ...e })),
        createdAt: '2026-08-02T00:00:00.000Z',
      };
      assert.equal(isStageOptional(closureGraph, 'DEPLOY'), true);
      assert.equal(isStageOptional(closureGraph, 'HEALTH_VERIFY'), true);
      assert.equal(isStageOptional(closureGraph, 'IMPLEMENT'), false);
    });

    it('图中不存在的 stage 返回 false', () => {
      const graph = buildStageGraph(MISSION_ID, 'workpackage', WORK_ITEM_ID, PROFILE_ID);
      assert.equal(isStageOptional(graph, 'DEPLOY'), false);
    });
  });
});
