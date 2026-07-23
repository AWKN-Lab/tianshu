# 天火状态图

> 版本：v1.0
> 来源：Alice 工程方法论"状态优先"原则
> 用途：显式化天火核心流程中每个状态的住处、读写者、读写时机

---

## 一、6 个 Packet 状态

| Packet | 创建者 | 消费者 | 住处 | 失效条件 |
|--------|--------|--------|------|---------|
| taskClassificationPacket | Classify 阶段 | Plan/Execute 阶段 | 内存（对话内） | 对话结束 |
| intentPacket | Classify 阶段（意图模糊时） | Plan 阶段 | 内存（对话内） | 对话结束 |
| fetchPacket | Fetch 阶段 | Plan 阶段 | 内存（对话内） | 对话结束 |
| cardPlanPacket | Plan 阶段 | Execute 阶段 | 内存（对话内） | 对话结束 |
| reviewVerificationPacket | Review/Verify 阶段 | Evolve 阶段 | 内存（对话内） | 对话结束 |
| evolutionWritebackPacket | Evolve 阶段 | MEMORY.md / archive/ | 内存 → 文件 | 写入后失效 |

**读写规则**：
- 每个 Packet 由对应阶段创建，下游阶段只读
- evolutionWritebackPacket 是唯一持久化的 Packet，写入 MEMORY.md 或 archive/
- bypass 时（纯查询/L1），除 evolutionWritebackPacket 外均不生成

---

## 二、5 个 Gate 状态

| Gate | 触发时机 | 通过时副作用 | 不通过时副作用 |
|------|---------|------------|--------------|
| clarityGate | Classify → Plan 之间 | 进入 Plan 阶段 | 最多问 2 轮；仍模糊则记录保守假设 |
| planningGate | Plan → Execute 之间 | 进入 Execute 阶段 | 不进入执行，回到 Plan |
| safetyGate | Execute 前 + 每个高风险动作前 | 继续执行 | 立即中断，说明影响和回滚，等确认 |
| verificationGate | Execute → Evolve 之间 | 进入 Evolve 阶段 | 不得宣称完成，回到 Execute/Fix |
| evolutionGate | Evolve 阶段结束前 | 允许结束 | 不得静默结束 |

**读写规则**：
- Gate 是无状态判断，不持久化
- safetyGate 拦截记录写入 evolutionWritebackPacket
- 互斥守卫：Gate 触发的操作不能再次触发同一 Gate（见 agent.prompt §4 互斥守卫）

---

## 三、记忆层级 L0-L3 状态

| 层级 | 住处 | 读写频率 | 生命周期 | 主要写入者 | 主要读取者 |
|------|------|---------|---------|-----------|-----------|
| Intent | MEMORY.md Intent 层 | 极低频写，每次启动读 | 永久 | 用户/大宗师指令 | 天火每次启动 |
| L0 | memory/YYYY-MM-DD.md | 每任务写，每天读 | 对话结束清理 | 天火 Evolve 阶段 | 天火启动时 |
| L1 | MEMORY.md L1 层 | 低频写，按需读 | 7 天不活跃降级 | 天火 Evolve 阶段 | 任务涉及时 |
| L2 | MEMORY.md L2 层 | 中频写，按需读 | 长期 | 天火 Evolve 阶段 | 任务涉及时 |
| L3 | MEMORY.md L3 层 | 极低频写，按需读 | 永久 | 人工确认后写入 | 任务涉及时 |
| Meta | MEMORY.md Meta 层 | 中频写，低频读 | 观察期 14 天 | 天火自动写入 | 升级判断时 |

**写入时序约束**（Alice 守门员原则）：
- 对话进行中禁止写入记忆库（防止信息自我强化）
- 写入前必须经过守门员判断（见 agent.prompt §8）
- 记忆条目超过 50 条时切换为摘要模式

---

## 四、SKILL-REGISTRY 路由状态

| 状态 | 触发条件 | 后续路径 |
|------|---------|---------|
| 命中 | taskClassificationPacket.route_to_skill 非空 | 读取对应 SKILL.md → 按技能流程执行 |
| 未命中 | route_to_skill 为空 | fallback：天火原有自主执行逻辑 |
| 软接入失败 | SKILL.md 读取失败或无法按流程执行 | 降级为硬编码模式：核心流程写进 agent.prompt |
| 否定命中 | 触发词匹配但"不适用于"列命中 | 不路由，继续天火自主执行 |

**读写规则**：
- SKILL-REGISTRY.md 由 Classify 阶段读取
- 路由结果写入 taskClassificationPacket.route_to_skill
- 技能包 SKILL.md 由 Execute 阶段按需读取

---

## 五、运行时契约状态

| 契约 | 住处 | 触发检查时机 | 失败时 |
|------|------|------------|--------|
| Packet schema | schemas/packets.schema.json | Phase 1 schema 更新后 | 校验不通过，修复后再推进 |
| 入口一致性 | scripts/check-runtime-contract.js | 核心文档/配置/入口变化后 | 报错，修复后再推进 |
| 失败回放 | scripts/replay-trajectories.js | 冷路径，不进 P0 | — |
| 能力评分 | scripts/agent-scorecard.js | 冷路径，不进 P0 | — |

---

*本文件是状态图的唯一权威来源。状态变更时同步更新本文件。*
