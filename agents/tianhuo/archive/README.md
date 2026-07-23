# archive/README.md - 天火冷资料索引

版本: v6.0
定位: 历史报告、训练材料、旧任务产物的冷入口。默认启动不读取。

---

## 归档原则

- 不搬动历史大文件，先建立索引，避免破坏旧路径。
- 不把 `reports/`、`logs/`、`training/`、`memory/`、`docs/` 接回 P0。
- 需要复盘时按任务读取具体文件，并在 `fetchPacket.sourcesChecked` 里记录。
- 可复用经验沉淀到 `04-记忆与知识/EXPERIENCE/`，不要把长报告塞进 `MEMORY.md`。

---

## 冷资料区

| 路径 | 内容 | 默认读取 |
|------|------|----------|
| `reports/` | 历史任务报告、测试报告、旧配置记录 | 否 |
| `logs/` | 运行日志、失败记录 | 否 |
| `training/` | 训练材料和认证任务 | 否 |
| `memory/` | 旧日记忆日志 | 否 |
| `docs/` | 外部或旧项目文档 | 否 |
| `output/` | 旧输出产物 | 否 |
| `archive/ENTROCAMP.md` | 意图理解与反馈吸收索引 | 否 |
| `archive/AWKN-PROGRAMMER.md` | AWKN 本命技能本地索引 | 否 |
| `archive/PLAN-SKILL.md` | 文件化计划与恢复索引 | 否 |
| `archive/AGENT-OPS.md` | 自主决策与进化能力索引 | 否 |
| `archive/GSTACK.md` | gstack 工程流水线增强索引 | 否 |
| `archive/LOCAL-DEPENDENCY-AUDIT.md` | 外部依赖本地化审计 | 否 |
| `task_plan.md` / `findings.md` / `progress.md` | deep/recovery 本地工作记忆 | 否 |

---

## 检索流程

1. 先判断当前任务是否真的需要历史资料。
2. 只读与当前意图直接相关的文件。
3. 命中可复用经验时，写入 `EXPERIENCE/derived` 或 `EXPERIENCE/fixes`。
4. 命中系统性治理失败时，写入 `EXPERIENCE/scars`。
5. 需要深度/恢复模式时，优先读 `modes/README.md` 再读对应模式文件。
6. 活跃运行文件不得要求读取外部技能目录；需要外部来源时先本地化成 archive 索引。
