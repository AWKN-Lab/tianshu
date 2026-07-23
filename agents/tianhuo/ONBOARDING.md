# ONBOARDING.md - 天火 v6.0 快速启动

定位: 给旧入口和人工维护者看的轻量导航。运行时事实源是根 `agent.prompt`。

---

## 1. 默认启动

只读 P0，不全量扫目录。

| 层级 | 文件 | 读法 |
|------|------|------|
| P0 | `agent.prompt` | 全量 |
| P0 | `01-身份与行为/SOUL.md` | 身份/风格/核心真相 |
| P0 | `01-身份与行为/BOUNDARY.md` | 安全红线/确认矩阵 |
| P0 | `04-记忆与知识/MEMORY.md#P0-轻量入口` | 记忆入口和写回规则 |

`03-能力与工具/CAPABILITY.md`、`02-流程与规范/SOP.md`、`archive/AWKN-PROGRAMMER.md` 和 `archive/GSTACK.md` 都是按任务触发，不进入默认上下文。

---

## 2. 固定链路

```
Classify -> Fetch -> Plan -> Execute -> Review/Verify -> Evolve
```

纯查询可绕过；改文件、跑命令、产出持久交付物、安全/数据/密钥/发布相关任务必须走治理链。

---

## 3. 本命技能本地路由

本地索引:
- `archive/AWKN-PROGRAMMER.md`
- `archive/GSTACK.md`
- `task_plan.md` / `findings.md` / `progress.md`

| 场景 | 读取 |
|------|------|
| 任务判断/输入契约 | `archive/AWKN-PROGRAMMER.md#本地路由表` |
| 技术实现/任务拆解 | `archive/AWKN-PROGRAMMER.md#AWKN 执行内核` |
| 测试质量/安全审查/复盘进化 | `archive/AWKN-PROGRAMMER.md#本地路由表` |
| QA/评审/发布/性能/canary | `archive/GSTACK.md#高价值能力路由` |
| 长任务恢复 | `task_plan.md` + `findings.md` + `progress.md` |

天火运行时只依赖本文件夹内的本地索引。外部技能目录只作溯源，不作为启动或恢复前置条件。

---

## 4. 健康规则

- 配置文件只保留 `${ENV_VAR}` 占位，不保存真实密钥。
- 生产、密钥、数据、发布、不可逆操作必须打 `Risk` 并过 `safetyGate`。
- 没有 fresh evidence，不宣称完成。
- 审查发现必须走 `finding -> fix -> fresh evidence -> close`。
- 每轮结束必须给出 `evolutionWritebackPacket`: `writeback` 或 `none + reason`。
- 多入口混用时先运行 `node scripts/check-runtime-contract.js`，以报告为准修正 P0、flow、gate 漂移。
- Claude Code 调用天火时使用 `claude --agent tianhuo --add-dir "C:\Users\10919\.workbuddy\agents\tianhuo"`，并用 `node scripts/check-claude-code-interface.js` 检查 adapter。
- 核心规则升级后运行 `node scripts/replay-trajectories.js` 和 `node scripts/agent-scorecard.js`，防止历史失败回归。

---

## 5. 文件职责

| 文件 | 职责 |
|------|------|
| `agent.prompt` | 启动器、packet/gate/card、本地路由 |
| `SOUL.md` | 身份、使命、沟通风格 |
| `BOUNDARY.md` | 安全红线、确认矩阵、回滚条件 |
| `SOP.md` | 本地轻量流程、AWKN/gstack 适配 |
| `CAPABILITY.md` | 能力触发、允许/禁止、验证方式 |
| `MEMORY.md` | P0 记忆入口、索引、写回规则 |
| `schemas/` | packet、轨迹、协作请求、评分报告结构契约 |
| `fixtures/task-trajectories/` | 失败回放和回归用例 |
| `scripts/check-runtime-contract.js` | 多入口一致性检查 |
| `scripts/check-claude-code-interface.js` | Claude Code agent/command 接口检查 |

版本: v6.0
