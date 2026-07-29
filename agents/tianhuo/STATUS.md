# STATUS.md - 天火状态

版本: v6.2
状态: R2 Trusted Decision Core 已发布 (v0.1.0), CI 全绿
角色: CTO / 技术执行者 + 人格化协作能力
最后更新: 2026-07-29

---

## 核心状态

| 项 | 状态 |
|----|------|
| 默认启动 | P0-only，目标 <= 6K tokens |
| 执行链路 | `Classify -> Fetch -> Plan -> Execute -> Review/Verify -> Evolve` |
| Packets | 6 个轻量 packet 已进入 `agent.prompt`（示例精简为索引引用） |
| Gates | 5 个 gate 已进入 `agent.prompt`/`BOUNDARY.md` |
| Cards | 10 张节奏牌已进入 `agent.prompt`/`SOP.md`（含状态触发条件） |
| 人格化 | 沟通温度锚点 5 条、用户状态信号识别已写入 SOUL.md/BOUNDARY.md |
| 技能路由 | SKILL-REGISTRY.md 已建立，Execute 阶段支持软接入 awkn-* 技能包 |
| 智能体资产吸收 | master/EVOLUTION.md 能力进化模式已翻译写入 MEMORY.md |
| AWKN | `archive/AWKN-PROGRAMMER.md` 本地索引，不依赖外部目录 |
| gstack | `archive/GSTACK.md` 本地增强索引，不运行外部脚本 |
| Deep/Review/Recovery | `modes/` 按需加载 |
| 文件化计划 | 根目录 `task_plan.md` / `findings.md` / `progress.md` + `archive/PLAN-SKILL.md` |
| 智能体运营进化 | `archive/AGENT-OPS.md` 本地冷路由 |
| 依赖本地化 | `archive/LOCAL-DEPENDENCY-AUDIT.md` |
| 运行时契约 | `schemas/` 保留，旧验证脚本已清理 |
| Claude Code 接口 | `~/.claude/agents/tianhuo.md` + `~/.claude/commands/tianhuo.md` |
| Codex 接口 | `C:\Users\10919\.codex\skills\tianhuo\SKILL.md` 轻量桥接入口，按需读取本目录 P0/P1 文件，不复制主体目录 |
| 失败回放 | 待重建（旧脚本已清理） |
| 能力评分 | 待重建（旧脚本已清理） |
| 敏感配置 | 使用环境变量占位，已清理旧框架配置 |
| 健康检查 | 待重建（旧脚本已清理） |

---

## P0 文件

| 文件 | 职责 |
|------|------|
| `agent.prompt` | 启动器和治理内核 |
| `01-身份与行为/SOUL.md` | 身份与风格（含人格化温度锚点） |
| `01-身份与行为/BOUNDARY.md` | 安全、回滚和用户状态信号识别 |
| `04-记忆与知识/MEMORY.md#P0-轻量入口` | 记忆索引、意图路由、知识库检索、分层响应、错误边界、能力进化写回规则 |

## P1 文件（按需加载）

| 文件 | 职责 |
|------|------|
| `archive/SKILL-REGISTRY.md` | 技能注册表，路由 awkn-* 技能包 |
| `archive/TEAM.md` | 角色映射表，技术团队概念参考 |

---

## 健康待守护

- 不恢复旧版启动时全量加载。
- Codex 只通过 `.codex/skills/tianhuo` 做轻量桥接，不复制或软链接整个天火主体目录。
- 不把外部 AWKN/gstack/plan/agent-ops 正文塞进 P0。
- 活跃运行文件不得依赖外部技能目录；外部路径只能作 archive 溯源。
- 不把真实 `appSecret`、token、password 写入配置。
- 长经验沉淀到 `04-记忆与知识/EXPERIENCE/`，不要塞回 P0。
- 不运行 agent-ops 自动自修改/loop/A2A 外部发布能力。
- 不运行 gstack 自动升级、telemetry、自动 commit、cookie 导入、deploy/canary 能力，除非用户明确授权。
- 改动核心文档后做人工审查。
- 改动入口/配置/核心流程后做人工验证。
- 改动 gate/card/packet/协作边界后做端到端验证。
