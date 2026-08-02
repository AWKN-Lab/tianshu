/**
 * WorkGraph 逻辑测试 — 依赖解析、环路检测、冲突检测、调度
 *
 * 对应工程文档 7.1: test/workgraph.test.ts
 * 覆盖: buildGraph, resolveReady, detectCycles, detectConflicts, scheduleNext, isBlocked
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb, queryRun } from '../src/store/db.js';
import {
  buildGraph,
  resolveReady,
  detectCycles,
  detectConflicts,
} from '../src/workgraph/graph.js';
import { scheduleNext, isBlocked } from '../src/workgraph/scheduler.js';
import {
  createComponent as _createComponent,
  createModule,
  createWorkPackage,
  updateWorkPackageStatus,
  assignWorkPackage,
} from '../src/hierarchy/repository.js';
import type { WorkGraph, WorkGraphNode, WorkItemState, ComponentSpec } from '../src/contracts/workflow.js';

/** 插入 goal 记录以满足 workflow_component.mission_id FK 约束 */
function seedGoal(missionId: string): void {
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR IGNORE INTO goals (id, title, description, created_at, updated_at)
     VALUES (?, ?, '', ?, ?)`,
    [missionId, `Test mission ${missionId}`, now, now],
  );
}

/** 包装 createComponent，自动插入 goal 记录以满足 FK 约束 */
function createComponent(missionId: string, spec: ComponentSpec): ReturnType<typeof _createComponent> {
  seedGoal(missionId);
  return _createComponent(missionId, spec);
}

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-graph-'));
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

// ─── 辅助：创建测试图 ─────────────────────────────────────

function seedMission(missionId: string): {
  compId: string;
  modId: string;
} {
  const comp = createComponent(missionId, {
    name: 'TestComponent',
    acceptanceCriteria: ['AC-1'],
  });
  const mod = createModule(comp.id, {
    name: 'TestModule',
    boundary: 'test boundary',
    acceptanceCriteria: ['AC-M1'],
  });
  return { compId: comp.id, modId: mod.id };
}

function makeNode(
  id: string,
  type: 'workpackage' | 'module' | 'component',
  status: WorkItemState,
  dependencies: string[] = [],
  assignedActorId?: string,
): WorkGraphNode {
  const node: WorkGraphNode = { id, type, status, dependencies };
  if (assignedActorId !== undefined) {
    node.assignedActorId = assignedActorId;
  }
  return node;
}

function makeGraph(nodes: WorkGraphNode[], edges: Array<{ from: string; to: string }>): WorkGraph {
  return {
    schema: 'awkn-work-graph/v1',
    missionId: 'msn_test',
    nodes,
    edges,
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('WorkGraph Logic', () => {
  before(async () => {
    await setupIsolatedDb();
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  describe('buildGraph — 从分层模型构建依赖图', () => {
    it('构建包含 component/module/workpackage 三层节点的图', () => {
      const missionId = 'msn_build_test';
      const { compId, modId } = seedMission(missionId);
      createWorkPackage(modId, {
        name: 'WP1',
        scope: 'scope1',
        acceptanceCriteria: ['AC-W1'],
        dependencies: [],
      });

      const graph = buildGraph(missionId);
      assert.equal(graph.schema, 'awkn-work-graph/v1');
      assert.equal(graph.missionId, missionId);
      assert.equal(graph.nodes.length, 3); // 1 comp + 1 mod + 1 wp
      assert.equal(graph.edges.length, 0);

      const types = graph.nodes.map((n) => n.type).sort();
      assert.deepEqual(types, ['component', 'module', 'workpackage']);
    });

    it('正确构建 WorkPackage 依赖边', () => {
      const missionId = 'msn_deps';
      const { compId, modId } = seedMission(missionId);
      const wp1 = createWorkPackage(modId, {
        name: 'WP1',
        scope: 's1',
        acceptanceCriteria: [],
        dependencies: [],
      });
      const wp2 = createWorkPackage(modId, {
        name: 'WP2',
        scope: 's2',
        acceptanceCriteria: [],
        dependencies: [wp1.id],
      });

      const graph = buildGraph(missionId);
      assert.equal(graph.edges.length, 1);
      assert.equal(graph.edges[0].from, wp1.id);
      assert.equal(graph.edges[0].to, wp2.id);
    });

    it('空 Mission 返回空图', () => {
      const graph = buildGraph('msn_empty');
      assert.equal(graph.nodes.length, 0);
      assert.equal(graph.edges.length, 0);
    });
  });

  describe('resolveReady — 就绪工作包解析', () => {
    it('无依赖的 DRAFT 工作包视为就绪', () => {
      const wpId = 'wp_aaaa';
      const graph = makeGraph(
        [makeNode(wpId, 'workpackage', 'DRAFT', [])],
        [],
      );
      const ready = resolveReady(graph);
      assert.deepEqual(ready, [wpId]);
    });

    it('所有依赖为 CLOSED 的工作包就绪', () => {
      const depId = 'wp_dep1';
      const wpId = 'wp_main1';
      const graph = makeGraph(
        [
          makeNode(depId, 'workpackage', 'CLOSED'),
          makeNode(wpId, 'workpackage', 'DRAFT', [depId]),
        ],
        [{ from: depId, to: wpId }],
      );
      const ready = resolveReady(graph);
      assert.deepEqual(ready, [wpId]);
    });

    it('所有依赖为 INTEGRATED 的工作包也视为就绪', () => {
      const depId = 'wp_dep2';
      const wpId = 'wp_main2';
      const graph = makeGraph(
        [
          makeNode(depId, 'workpackage', 'INTEGRATED'),
          makeNode(wpId, 'workpackage', 'READY', [depId]),
        ],
        [{ from: depId, to: wpId }],
      );
      const ready = resolveReady(graph);
      assert.deepEqual(ready, [wpId]);
    });

    it('依赖未 CLOSED 的工作包不就绪', () => {
      const depId = 'wp_dep3';
      const wpId = 'wp_main3';
      const graph = makeGraph(
        [
          makeNode(depId, 'workpackage', 'RUNNING'),
          makeNode(wpId, 'workpackage', 'DRAFT', [depId]),
        ],
        [{ from: depId, to: wpId }],
      );
      const ready = resolveReady(graph);
      assert.equal(ready.length, 0);
    });

    it('悬空依赖（不在图中）视为未满足', () => {
      const wpId = 'wp_dangling';
      const graph = makeGraph(
        [makeNode(wpId, 'workpackage', 'DRAFT', ['wp_nonexistent'])],
        [{ from: 'wp_nonexistent', to: wpId }],
      );
      const ready = resolveReady(graph);
      assert.equal(ready.length, 0);
    });

    it('非 workpackage 节点不被视为就绪', () => {
      const graph = makeGraph(
        [makeNode('comp_1', 'component', 'DRAFT', [])],
        [],
      );
      const ready = resolveReady(graph);
      assert.equal(ready.length, 0);
    });

    it('已完成状态的工作包不被视为就绪', () => {
      const graph = makeGraph(
        [
          makeNode('wp_done', 'workpackage', 'CLOSED', []),
          makeNode('wp_accepted', 'workpackage', 'ACCEPTED', []),
        ],
        [],
      );
      const ready = resolveReady(graph);
      assert.equal(ready.length, 0);
    });
  });

  describe('detectCycles — 环路检测', () => {
    it('无环图返回空数组', () => {
      const graph = makeGraph(
        [
          makeNode('wp_a', 'workpackage', 'CLOSED', []),
          makeNode('wp_b', 'workpackage', 'DRAFT', ['wp_a']),
        ],
        [{ from: 'wp_a', to: 'wp_b' }],
      );
      const cycles = detectCycles(graph);
      assert.equal(cycles.length, 0);
    });

    it('检测两节点环 (A → B → A)', () => {
      const graph = makeGraph(
        [
          makeNode('wp_a', 'workpackage', 'DRAFT', ['wp_b']),
          makeNode('wp_b', 'workpackage', 'DRAFT', ['wp_a']),
        ],
        [
          { from: 'wp_a', to: 'wp_b' },
          { from: 'wp_b', to: 'wp_a' },
        ],
      );
      const cycles = detectCycles(graph);
      assert.equal(cycles.length, 1);
      assert.equal(cycles[0].length, 2);
    });

    it('检测三节点环', () => {
      const graph = makeGraph(
        [
          makeNode('wp_a', 'workpackage', 'DRAFT', ['wp_c']),
          makeNode('wp_b', 'workpackage', 'DRAFT', ['wp_a']),
          makeNode('wp_c', 'workpackage', 'DRAFT', ['wp_b']),
        ],
        [
          { from: 'wp_a', to: 'wp_b' },
          { from: 'wp_b', to: 'wp_c' },
          { from: 'wp_c', to: 'wp_a' },
        ],
      );
      const cycles = detectCycles(graph);
      assert.equal(cycles.length, 1);
      assert.equal(cycles[0].length, 3);
    });

    it('自环（依赖自身）被检测为长度1的环', () => {
      const wpId = 'wp_self';
      const graph = makeGraph(
        [makeNode(wpId, 'workpackage', 'DRAFT', [wpId])],
        [{ from: wpId, to: wpId }],
      );
      const cycles = detectCycles(graph);
      assert.equal(cycles.length, 1);
      assert.equal(cycles[0].length, 1);
      assert.equal(cycles[0][0], wpId);
    });
  });

  describe('detectConflicts — 冲突检测', () => {
    it('无冲突返回空数组', () => {
      const graph = makeGraph(
        [
          makeNode('wp_a', 'workpackage', 'DRAFT', []),
          makeNode('wp_b', 'workpackage', 'DRAFT', []),
        ],
        [],
      );
      const conflicts = detectConflicts(graph);
      assert.equal(conflicts.length, 0);
    });

    it('检测循环依赖冲突', () => {
      const graph = makeGraph(
        [
          makeNode('wp_a', 'workpackage', 'DRAFT', ['wp_b']),
          makeNode('wp_b', 'workpackage', 'DRAFT', ['wp_a']),
        ],
        [
          { from: 'wp_a', to: 'wp_b' },
          { from: 'wp_b', to: 'wp_a' },
        ],
      );
      const conflicts = detectConflicts(graph);
      assert.ok(conflicts.length >= 1);
      assert.ok(conflicts.some((c) => c.reason.includes('circular')));
    });

    it('检测同一 actor 被分配到多个工作包', () => {
      const actorId = 'actor_dup';
      const graph = makeGraph(
        [
          makeNode('wp_a', 'workpackage', 'ASSIGNED', [], actorId),
          makeNode('wp_b', 'workpackage', 'ASSIGNED', [], actorId),
        ],
        [],
      );
      const conflicts = detectConflicts(graph);
      assert.equal(conflicts.length, 1);
      assert.ok(conflicts[0].reason.includes(actorId));
      assert.equal(conflicts[0].nodeIds.length, 2);
    });

    it('不同 actor 分配到不同工作包无冲突', () => {
      const graph = makeGraph(
        [
          makeNode('wp_a', 'workpackage', 'ASSIGNED', [], 'actor1'),
          makeNode('wp_b', 'workpackage', 'ASSIGNED', [], 'actor2'),
        ],
        [],
      );
      const conflicts = detectConflicts(graph);
      assert.equal(conflicts.length, 0);
    });

    it('自环冲突节点 ID 复写以满足 min(2) 约束', () => {
      const wpId = 'wp_self_conflict';
      const graph = makeGraph(
        [makeNode(wpId, 'workpackage', 'DRAFT', [wpId])],
        [{ from: wpId, to: wpId }],
      );
      const conflicts = detectConflicts(graph);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].nodeIds.length, 2);
      assert.equal(conflicts[0].nodeIds[0], wpId);
      assert.equal(conflicts[0].nodeIds[1], wpId);
    });
  });

  describe('scheduleNext — 调度下一批工作包', () => {
    it('调度无依赖且未分配的 DRAFT 工作包', () => {
      const graph = makeGraph(
        [
          makeNode('wp_a', 'workpackage', 'DRAFT', []),
          makeNode('wp_b', 'workpackage', 'READY', []),
        ],
        [],
      );
      const scheduled = scheduleNext(graph, 10);
      assert.equal(scheduled.length, 2);
    });

    it('尊重 maxConcurrent 上限', () => {
      const graph = makeGraph(
        [
          makeNode('wp_a', 'workpackage', 'DRAFT', []),
          makeNode('wp_b', 'workpackage', 'DRAFT', []),
          makeNode('wp_c', 'workpackage', 'DRAFT', []),
        ],
        [],
      );
      const scheduled = scheduleNext(graph, 2);
      assert.equal(scheduled.length, 2);
    });

    it('已分配的工作包不被调度', () => {
      const graph = makeGraph(
        [
          makeNode('wp_a', 'workpackage', 'ASSIGNED', [], 'actor1'),
          makeNode('wp_b', 'workpackage', 'DRAFT', []),
        ],
        [],
      );
      const scheduled = scheduleNext(graph, 10);
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0], 'wp_b');
    });

    it('依赖未 CLOSED 的工作包不被调度（INTEGRATED 也不行）', () => {
      const graph = makeGraph(
        [
          makeNode('wp_dep', 'workpackage', 'INTEGRATED'),
          makeNode('wp_main', 'workpackage', 'DRAFT', ['wp_dep']),
        ],
        [{ from: 'wp_dep', to: 'wp_main' }],
      );
      const scheduled = scheduleNext(graph, 10);
      assert.equal(scheduled.length, 0);
    });

    it('依赖全为 CLOSED 的工作包可被调度', () => {
      const graph = makeGraph(
        [
          makeNode('wp_dep', 'workpackage', 'CLOSED'),
          makeNode('wp_main', 'workpackage', 'DRAFT', ['wp_dep']),
        ],
        [{ from: 'wp_dep', to: 'wp_main' }],
      );
      const scheduled = scheduleNext(graph, 10);
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0], 'wp_main');
    });

    it('maxConcurrent=0 返回空数组', () => {
      const graph = makeGraph(
        [makeNode('wp_a', 'workpackage', 'DRAFT', [])],
        [],
      );
      const scheduled = scheduleNext(graph, 0);
      assert.equal(scheduled.length, 0);
    });

    it('负数 maxConcurrent 返回空数组', () => {
      const graph = makeGraph(
        [makeNode('wp_a', 'workpackage', 'DRAFT', [])],
        [],
      );
      const scheduled = scheduleNext(graph, -1);
      assert.equal(scheduled.length, 0);
    });
  });

  describe('isBlocked — 阻塞状态检查', () => {
    it('依赖为 BLOCKED 的工作包被阻塞', () => {
      const wp = {
        schema: 'awkn-work-package/v1' as const,
        id: 'wp_main',
        moduleId: 'mod_test',
        name: 'WP',
        status: 'DRAFT' as WorkItemState,
        scope: 's',
        acceptanceCriteria: [],
        dependencies: ['wp_dep'],
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      };
      const graph = makeGraph(
        [makeNode('wp_dep', 'workpackage', 'BLOCKED')],
        [{ from: 'wp_dep', to: wp.id }],
      );
      assert.equal(isBlocked(wp, graph), true);
    });

    it('依赖为 FAILED 的工作包被阻塞', () => {
      const wp = {
        schema: 'awkn-work-package/v1' as const,
        id: 'wp_main',
        moduleId: 'mod_test',
        name: 'WP',
        status: 'DRAFT' as WorkItemState,
        scope: 's',
        acceptanceCriteria: [],
        dependencies: ['wp_dep'],
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      };
      const graph = makeGraph(
        [makeNode('wp_dep', 'workpackage', 'FAILED')],
        [{ from: 'wp_dep', to: wp.id }],
      );
      assert.equal(isBlocked(wp, graph), true);
    });

    it('依赖为 CANCELLED 的工作包被阻塞', () => {
      const wp = {
        schema: 'awkn-work-package/v1' as const,
        id: 'wp_main',
        moduleId: 'mod_test',
        name: 'WP',
        status: 'DRAFT' as WorkItemState,
        scope: 's',
        acceptanceCriteria: [],
        dependencies: ['wp_dep'],
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      };
      const graph = makeGraph(
        [makeNode('wp_dep', 'workpackage', 'CANCELLED')],
        [{ from: 'wp_dep', to: wp.id }],
      );
      assert.equal(isBlocked(wp, graph), true);
    });

    it('依赖为 RUNNING 的工作包不被阻塞（只是未就绪）', () => {
      const wp = {
        schema: 'awkn-work-package/v1' as const,
        id: 'wp_main',
        moduleId: 'mod_test',
        name: 'WP',
        status: 'DRAFT' as WorkItemState,
        scope: 's',
        acceptanceCriteria: [],
        dependencies: ['wp_dep'],
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      };
      const graph = makeGraph(
        [makeNode('wp_dep', 'workpackage', 'RUNNING')],
        [{ from: 'wp_dep', to: wp.id }],
      );
      assert.equal(isBlocked(wp, graph), false);
    });

    it('悬空依赖（不在图中）不视为阻塞', () => {
      const wp = {
        schema: 'awkn-work-package/v1' as const,
        id: 'wp_main',
        moduleId: 'mod_test',
        name: 'WP',
        status: 'DRAFT' as WorkItemState,
        scope: 's',
        acceptanceCriteria: [],
        dependencies: ['wp_nonexistent'],
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      };
      const graph = makeGraph([], []);
      assert.equal(isBlocked(wp, graph), false);
    });

    it('无依赖的工作包不被阻塞', () => {
      const wp = {
        schema: 'awkn-work-package/v1' as const,
        id: 'wp_solo',
        moduleId: 'mod_test',
        name: 'WP',
        status: 'DRAFT' as WorkItemState,
        scope: 's',
        acceptanceCriteria: [],
        dependencies: [],
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      };
      const graph = makeGraph([makeNode(wp.id, 'workpackage', 'DRAFT')], []);
      assert.equal(isBlocked(wp, graph), false);
    });
  });

  describe('集成：DB 驱动的端到端图分析', () => {
    it('从 DB 构建图并解析就绪工作包', () => {
      const missionId = 'msn_integration';
      const { modId } = seedMission(missionId);

      const wp1 = createWorkPackage(modId, {
        name: 'WP1',
        scope: 's1',
        acceptanceCriteria: [],
        dependencies: [],
      });
      const wp2 = createWorkPackage(modId, {
        name: 'WP2',
        scope: 's2',
        acceptanceCriteria: [],
        dependencies: [wp1.id],
      });
      const wp3 = createWorkPackage(modId, {
        name: 'WP3',
        scope: 's3',
        acceptanceCriteria: [],
        dependencies: [wp1.id],
      });

      // 初始状态：只有 WP1 就绪（WP2/WP3 依赖 WP1 而 WP1 还是 DRAFT）
      const graph1 = buildGraph(missionId);
      const ready1 = resolveReady(graph1);
      assert.equal(ready1.length, 1);
      assert.ok(ready1.includes(wp1.id));
      assert.ok(!ready1.includes(wp2.id));
      assert.ok(!ready1.includes(wp3.id));

      // 关闭 WP1 → WP2 和 WP3 就绪
      updateWorkPackageStatus(wp1.id, 'CLOSED');
      const graph2 = buildGraph(missionId);
      const ready2 = resolveReady(graph2);
      assert.ok(!ready2.includes(wp1.id)); // CLOSED 不就绪
      assert.ok(ready2.includes(wp2.id));
      assert.ok(ready2.includes(wp3.id));
    });

    it('调度器排除已分配的工作包', () => {
      const missionId = 'msn_schedule';
      const { modId } = seedMission(missionId);

      const wp1 = createWorkPackage(modId, {
        name: 'WP1',
        scope: 's1',
        acceptanceCriteria: [],
        dependencies: [],
      });
      const wp2 = createWorkPackage(modId, {
        name: 'WP2',
        scope: 's2',
        acceptanceCriteria: [],
        dependencies: [],
      });

      assignWorkPackage(wp1.id, 'actor-1');

      const graph = buildGraph(missionId);
      const scheduled = scheduleNext(graph, 10);
      assert.ok(!scheduled.includes(wp1.id));
      assert.ok(scheduled.includes(wp2.id));
    });
  });
});
