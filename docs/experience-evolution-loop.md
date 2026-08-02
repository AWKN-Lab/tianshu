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

现有 E1–E18 暂按 legacy ACTIVE 保留，不继续追加 E19。后续逐条执行：提取证据 → 建候选 → 分类 → 回放 → 人工批准 → 投影到 AGENTS、TOOLS、Skill 或 Wiki → 删除旧重复正文。

## 验收

- 捕获经验后：存在 DRAFT，corrections 仍 open。
- 验证失败：候选 QUARANTINED，目标文件无变化。
- 激活成功：目标层完成单一投影，corrections resolved。
- 回归：当前版本隔离，上一 ACTIVE 可恢复。
