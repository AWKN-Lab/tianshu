# archive/LOCAL-DEPENDENCY-AUDIT.md - 本地依赖审计

定位: 记录哪些外部资料已经本地化，哪些只保留溯源，哪些禁止复制进天火运行链。

---

## 必须本地化

| 依赖 | 本地文件 | 状态 |
|------|----------|------|
| 任务计划工作记忆 | `task_plan.md` | 已本地化 |
| 发现/研究记录 | `findings.md` | 已本地化 |
| 进度/恢复日志 | `progress.md` | 已本地化 |
| AWKN 本命技能路由 | `archive/AWKN-PROGRAMMER.md` | 已本地化 |
| plan 技能工作记忆规则 | `archive/PLAN-SKILL.md` | 已本地化 |
| agent-ops 自主进化规则 | `archive/AGENT-OPS.md` | 已本地化 |
| gstack 工程流水线增强 | `archive/GSTACK.md` | 已本地化 |
| EntroCamp 意图对齐 | `archive/ENTROCAMP.md` + `EXPERIENCE/derived/EXP-DRV-20260423-001.md` | 已本地化 |

---

## 仅溯源，不作为运行依赖

| 来源 | 原因 |
|------|------|
| `C:\Users\10919\.workbuddy\skills\awkn-programmer` | 原始功法库，天火运行只读本地 AWKN 索引 |
| `C:\Users\10919\.workbuddy\skills\plan` | 原始 plan 技能，天火运行只读本地三文件和本地协议 |
| `C:\Users\10919\.workbuddy\skills\agent-ops` | 原始能力矿，天火只吸收安全规则摘要 |
| `C:\Users\10919\.workbuddy\skills\gstack` | 原始工具箱，天火只吸收路由和风险边界 |
| `C:\Users\10919\Downloads\EntroCamp学习笔记` | 原始教材，天火只保留意图对齐经验 |
| `C:\Users\10919\Downloads\Meta_Kim-extracted` | 原始方法来源，天火只吸收轻量治理机制 |

---

## 禁止复制进运行链

| 内容 | 原因 |
|------|------|
| `node_modules/`、bin、dist、浏览器扩展 | 体积大、可执行、非治理上下文 |
| 自动升级、安装、telemetry、analytics 脚本 | 外部副作用和隐私风险 |
| 自动 commit/push/deploy/canary 脚本 | 会改变仓库或生产环境 |
| cookie 导入、真实浏览器会话材料 | 账号态和隐私风险 |
| 外部 agent 编排、ngrok、A2A 发布 | 越权调度和外部暴露风险 |
| NUL 损坏或二进制文件 | 不适合作为文本上下文 |

---

## 审计规则

- 活跃运行文件不得要求读取外部技能目录。
- archive 文件可以写来源路径，但必须标注“仅溯源，不作为运行依赖”。
- 新增外部资料前，先判断是否需要本地化为索引。
- 健康检查必须覆盖本地化文件存在性和活跃文件外部路径扫描。

