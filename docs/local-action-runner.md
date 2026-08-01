# awkn-local-action-runner 工程文档

> 版本：v1.0 | 2026-07-31 | 状态：实施中

## 1. 定位

本地 Action Runner，替代 GitHub Actions（Free plan 额度耗尽）。
在本地 Windows 执行完整 CI/CD Pipeline，嵌入 Agent 能力。

**不是** GitHub Actions 兼容层，是独立本地 Runner。
GitHub 仅作为协作界面（PR comment / status check / tag），不承担计算。

## 2. 架构

```
Trigger (git hook / cron / watch / manual)
  → Runner (编排 jobs/steps)
    → shell-step (execFile)
    → gate-step (quality-gates 7 个 gate)
    → agent-step (AgentLoop.runL1)
  → EventStore (Run/Step/Event 审计)
  → Reporter (Markdown + JSON)
  → GitHub API (gh CLI, 免费)
```

## 3. 新增文件

```
src/action/
├── types.ts           Pipeline/Job/Step 类型 + zod schema
├── loader.ts          JSON Pipeline 定义加载
├── trigger.ts         触发层 (git hook / cron / watch)
├── runner.ts          核心编排 (拓扑排序 → 逐 job → 逐 step)
├── reporter.ts        结构化报告 (Markdown + JSON)
├── git-auto.ts        Git 上下文 / 冻结 / commit+push
├── github-api.ts      GitHub API (gh CLI, 免费部分)
├── action-cli.ts      CLI 命令实现
└── steps/
    ├── shell-step.ts  shell 命令执行
    ├── agent-step.ts  AgentLoop 调用
    └── gate-step.ts   quality-gates 调用

bin/awkn-action-runner.js   CLI 入口 (tsx 启动)
.awkn/actions/cicd.json     默认 Pipeline 定义
```

## 4. 复用基座（不重造）

| 模块 | 路径 | 复用方式 |
|------|------|----------|
| AgentLoop | core/agent-loop.ts | agent-step 调 runL1() |
| tianhuo-cicd-loop | orchestrator/tianhuo-cicd-loop.ts | quality-gate job 可选调 |
| EventStore | workflow/event-store.ts | Run/Step/Event 直接写入 |
| quality-gates | gates/quality-gates.ts | gate-step 调 7 个 gate |
| CronEngine | cron/engine.ts | daemon 模式复用 |
| MCP Server | mcp/server.ts | 第 3 个 MCP Server 照抄模式 |
| GoalManager | goal/goal-manager.ts | Pipeline 关联 goal |
| corrections-ledger | evolve/corrections-ledger.ts | gate 失败自动记录 |
| artifact-bundle | evidence/artifact-bundle.ts | 报告复用 |
| process-executor | sandbox/process-executor.ts | shell 执行参考 |
| runtime-env | config/runtime-env.ts | 环境变量 |
| logger | core/logger.ts | createLogger('ActionRunner') |

## 5. 约束

- 不新增 npm 依赖
- 不新建数据库表（EventStore 现有 Run/Step/Event 够用）
- 不改 AgentLoop / quality-gates / EventStore
- Pipeline 定义用 JSON（不引入 YAML parser）
- job 串行执行（本地单机）
- Windows 优先，兼容 Linux

## 6. CLI 用法

```bash
# 手动跑 Pipeline
awkn-action-runner run --pipeline cicd

# 安装 git hook
awkn-action-runner hook install --hook post-commit

# 常驻 daemon（cron + watch）
awkn-action-runner daemon

# 查看最近报告
awkn-action-runner report --last

# 列出可用 Pipeline
awkn-action-runner list
```

## 7. Pipeline 定义格式

`.awkn/actions/cicd.json`：

```json
{
  "name": "cicd",
  "trigger": { "manual": true, "gitHook": "post-commit", "branches": ["main"] },
  "jobs": {
    "fast-gates": {
      "steps": [
        { "name": "TypeCheck", "type": "gate", "gates": ["typecheck"] },
        { "name": "Lint", "type": "gate", "gates": ["lint"] }
      ]
    },
    "test": {
      "needs": ["fast-gates"],
      "steps": [
        { "name": "单元测试", "type": "gate", "gates": ["test"] },
        { "name": "失败分析", "type": "agent", "condition": "on-failure",
          "agent": { "name": "tianhuo", "prompt": "分析失败测试", "maxTurns": 5 } }
      ]
    }
  }
}
```

## 8. 与 awkn-cicd 技能 v3.0 的关系

- 技能 v3.0 的 7 阶段状态机 → 编码为 cicd.json 的 jobs
- 技能的"结果单"模板 → reporter.ts 自动生成
- 技能的"硬规则"（不用 GitHub Actions）→ 完全兼容
- 技能升级到 v3.1 时引用本 Runner

## 9. 防循环触发

git hook 脚本里设 `AWKN_ACTION_RUNNING=1`，
Runner 启动时检查此变量，已在运行则跳过。

## 10. 测试

- `test/action/loader.test.ts` — JSON 解析 + zod 校验
- `test/action/runner.test.ts` — 拓扑排序 + condition + EventStore 集成
- `test/action/reporter.test.ts` — Markdown 渲染
- `test/action/git-auto.test.ts` — getGitContext mock
