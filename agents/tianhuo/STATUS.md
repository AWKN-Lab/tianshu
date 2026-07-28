# STATUS.md - 天火状态

版本: v6.2
状态: 人格化升级完成 + 技能接入架构就绪 + SkillDeck 桥接接入
角色: CTO / 技术执行者 + 人格化协作能力
最后更新: 2026-07-28

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
| SkillDeck 桥接 | 仓库外独立 Web 控制台（D:\awkn-lab\TRAE练习\skilldeck，端口 4177），通过 AWKN_SKILLS_ROOT 指向本仓库 skills/，仅读 registry.json，不进 runtime |

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

---

## SkillDeck 桥接影响范围

**位置**：`D:\awkn-lab\TRAE练习\skilldeck`（仓库外独立项目，不属于 awkn引擎 runtime）

**与 awkn引擎 的关系**：

- 通过环境变量 `AWKN_SKILLS_ROOT` 指向 `d:\awkn-lab\awkn引擎\skills\`，读取本地 Skill 卡片墙
- 通过 `/api/experts/registry` 接口读取 `skills/awkn-技能治理/registry.json` 的 `experts[]` 字段（只读）
- 专家数据写入由 `skills/awkn-技能治理/skill-cli.py expert` 命令完成，避免双写冲突

**架构边界**：

- SkillDeck 是独立 Node.js 零依赖 Web 服务（默认端口 4177），不引入 MCP SDK 到 runtime
- SkillDeck 故障不影响 awkn引擎 runtime、天火调度和 Skill 触发
- SkillDeck 不修改 registry.json，仅展示；专家写入必须经 skill-cli.py
- 桥接技术文档：`skills/.system/skilldeck-bridge/SKILL.md`

**SkillDeck 双形态**：

1. 独立 Web 控制台（server.js + public/，端口 4177）
2. Codex MCP 插件（mcp/server.mjs，依赖 @modelcontextprotocol/sdk，仅用于 Codex 集成）

**天火调度影响**：

- 天火不直接调用 SkillDeck，但用户可通过 SkillDeck 生成的「调用口令」粘贴到对话中触发 Skill
- SkillDeck 提供的「专家打包」会写入 registry.json experts[]，被 skill-cli.py 治理，不影响天火 P0/P1 文件
