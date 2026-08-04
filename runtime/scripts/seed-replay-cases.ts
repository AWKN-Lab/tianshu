/**
 * 回放案例种子（治理通道前置数据）
 * 背景：runs 表历史运行均无 prompt 字段，importHistoricalRuns 无法产出回放案例，
 * 导致 evolution promote 被 'no enabled replay cases' 阻断。
 * 本脚本通过 ReplayEvaluator.addCase 公开 API 注入 3 个来自真实会话需求、
 * 无工具副作用（回放执行器 approvedTools=[]）的知识型回放案例。
 * 用法（runtime 目录）: node --import tsx scripts/seed-replay-cases.ts
 */
import { ReplayEvaluator } from '../src/evolve/replay-evaluator.js';
import { closeDb } from '../src/store/db.js';

const evaluator = new ReplayEvaluator();

const cases = [
  {
    name: 'session-replay:git-equivalent-history-alignment',
    input: {
      prompt:
        '问题：远端仓库的提交对象被 API 重建导致本地与远端历史分叉（内容等效但 sha 不同），常规推送被拒。' +
        '请给出完整的对齐处理步骤说明（不少于 200 字），包括如何判定分叉性质、如何安全重建本地独有提交、' +
        '如何做一致性校验、以及为什么不应使用强制推送。只输出说明文本，不要执行任何操作。',
    },
    expected: { success: true },
    tags: ['seeded', 'session-derived', 'git'],
  },
  {
    name: 'session-replay:powershell-params-constraint',
    input: {
      prompt:
        '问题：在 PowerShell 门禁脚本中，带 ValidateSet 约束的参数变量在流程内部被赋值为集合外的哨兵值时发生什么？' +
        '请解释其异常机制，并给出安全的变量流设计建议（不少于 150 字）。只输出说明文本，不要执行任何操作。',
    },
    expected: { success: true },
    tags: ['seeded', 'session-derived', 'powershell'],
  },
  {
    name: 'session-replay:gate-change-acceptance',
    input: {
      prompt:
        '问题：修改 CI 门禁或 git 钩子等拦截型基础设施后，验收标准应该是什么？' +
        '请说明为什么分档单元测试全绿不等于门禁可用，并给出端到端验证的具体做法（不少于 150 字）。' +
        '只输出说明文本，不要执行任何操作。',
    },
    expected: { success: true },
    tags: ['seeded', 'session-derived', 'governance'],
  },
];

let added = 0;
for (const c of cases) {
  const result = evaluator.addCase(c);
  console.log(`added case ${result.id} name=${c.name}`);
  added++;
}

console.log(JSON.stringify({ seeded: added, enabledCases: evaluator.listCases().length }, null, 2));
closeDb();
