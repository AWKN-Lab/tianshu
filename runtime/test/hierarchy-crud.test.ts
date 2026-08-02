/**
 * 分层任务模型 CRUD 测试 — Component / Module / WorkPackage
 *
 * 对应工程文档 7.1: test/hierarchy.test.ts
 * 覆盖: createComponent, createModule, createWorkPackage, get*, getMissionTree,
 *       updateStatus, freezeTarget, assignWorkPackage, attachReceipt
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb, queryRun } from '../src/store/db.js';
import {
  createComponent as _createComponent,
  getComponent,
  getComponentsByMission,
  freezeComponentTarget,
  createModule,
  getModule,
  getModulesByComponent,
  createWorkPackage,
  getWorkPackage,
  getWorkPackagesByModule,
  updateWorkPackageStatus,
  assignWorkPackage,
  attachReceipt,
  freezeWorkPackageTarget,
  getMissionTree,
} from '../src/hierarchy/repository.js';
import type { ComponentSpec } from '../src/contracts/workflow.js';

/** 包装 createComponent，自动插入 goal 记录以满足 FK 约束 */
function createComponent(missionId: string, spec: ComponentSpec): ReturnType<typeof _createComponent> {
  seedGoal(missionId);
  return _createComponent(missionId, spec);
}

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-hierarchy-'));
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

/** 插入 goal 记录以满足 workflow_component.mission_id FK 约束 */
function seedGoal(missionId: string): void {
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO goals (id, title, description, created_at, updated_at)
     VALUES (?, ?, '', ?, ?)`,
    [missionId, `Test mission ${missionId}`, now, now],
  );
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Hierarchy CRUD — Component / Module / WorkPackage', () => {
  before(async () => {
    await setupIsolatedDb();
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  describe('Component CRUD', () => {
    it('创建 Component 并读回', () => {
      const missionId = 'msn_comp_test';
      seedGoal(missionId);
      const comp = createComponent(missionId, {
        name: 'AuthComponent',
        acceptanceCriteria: ['AC-1', 'AC-2'],
      });

      assert.equal(comp.schema, 'awkn-component/v1');
      assert.equal(comp.missionId, missionId);
      assert.equal(comp.name, 'AuthComponent');
      assert.equal(comp.status, 'DRAFT');
      assert.deepEqual(comp.acceptanceCriteria, ['AC-1', 'AC-2']);
      assert.ok(comp.id.startsWith('comp_'));

      const fetched = getComponent(comp.id);
      assert.ok(fetched);
      assert.equal(fetched!.name, 'AuthComponent');
      assert.equal(fetched!.status, 'DRAFT');
      assert.deepEqual(fetched!.acceptanceCriteria, ['AC-1', 'AC-2']);
    });

    it('按 Mission 查询 Components', () => {
      const missionId = 'msn_list';
      createComponent(missionId, { name: 'C1', acceptanceCriteria: [] });
      createComponent(missionId, { name: 'C2', acceptanceCriteria: [] });
      createComponent('msn_other', { name: 'C3', acceptanceCriteria: [] });

      const list = getComponentsByMission(missionId);
      assert.equal(list.length, 2);
      assert.ok(list.every((c) => c.missionId === missionId));
    });

    it('查询不存在的 Component 返回 undefined', () => {
      const result = getComponent('comp_nonexistent');
      assert.equal(result, undefined);
    });

    it('freezeComponentTarget 设置冻结哈希', () => {
      const missionId = 'msn_freeze';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      assert.equal(comp.frozenTargetHash, undefined);

      freezeComponentTarget(comp.id, 'abc123hash');
      const fetched = getComponent(comp.id);
      assert.ok(fetched);
      assert.equal(fetched!.frozenTargetHash, 'abc123hash');
    });

    it('同 Mission 下同名 Component 唯一约束', () => {
      const missionId = 'msn_unique';
      createComponent(missionId, { name: 'Unique', acceptanceCriteria: [] });
      assert.throws(() => {
        createComponent(missionId, { name: 'Unique', acceptanceCriteria: [] });
      });
    });
  });

  describe('Module CRUD', () => {
    it('创建 Module 并读回', () => {
      const missionId = 'msn_mod';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      const mod = createModule(comp.id, {
        name: 'UserModule',
        boundary: 'user authentication',
        acceptanceCriteria: ['AC-M1'],
      });

      assert.equal(mod.schema, 'awkn-module/v1');
      assert.equal(mod.componentId, comp.id);
      assert.equal(mod.name, 'UserModule');
      assert.equal(mod.status, 'DRAFT');
      assert.equal(mod.boundary, 'user authentication');
      assert.deepEqual(mod.acceptanceCriteria, ['AC-M1']);
      assert.ok(mod.id.startsWith('mod_'));

      const fetched = getModule(mod.id);
      assert.ok(fetched);
      assert.equal(fetched!.name, 'UserModule');
    });

    it('按 Component 查询 Modules', () => {
      const missionId = 'msn_mod_list';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      createModule(comp.id, { name: 'M1', boundary: 'b1', acceptanceCriteria: [] });
      createModule(comp.id, { name: 'M2', boundary: 'b2', acceptanceCriteria: [] });

      const list = getModulesByComponent(comp.id);
      assert.equal(list.length, 2);
    });

    it('同 Component 下同名 Module 唯一约束', () => {
      const missionId = 'msn_mod_unique';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      createModule(comp.id, { name: 'Dup', boundary: 'b', acceptanceCriteria: [] });
      assert.throws(() => {
        createModule(comp.id, { name: 'Dup', boundary: 'b', acceptanceCriteria: [] });
      });
    });
  });

  describe('WorkPackage CRUD', () => {
    it('创建 WorkPackage 并读回', () => {
      const missionId = 'msn_wp';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      const mod = createModule(comp.id, { name: 'M', boundary: 'b', acceptanceCriteria: [] });
      const wp = createWorkPackage(mod.id, {
        name: 'ImplementLogin',
        scope: 'login flow',
        acceptanceCriteria: ['AC-W1'],
        dependencies: [],
      });

      assert.equal(wp.schema, 'awkn-work-package/v1');
      assert.equal(wp.moduleId, mod.id);
      assert.equal(wp.name, 'ImplementLogin');
      assert.equal(wp.status, 'DRAFT');
      assert.equal(wp.scope, 'login flow');
      assert.deepEqual(wp.acceptanceCriteria, ['AC-W1']);
      assert.deepEqual(wp.dependencies, []);
      assert.ok(wp.id.startsWith('wp_'));

      const fetched = getWorkPackage(wp.id);
      assert.ok(fetched);
      assert.equal(fetched!.name, 'ImplementLogin');
    });

    it('创建带依赖的 WorkPackage', () => {
      const missionId = 'msn_wp_deps';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      const mod = createModule(comp.id, { name: 'M', boundary: 'b', acceptanceCriteria: [] });
      const wp1 = createWorkPackage(mod.id, {
        name: 'WP1', scope: 's', acceptanceCriteria: [], dependencies: [],
      });
      const wp2 = createWorkPackage(mod.id, {
        name: 'WP2', scope: 's', acceptanceCriteria: [], dependencies: [wp1.id],
      });

      const fetched = getWorkPackage(wp2.id);
      assert.ok(fetched);
      assert.deepEqual(fetched!.dependencies, [wp1.id]);
    });

    it('updateWorkPackageStatus 更新状态', () => {
      const missionId = 'msn_wp_status';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      const mod = createModule(comp.id, { name: 'M', boundary: 'b', acceptanceCriteria: [] });
      const wp = createWorkPackage(mod.id, {
        name: 'WP', scope: 's', acceptanceCriteria: [], dependencies: [],
      });

      updateWorkPackageStatus(wp.id, 'READY');
      let fetched = getWorkPackage(wp.id);
      assert.equal(fetched!.status, 'READY');

      updateWorkPackageStatus(wp.id, 'RUNNING');
      fetched = getWorkPackage(wp.id);
      assert.equal(fetched!.status, 'RUNNING');
    });

    it('assignWorkPackage 设置 actor 并转为 ASSIGNED', () => {
      const missionId = 'msn_wp_assign';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      const mod = createModule(comp.id, { name: 'M', boundary: 'b', acceptanceCriteria: [] });
      const wp = createWorkPackage(mod.id, {
        name: 'WP', scope: 's', acceptanceCriteria: [], dependencies: [],
      });

      assignWorkPackage(wp.id, 'actor-001');
      const fetched = getWorkPackage(wp.id);
      assert.equal(fetched!.status, 'ASSIGNED');
      assert.equal(fetched!.assignedActorId, 'actor-001');
    });

    it('attachReceipt 绑定 Receipt ID', () => {
      const missionId = 'msn_wp_receipt';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      const mod = createModule(comp.id, { name: 'M', boundary: 'b', acceptanceCriteria: [] });
      const wp = createWorkPackage(mod.id, {
        name: 'WP', scope: 's', acceptanceCriteria: [], dependencies: [],
      });

      attachReceipt(wp.id, 'engineer', 'rcpt_eng_001');
      attachReceipt(wp.id, 'test', 'rcpt_test_001');
      attachReceipt(wp.id, 'review', 'rcpt_review_001');

      const fetched = getWorkPackage(wp.id);
      assert.equal(fetched!.engineerReceiptId, 'rcpt_eng_001');
      assert.equal(fetched!.testReceiptId, 'rcpt_test_001');
      assert.equal(fetched!.reviewReceiptId, 'rcpt_review_001');
    });

    it('freezeWorkPackageTarget 设置冻结哈希', () => {
      const missionId = 'msn_wp_freeze';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      const mod = createModule(comp.id, { name: 'M', boundary: 'b', acceptanceCriteria: [] });
      const wp = createWorkPackage(mod.id, {
        name: 'WP', scope: 's', acceptanceCriteria: [], dependencies: [],
      });

      freezeWorkPackageTarget(wp.id, 'frozen-hash-abc');
      const fetched = getWorkPackage(wp.id);
      assert.equal(fetched!.frozenTargetHash, 'frozen-hash-abc');
    });

    it('按 Module 查询 WorkPackages', () => {
      const missionId = 'msn_wp_list';
      const comp = createComponent(missionId, { name: 'C', acceptanceCriteria: [] });
      const mod = createModule(comp.id, { name: 'M', boundary: 'b', acceptanceCriteria: [] });
      createWorkPackage(mod.id, { name: 'WP1', scope: 's', acceptanceCriteria: [], dependencies: [] });
      createWorkPackage(mod.id, { name: 'WP2', scope: 's', acceptanceCriteria: [], dependencies: [] });

      const list = getWorkPackagesByModule(mod.id);
      assert.equal(list.length, 2);
    });
  });

  describe('getMissionTree — 树查询', () => {
    it('返回完整的 Component → Module → WorkPackage 树', () => {
      const missionId = 'msn_tree';
      const comp1 = createComponent(missionId, { name: 'C1', acceptanceCriteria: [] });
      const comp2 = createComponent(missionId, { name: 'C2', acceptanceCriteria: [] });

      const mod1a = createModule(comp1.id, { name: 'M1A', boundary: 'b', acceptanceCriteria: [] });
      const mod1b = createModule(comp1.id, { name: 'M1B', boundary: 'b', acceptanceCriteria: [] });
      const mod2a = createModule(comp2.id, { name: 'M2A', boundary: 'b', acceptanceCriteria: [] });

      createWorkPackage(mod1a.id, { name: 'WP1', scope: 's', acceptanceCriteria: [], dependencies: [] });
      createWorkPackage(mod1a.id, { name: 'WP2', scope: 's', acceptanceCriteria: [], dependencies: [] });
      createWorkPackage(mod1b.id, { name: 'WP3', scope: 's', acceptanceCriteria: [], dependencies: [] });
      createWorkPackage(mod2a.id, { name: 'WP4', scope: 's', acceptanceCriteria: [], dependencies: [] });

      const tree = getMissionTree(missionId);

      assert.equal(tree.components.length, 2);
      assert.equal(tree.components[0].modules.length, 2);
      assert.equal(tree.components[1].modules.length, 1);

      // comp1 → 2 modules, mod1a → 2 wps, mod1b → 1 wp
      const c1 = tree.components.find((c) => c.id === comp1.id);
      assert.ok(c1);
      assert.equal(c1!.modules.length, 2);
      const m1a = c1!.modules.find((m) => m.id === mod1a.id);
      assert.ok(m1a);
      assert.equal(m1a!.workPackages.length, 2);
      const m1b = c1!.modules.find((m) => m.id === mod1b.id);
      assert.ok(m1b);
      assert.equal(m1b!.workPackages.length, 1);

      // comp2 → 1 module, mod2a → 1 wp
      const c2 = tree.components.find((c) => c.id === comp2.id);
      assert.ok(c2);
      assert.equal(c2!.modules.length, 1);
      assert.equal(c2!.modules[0].workPackages.length, 1);
    });

    it('空 Mission 返回空树', () => {
      const tree = getMissionTree('msn_empty_tree');
      assert.equal(tree.components.length, 0);
    });

    it('只有 Component 没有 Module 的树', () => {
      const missionId = 'msn_comp_only';
      createComponent(missionId, { name: 'Solo', acceptanceCriteria: [] });

      const tree = getMissionTree(missionId);
      assert.equal(tree.components.length, 1);
      assert.equal(tree.components[0].modules.length, 0);
    });
  });
});
