# awkn-engine runtime

> awkn引擎 自带轻量 Node.js 运行时 — Loop Engineering L1-L4
> 不依赖 awkn-agent，独立运行

## 快速开始

```bash
cd runtime
npm install
npm run typecheck   # 验证编译
npm run dev -- skill list   # 列出技能
npm run dev -- goal create --title "测试目标" --desc "验证 runtime" --hao "tsc 0 错误,vitest 0 failed"
npm run dev -- loop l1 "hello, 你好"
```

## 架构

```
runtime/
├── package.json              独立包
├── tsconfig.json
├── src/
│   ├── core/                 核心运行时
│   │   ├── react-loop.ts     ReAct 状态机（从 awkn-agent 抽取，零依赖）
│   │   ├── agent-loop.ts     L1/L2 循环编排（重新实现）
│   │   ├── hook-manager.ts   hook 调度（从 awkn-agent 抽取）
│   │   ├── hook-types.ts     hook 类型
│   │   ├── loop-monitor.ts   3-strike/重复模式检测
│   │   └── logger.ts         简易 logger
│   ├── goal/                 L2 Goal-based
│   │   ├── goal-state.ts     goal 状态机（从 awkn-agent 抽取）
│   │   └── goal-manager.ts   goal CRUD + SQLite 持久化
│   ├── cron/                 L3 Time-based
│   │   └── engine.ts         cron 调度（从 awkn-agent 抽取，保留 SQLite）
│   ├── skills/               技能加载
│   │   ├── types.ts
│   │   ├── parser.ts         SKILL.md 解析
│   │   ├── trigger-matcher.ts
│   │   └── manager.ts
│   ├── tools/                工具系统
│   │   ├── types.ts
│   │   ├── registry.ts
│   │   └── builtin/          read/write/exec 内置工具
│   ├── llm/                  LLM 适配层
│   │   ├── types.ts
│   │   ├── router.ts         provider 路由 + fallback
│   │   └── providers/
│   │       ├── trae.ts       TRAE 自带
│   │       ├── codex.ts      CODEX（OpenAI 兼容）
│   │       └── minimax.ts    MiniMax（M2.5/M2.1）
│   ├── gates/                7 个质量门禁
│   │   └── quality-gates.ts
│   ├── store/                SQLite 持久化
│   │   ├── schema.ts         4 张表（goals/cron_jobs/loop_state/usage）
│   │   └── db.ts             better-sqlite3 封装
│   └── cli.ts                CLI 入口（goal/loop/hook/skill/cron）
├── bin/
│   └── awkn-engine.js        可执行入口
└── data/                     运行时数据（gitignored）
    └── awkn-engine.db        SQLite 文件
```

## 4 张表

| 表 | 用途 |
|---|------|
| goals | L2 目标持久化（含 hao 验收条件 + budget + history） |
| cron_jobs + cron_run_log | L3 定时任务 + 执行日志 |
| loop_state | 循环状态快照（断点恢复） |
| usage | token 用量（budgetGate 用） |

## LLM Provider

| Provider | 协议 | 默认模型 | 用途 |
|----------|------|---------|------|
| trae | IDE/MCP | tre-default | 默认，runtime 在 TRAE 内运行时由宿主代理 |
| codex | OpenAI 兼容 | gpt-4o | 备用 / 跨模型 review |
| minimax | OpenAI 兼容 | MiniMax-M2.5 | text/speech/video/music |

路由顺序：显式指定 → 按任务类型 → 默认 trae。带 fallback 链。

## 7 个质量门禁

| Gate | 实现 | 用途 |
|------|------|------|
| typecheckGate | tsc --noEmit | L2 停止条件 |
| testGate | vitest run | L2 停止条件 |
| lintGate | eslint . | L2 停止条件 |
| reviewGate | 调 awkn-审核 技能 | L2 停止条件 |
| securityGate | 调 awkn-审核 技能 | 立即中断 |
| verificationGate | 纯逻辑 | 不得无证据宣称完成 |
| budgetGate | 纯逻辑 | 超预算停循环 |

## 测试

```bash
npm run test              # 单元测试（node:test，经 run-tests.mjs 净化 env + 隔离 DB）
npm run test:contracts    # 契约测试（同上）
npm run test:verify       # 独立验证脚本（自给自足）
npm run check             # 全量门禁（架构 + tsc + lint + 全测试）
```

- `npm run test` / `test:contracts` 经 `scripts/run-tests.mjs` 运行：会剔除宿主 `AWKN_*` 环境变量（如 `.env` 中的 `AWKN_APPROVED_TOOLS`、`AWKN_LLM_PROVIDER`），并注入临时 `AWKN_DB_PATH` 隔离 EventStore，保证断言不受宿主配置污染。
- `npm run test:coverage` **不经净化、无 DB 隔离**：须在干净 env 下运行（避免 `.env` 泄漏进断言），且会写生产 `data/awkn-engine.db`。

## 独立性

本 runtime **不依赖 awkn-agent**。即使 `D:\awkn-lab\awkn-agent` 目录被删，runtime 仍能独立工作。

从 awkn-agent 抽取的模块：
- react-loop.ts（零依赖，直接复用）
- hook-types.ts / hook-manager.ts（换 logger）
- loop-monitor.ts（换 logger）
- goal-state.ts / goal-manager.ts（加 SQLite 持久化）
- skills/types.ts / parser.ts / trigger-matcher.ts（内联 SkillDependency）
- cron/engine.ts（db 调用换成本地 store/db.ts）

重新实现：
- agent-loop.ts（L1/L2 编排）
- llm/*（TRAE/CODEX/MiniMax 三 provider）
- gates/*（7 个质量门禁）
- tools/*（简化版 ToolRegistry + 内置工具）
- store/*（SQLite schema + 封装）
