# Experience Evolution Loop

## 目标

把“记录经验”和“激活行为”拆开，形成可验证、可审批、可回滚的闭环。

```text
任务证据 → 复盘/检测 → 经验 DRAFT → 回放验证 → 人工批准 → ACTIVE 投影
                                           ↘ 回归隔离 / 退役 / 回滚
```

## 职责

| 组件 | 负责 | 不负责 |
|---|---|---|
| AWKN 复盘总结 | 事实、根因、候选包 | 直接改规则 |
| awkn-知识库 | raw、Wiki、索引、引用 | 激活行为 |
| awkn-技能治理 | 验证、审批、激活、隔离、回滚 | 伪造验证结果 |
| Runtime Evolve | 状态、回放指标、激活历史 | 替代人工审批 |

## 分层与迁徙

| 内容 | 目标层 | 晋级条件 |
|---|---|---|
| 原始事实、完整复盘 | raw / EXPERIENCE | 可追溯 |
| 编译知识、案例、方法 | Wiki | KNOWLEDGE_ONLY，已核对来源，不进入 Evolve |
| 运行时上下文摘要 | MEMORY.md | ACTIVE CONTEXT_RULE |
| 工具路由与环境限制 | TOOLS.md | ACTIVE TOOL_ROUTE |
| 可重复执行流程 | Skill | ACTIVE SKILL + 测试 |
| 项目强制规则 | 项目 AGENTS.md | ACTIVE PROJECT_RULE |
| 工作区治理规则 | 工作区 AGENTS.md | ACTIVE POLICY |
| Prompt、模型路由、门禁、交付规则 | Runtime 对应配置 | ACTIVE PROMPT / MODEL_ROUTE / GATE / DELIVERY_RULE |

## 不变量

1. 不从复盘直接双写多个目标。
2. DRAFT、VALIDATING、APPROVED 均不得作为生效指令加载。
3. POLICY、PROJECT_RULE、SKILL 需要回放指标和人类批准。
4. correction 仅在 ACTIVE 后 resolved；隔离时相关运行时记忆失效。
5. 投影保留 candidate ID、版本、证据和失效条件。
6. 旧 ACTIVE 被新版本替代后进入 RETIRED；回归可 rollback。
7. 不新增候选类型；行为候选严格复用 Runtime Evolve schema，纯知识标记为 KNOWLEDGE_ONLY。

## AGENTS 历史经验迁徙

E1–E26 已于 2026-08-02 从 `D:\awkn-lab\AGENTS.md` 迁出：

- 原文归档：`agents/tianhuo/04-记忆与知识/EXPERIENCE/raw/2026-08-02-file-AGENTS-legacy-E1-E26.md`
- 迁徙清单：`agents/tianhuo/04-记忆与知识/EXPERIENCE/legacy-agents-e1-e26-migration.md`
- 候选文件：`EXP-LEGACY-20260802-E01` 至 `EXP-LEGACY-20260802-E26`
- Runtime 状态：26 条均为 `DRAFT`，版本 1；没有候选被自动激活。

`AGENTS.md` 不再保存经验正文，只保留稳定规则和生命周期入口。后续逐条执行：补齐证据 → 回放 → 验证 → 激活 → 单一目标投影；未 ACTIVE 前不得重新写回行为层。

## 验收

- 捕获经验后：存在 DRAFT，corrections 仍 open。
- 验证失败：候选 QUARANTINED，目标文件无变化。
- 激活成功：目标层完成单一投影，corrections resolved。
- 回归：当前版本隔离，上一 ACTIVE 可恢复。
