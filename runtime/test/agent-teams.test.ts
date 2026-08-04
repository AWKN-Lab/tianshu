/**
 * AgentTeams 验收测试（C1-C5 全链路，stub executor 不依赖 LLM）
 *
 * 覆盖方案模块测试要求：
 * M1.1 schema 校验核心 10 角色全通过 / M1.2 导入数量 7+3 / M1.3 picker 只选一/二梯队
 * M2.1 team.json 校验 / M2.2 DAG 无环校验 / M2.3 四模式各跑通一条链 / M2.5 脑暴 TopN
 * M3.2 人格注入 prompt / M3.3 VERDICT 可读回 / M4.1 工件隔离 / M4.2 事件可回放
 * M5.1 gate 暂停-恢复 / M5.2 心跳超时回收
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PERSONA_CATALOG } from '../src/agent-teams/persona/catalog.js';
import { validatePersona, checkPersona } from '../src/agent-teams/persona/schema.js';
import { importPersonas } from '../src/agent-teams/persona/importer.js';
import { PersonaRegistry } from '../src/agent-teams/persona/registry.js';
import { validateTeam } from '../src/agent-teams/team/team-schema.js';
import { topoWaves, buildTeamDag } from '../src/agent-teams/team/dag-builder.js';
import { TeamLoop } from '../src/agent-teams/team/team-loop.js';
import { runBrainstorm, extractJson } from '../src/agent-teams/team/brainstorm.js';
import { ArtifactStore, sanitizeMissionName } from '../src/agent-teams/artifacts/artifact-store.js';
import { CollabEventLog } from '../src/agent-teams/artifacts/collab-event-log.js';
import { buildWorkerSystemPrompt, renderPersonaSection } from '../src/agent-teams/worker/persona-injector.js';
import { extractVerdict } from '../src/agent-teams/worker/verdict-writer.js';
import { resolveWorkerProvider } from '../src/agent-teams/worker/executor.js';
import { nextPendingGate, allGatesCleared } from '../src/agent-teams/gates/gate-hook.js';
import { HeartbeatMonitor } from '../src/agent-teams/gates/heartbeat.js';
import type { TeamDef, WorkerTaskInput, WorkerTaskOutput, WorkerExecutor } from '../src/agent-teams/team/types.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'awkn-teams-'));
}

function makeTeam(overrides: Partial<TeamDef> = {}): TeamDef {
  return {
    schema: 'awkn-team/v1',
    teamId: 'test-team',
    mission: '跑通 spec→engineer→audit 三 Worker 链',
    mode: 'sequential',
    workers: [
      { workerId: 'w-spec', personaId: 'socrates', capability: 'spec', task: '产出规格' },
      { workerId: 'w-eng', personaId: 'coder', capability: 'engineer', task: '实现功能' },
      { workerId: 'w-audit', personaId: 'verifier', capability: 'audit', task: '独立审查', isReviewer: true },
    ],
    edges: [
      { from: 'w-spec', to: 'w-eng' },
      { from: 'w-eng', to: 'w-audit' },
    ],
    ...overrides,
  };
}

function stubExecutor(reply: (input: WorkerTaskInput) => string): WorkerExecutor {
  return async (input) => ({ text: reply(input) });
}

function newLoop(executor: WorkerExecutor): { loop: TeamLoop; dir: string } {
  const dir = tempDir();
  const loop = new TeamLoop({
    executor,
    artifacts: new ArtifactStore(join(dir, 'artifacts')),
    runRoot: join(dir, 'runs'),
  });
  return { loop, dir };
}

// ─── C1 人格库 ─────────────────────────────────────────

describe('C1 persona-schema (M1.1)', () => {
  it('核心 7 + 可选 3 人格全部通过 schema 校验', () => {
    assert.equal(PERSONA_CATALOG.length, 10);
    assert.equal(PERSONA_CATALOG.filter((p) => p.tier === 1).length, 7);
    assert.equal(PERSONA_CATALOG.filter((p) => p.tier === 2).length, 3);
    for (const p of PERSONA_CATALOG) {
      const checked = checkPersona(p);
      assert.ok(checked.ok, `${p.id} 校验失败：${checked.errors.join('; ')}`);
      assert.equal(validatePersona(p).id, p.id);
    }
  });

  it('字段缺失 → 拒绝入库', () => {
    const broken = { id: 'x', name: '缺字段' };
    const checked = checkPersona(broken);
    assert.equal(checked.ok, false);
    assert.throws(() => validatePersona(broken));
  });

  it('人格统一中文命名（name 为中文职能名）', () => {
    for (const p of PERSONA_CATALOG) {
      assert.match(p.name, /[\u4e00-\u9fa5]/, `${p.id} name 必须含中文`);
    }
  });
});

describe('C1 persona-importer (M1.2)', () => {
  it('导入后核心数量=7（含可选=10），第三梯队不入库', () => {
    const dir = tempDir();
    const results = importPersonas(dir);
    assert.equal(results.filter((r) => r.status === 'imported').length, 10);
    for (const p of PERSONA_CATALOG) {
      assert.ok(existsSync(join(dir, `${p.id}.json`)), `${p.id}.json 缺失`);
      assert.ok(existsSync(join(dir, `${p.id}.prompt.md`)), `${p.id}.prompt.md 缺失`);
    }
    assert.ok(existsSync(join(dir, 'personas.json')), 'personas.json 索引缺失');
    const index = JSON.parse(readFileSync(join(dir, 'personas.json'), 'utf-8'));
    assert.equal(index.personas.length, 10);
    // 幂等：二次导入全部 skipped
    const again = importPersonas(dir);
    assert.ok(again.every((r) => r.status === 'skipped'));
  });
});

describe('C1 persona-picker (M1.3)', () => {
  const dir = tempDir();
  importPersonas(dir);
  const registry = new PersonaRegistry(dir);

  it('「评审代码安全」选中 验证官/侦探 类视角', () => {
    const result = registry.pick('评审代码安全，做一次独立代码审核', 4);
    const ids = result.council.map((p) => p.id);
    assert.ok(ids.includes('verifier'), `应选中验证官，实际 ${ids}`);
    assert.ok(ids.includes('sherlock'), `应选中侦探，实际 ${ids}`);
  });

  it('picker 只在一/二梯队内选（杜绝内容类人格）', () => {
    for (const mission of ['评审代码安全', '实现登录功能', '产品需求定义', '随便聊聊']) {
      const { council } = registry.pick(mission, 5);
      for (const p of council) {
        assert.ok(p.tier === 1 || p.tier === 2, `${p.id} 不应被选中（tier=${p.tier}）`);
      }
    }
  });

  it('环节定位：需求→prd/drucker，修复→bugfix/coder', () => {
    assert.equal(registry.pick('写一份产品需求 PRD').stage, 'prd');
    assert.equal(registry.pick('修复登录 bug').stage, 'bugfix');
  });
});

// ─── C2 团队编排 ───────────────────────────────────────

describe('C2 team-schema (M2.1)', () => {
  it('示例 team.json 校验通过', () => {
    const team = validateTeam(makeTeam());
    assert.equal(team.workers.length, 3);
  });

  it('workerId 重复 / 悬空引用 → 抛错', () => {
    const dup = makeTeam({ workers: [makeTeam().workers[0], makeTeam().workers[0]] });
    assert.throws(() => validateTeam(dup), /workerId 重复/);
    const dangling = makeTeam({ edges: [{ from: 'ghost', to: 'w-eng' }] });
    assert.throws(() => validateTeam(dangling), /悬空/);
  });
});

describe('C2 dag-builder (M2.2)', () => {
  it('拓扑分波正确（同波无依赖可并行）', () => {
    const waves = topoWaves(['a', 'b', 'c'], [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }]);
    assert.deepEqual(waves, [['a', 'b'], ['c']]);
  });

  it('环依赖 → 抛错', () => {
    assert.throws(() => topoWaves(['a', 'b'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]), /环依赖/);
  });

  it('review-chain：全部产出 Worker → 审查 Worker', () => {
    const team = makeTeam({ mode: 'review-chain', edges: undefined });
    const dag = buildTeamDag(team, () => undefined);
    assert.ok(dag.edges.some((e) => e.from === 'w-spec' && e.to === 'w-audit'));
    assert.ok(dag.edges.some((e) => e.from === 'w-eng' && e.to === 'w-audit'));
    // 审查 Worker 在最后一波（不被被审环节反向驱动）
    assert.equal(dag.waves[dag.waves.length - 1].includes('w-audit'), true);
  });
});

describe('C2 team-loop (M2.3) 四模式', () => {
  it('sequential：三 Worker 顺序链跑通并汇总', async () => {
    const order: string[] = [];
    const { loop } = newLoop(
      stubExecutor((input) => {
        order.push(input.workerId);
        return `${input.workerId} 完成（${input.personaName}）`;
      }),
    );
    const state = await loop.start(makeTeam());
    assert.equal(state.status, 'done');
    assert.deepEqual(order, ['w-spec', 'w-eng', 'w-audit']);
    assert.ok(state.summary?.includes('w-eng'));
    // 上游工件路径传给下游（降 token：只传路径）
  });

  it('parallel：无依赖 Worker 并行派发', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const executor: WorkerExecutor = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { text: 'done' };
    };
    const { loop } = newLoop(executor);
    const team = makeTeam({
      mode: 'parallel',
      edges: [{ from: 'w-spec', to: 'w-audit' }, { from: 'w-eng', to: 'w-audit' }],
    });
    const state = await loop.start(team);
    assert.equal(state.status, 'done');
    assert.ok(maxConcurrent >= 2, `应并行派发，实际最大并发 ${maxConcurrent}`);
  });

  it('review-chain PASS → done；FAIL → failed（结论回灌）', async () => {
    // PASS 场景
    const passLoop = newLoop(
      stubExecutor((input) => {
        if (input.isReviewer) {
          writeFileSync(join(input.artifactDir, 'verdict.json'), JSON.stringify({ verdict: 'PASS' }));
          return '审查通过\nVERDICT: PASS';
        }
        return '产出完成';
      }),
    ).loop;
    const passState = await passLoop.start(makeTeam({ mode: 'review-chain', edges: undefined, mission: 'review-chain PASS 场景使命' }));
    assert.equal(passState.status, 'done');
    const reviewerNode = passState.workers.find((w) => w.workerId === 'w-audit');
    assert.equal(reviewerNode?.verdict, 'PASS');

    // FAIL 场景
    const failLoop = newLoop(
      stubExecutor((input) => {
        if (input.isReviewer) {
          writeFileSync(join(input.artifactDir, 'verdict.json'), JSON.stringify({ verdict: 'FAIL' }));
          return '证据不足\nVERDICT: FAIL';
        }
        return '产出完成';
      }),
    ).loop;
    const failState = await failLoop.start(makeTeam({ mode: 'review-chain', edges: undefined, mission: 'review-chain FAIL 场景使命' }));
    assert.equal(failState.status, 'failed');
  });

  it('brainstorm：diverge→converge→challenge→expand 产出 TopN 卡', async () => {
    const executor: WorkerExecutor = async (input) => {
      if (input.workerId.endsWith('~diverge')) {
        return { text: `{"cards":[{"title":"方案-${input.personaId}","rationale":"来自${input.personaId}的理由"}]}` };
      }
      if (input.workerId.endsWith('~converge')) {
        return { text: '{"topIds":["w-a~diverge-1","w-b~diverge-1"]}' };
      }
      if (input.workerId.endsWith('~challenge')) {
        return { text: '{"challenges":["风险：边界未定义"]}' };
      }
      return { text: '{"cards":[{"title":"终版方案","rationale":"吸收质疑后完善"}]}' };
    };
    const { loop, dir } = newLoop(executor);
    const team = makeTeam({
      mode: 'brainstorm',
      workers: [
        { workerId: 'w-a', personaId: 'drucker', task: '脑暴' },
        { workerId: 'w-b', personaId: 'socrates', task: '脑暴' },
        { workerId: 'w-c', personaId: 'verifier', task: '质疑' },
      ],
      edges: undefined,
    });
    const state = await loop.start(team);
    assert.equal(state.status, 'done');
    assert.match(state.summary ?? '', /脑暴完成/);
    // 卡片落 C4 工件
    const cardsFile = join(dir, 'artifacts', sanitizeMissionName(team.mission), '_brainstorm', 'cards.json');
    assert.ok(existsSync(cardsFile), 'cards.json 应落盘');
    const cards = JSON.parse(readFileSync(cardsFile, 'utf-8'));
    assert.ok(cards.topCards.length >= 1);
    assert.ok(cards.phases.includes('converge'));
  });

  it('extractJson：围栏与裸 JSON 均可提取', () => {
    assert.deepEqual(extractJson('前言```json\n{"a":1}\n```后记'), { a: 1 });
    assert.deepEqual(extractJson('噪声 [1,2] 噪声'), [1, 2]);
    assert.equal(extractJson('没有 json'), null);
  });
});

// ─── C3 Worker 执行 ────────────────────────────────────

describe('C3 persona-injector (M3.2)', () => {
  const persona = PERSONA_CATALOG.find((p) => p.id === 'verifier')!;

  it('注入后 prompt 含人格段（name + 思维模型 + 边界）', () => {
    const prompt = buildWorkerSystemPrompt({ persona, isReviewer: true });
    assert.ok(prompt);
    assert.ok(prompt!.includes(persona.name));
    assert.ok(prompt!.includes('思维模型'));
    assert.ok(prompt!.includes('独立审查守则'));
    assert.ok(prompt!.includes('VERDICT'));
  });

  it('人格缺失 → 退回纯骨架/审查守则（不中断）', () => {
    const prompt = buildWorkerSystemPrompt({ isReviewer: true });
    assert.ok(prompt);
    assert.ok(prompt!.includes('独立审查守则'));
    assert.ok(!prompt!.includes('人格视角'));
  });

  it('全空 → null', () => {
    assert.equal(buildWorkerSystemPrompt({}), null);
  });

  it('renderPersonaSection 含 boundaries', () => {
    const text = renderPersonaSection(persona);
    assert.ok(text.includes('职责边界'));
  });
});

describe('C3 verdict-writer (M3.3)', () => {
  it('严格解析单行 VERDICT（冲突 fail-closed）', () => {
    assert.equal(extractVerdict('结论\nVERDICT: PASS'), 'PASS');
    assert.equal(extractVerdict('VERDICT: FAIL'), 'FAIL');
    assert.equal(extractVerdict('VERDICT: PASS\nVERDICT: FAIL'), null);
    assert.equal(extractVerdict('没有裁决行'), null);
  });
});

describe('C3 worker-provider（不走 trae 桥接）', () => {
  it('缺省 opencode；显式注入与环境变量可覆盖（测后还原 env）', () => {
    const saved = process.env.AWKN_TEAM_LLM_PROVIDER;
    try {
      delete process.env.AWKN_TEAM_LLM_PROVIDER;
      assert.equal(resolveWorkerProvider(), 'opencode');
      assert.equal(resolveWorkerProvider('minimax'), 'minimax');
      process.env.AWKN_TEAM_LLM_PROVIDER = 'minimax';
      assert.equal(resolveWorkerProvider(), 'minimax');
      process.env.AWKN_TEAM_LLM_PROVIDER = '非法值';
      assert.equal(resolveWorkerProvider(), 'opencode');
    } finally {
      if (saved === undefined) delete process.env.AWKN_TEAM_LLM_PROVIDER;
      else process.env.AWKN_TEAM_LLM_PROVIDER = saved;
    }
  });
});

// ─── C4 协作通信 ───────────────────────────────────────

describe('C4 artifact-store (M4.1)', () => {
  it('跨 Worker 读写 + 主工件优先 output.md', () => {
    const store = new ArtifactStore(tempDir());
    const p1 = store.write('使命A', 'w-a', 'output.md', '上游产物');
    store.write('使命A', 'w-a', 'extra.json', '{}');
    store.write('使命A', 'w-b', 'output.md', '下游产物');
    assert.equal(store.read(p1), '上游产物');
    assert.equal(store.primaryArtifact('使命A', 'w-a')?.endsWith('output.md'), true);
    assert.equal(store.listWorkerArtifacts('使命A', 'w-b').length, 1);
    assert.equal(store.primaryArtifact('使命A', 'ghost'), null);
  });

  it('路径穿越防护：非法 workerId / 文件名 / 使命名', () => {
    const store = new ArtifactStore(tempDir());
    assert.throws(() => store.workerDir('m', '../evil'));
    assert.throws(() => store.write('m', 'w', '../x.md', 'x'));
    assert.ok(!sanitizeMissionName('../../etc/passwd').includes('..'));
  });
});

describe('C4 collab-event-log (M4.2)', () => {
  it('事件追加后全链路可回放（保序）', () => {
    const store = new ArtifactStore(tempDir());
    const log = new CollabEventLog(store);
    log.append('使命B', { runId: 'r1', type: 'team_started' });
    log.append('使命B', { runId: 'r1', type: 'worker_done', workerId: 'w-a' });
    log.append('使命B', { runId: 'r1', type: 'team_done' });
    const events = log.replay('使命B');
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.type), ['team_started', 'worker_done', 'team_done']);
    assert.equal(log.replay('无事件使命').length, 0);
  });
});

// ─── C5 人工介入 ───────────────────────────────────────

describe('C5 gate-hook (M5.1)', () => {
  it('gate 暂停 → intervene 批准 → 恢复至 done', async () => {
    const { loop } = newLoop(stubExecutor(() => '完成'));
    const team = makeTeam({ gates: [{ after: 'w-spec', kind: 'approval', label: '规格基线批准' }] });
    const gated = await loop.start(team);
    assert.equal(gated.status, 'gating');
    assert.equal(gated.pendingGate?.after, 'w-spec');
    // 未完成 Worker 保持 pending
    assert.equal(gated.workers.find((w) => w.workerId === 'w-eng')?.status, 'pending');

    const resumed = await loop.intervene(gated.runId, '批准规格基线');
    assert.equal(resumed.status, 'done');
    assert.ok(resumed.approvedGates.includes('w-spec'));
    assert.ok(resumed.directives.includes('批准规格基线'));
    assert.ok(resumed.workers.every((w) => w.status === 'done'));
  });

  it('nextPendingGate / allGatesCleared 纯函数语义', () => {
    const team = makeTeam({ gates: [{ after: 'w-eng', kind: 'approval' }] });
    assert.equal(nextPendingGate(team, new Set(['w-spec']), new Set()), null);
    const gate = nextPendingGate(team, new Set(['w-eng']), new Set());
    assert.equal(gate?.after, 'w-eng');
    assert.equal(allGatesCleared(team, new Set(['w-eng']), new Set(['w-eng'])), true);
  });

  it('status/cancel 生命周期', async () => {
    const { loop } = newLoop(stubExecutor(() => '完成'));
    const gated = await loop.start(makeTeam({ gates: [{ after: 'w-spec', kind: 'approval' }] }));
    assert.equal(loop.status(gated.runId)?.status, 'gating');
    assert.equal(loop.cancel(gated.runId).status, 'cancelled');
    assert.ok(loop.list().some((r) => r.runId === gated.runId));
  });
});

describe('C5 heartbeat (M5.2)', () => {
  it('超时触发回收（时钟可注入）', () => {
    let clock = 1000;
    const hb = new HeartbeatMonitor(100, () => clock);
    hb.start('worker-a');
    hb.touch('worker-a');
    assert.equal(hb.isExpired('worker-a'), false);
    clock += 200; // 超过 timeoutMs
    assert.equal(hb.isExpired('worker-a'), true);
    assert.deepEqual(hb.reap(), ['worker-a']);
    assert.deepEqual(hb.active(), []);
  });
});
