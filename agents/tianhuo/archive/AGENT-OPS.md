# archive/AGENT-OPS.md - agent-ops 技能冷索引

来源路径: `C:\Users\10919\.workbuddy\skills\agent-ops`，仅作溯源，不作为运行依赖。
定位: 智能体运营、能力进化、自主决策的本地规则索引。默认启动不读取，不整包加载。

---

## 可吸收能力

| 子能力 | 原始路径线索 | 天火用途 |
|--------|------|----------|
| 自主决策 | `references/source-skills/autonomous-decision/SKILL.md` | 置信度判断，接入 `clarityGate` |
| 自我改进 | `references/source-skills/self-improving-agent/SKILL.md` | `.learnings -> EXPERIENCE` 升级链 |
| 能力进化 | `references/source-skills/capability-evolver/SKILL.md` | 只吸收候选、事件、能力沉淀协议 |
| 角色画像 | `references/source-skills/agent-mbti/`、`boss-skills/` | 低优先级，用于人格/协作偏好校准 |
| 团队运营 | `team-ops/`、`command-center/` | 冷资料，不进入天火 P0 |

---

## 自主决策规则

| 置信度 | 风险 | 动作 |
|--------|------|------|
| `>=80%` | 低 | 自主执行，记录理由 |
| `50-79%` | 低/中 | 记录假设后谨慎执行；必要时确认 |
| `<50%` | 任意 | 打 `Clarify`，不抢跑 |
| 任意 | 高 | 打 `Risk`，过 `safetyGate` |

输出到 `cardPlanPacket.reason`，不要只在脑内判断。

---

## `.learnings` 到 EXPERIENCE

| 事件 | 写入 |
|------|------|
| 用户纠正一次 | `EXPERIENCE/examples/` 或 `EXPERIENCE/learnings/` |
| 命令/操作失败 | `EXPERIENCE/learnings/` 的 error 记录 |
| 用户提出新能力 | `EXPERIENCE/learnings/` 的 feature_request 记录 |
| 同类纠正 2 次 | `derived/` 或 `fixes/` 候选 |
| 系统性治理失败 | `scars/` |

---

## 禁用内容

- 不运行 `capability-evolver` 的自动自修改、loop、Mad Dog Mode。
- 不接入 EvoMap/A2A 外部发布、节点注册或 hub 发布。
- 不把 team orchestration 写入 P0，天火仍是 CTO/技术执行者，不越权调度。
- 不读取 `references/source-skills/*/node_modules/`。
- `references/source-skills/agent-orchestration/SKILL.md` 已发现 NUL 损坏，标记为不可用来源。

---

## 按需读取顺序

1. 先读本索引。
2. 优先使用本索引内规则，不要求访问外部 agent-ops 目录。
3. 对脚本和外部网络能力只做设计参考，不默认执行。
4. 如需重新抽取来源资料，先写入 `findings.md`，再沉淀到 `EXPERIENCE` 或 `CAPABILITY.md`。
