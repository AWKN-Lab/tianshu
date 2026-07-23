# 天火 Prompt 分层注入架构

> 版本：v1.0
> 来源：Alice 工程方法论"分层注入"原则
> 用途：System Prompt 从全量读取改为分层注入，KV Cache 友好

---

## 一、四层架构

| 层 | 名称 | 核心内容 | 变化频率 | KV Cache |
|----|------|---------|---------|---------|
| L1 | 核心身份区 | SOUL.md 核心真相 + BOUNDARY.md 安全红线 | 极低（几乎不变） | ✅ 友好 |
| L2 | 能力边界层 | 当前可用工具集 + Skill 列表 | 低（Skill 增减时变化） | ✅ 友好 |
| L3 | 上下文注入层 | MEMORY.md P0 段 + 激活的 Skill 入口 | 中（每会话开始时构建） | ⚠️ 有限 |
| L4 | 动态追加层 | 当前日期、拒绝记录、错误履历 | 高（每轮迭代更新） | ❌ 不友好 |

---

## 二、各层详细内容

### L1 核心身份区（启动时一次性注入）

来源：`01-身份与行为/SOUL.md` + `01-身份与行为/BOUNDARY.md`

核心内容（仅提取核心锚点，详见源文件）：
- 身份：技术执行者，不越权调度
- 沟通：极简，结论先行
- 安全红线：生产/密钥/数据高风险操作立即熔断

### L2 能力边界层（按 Skill 激活加载）

来源：`03-能力与工具/CAPABILITY.md` + `archive/SKILL-REGISTRY.md`

当前能力集：
- 内建：文件搜索、意图对齐、Card 出牌
- Skill：awkn-执行检查 / awkn-工程师 / awkn-审核 / awkn-部署 / awkn-工程文档 / AWKN复盘总结

### L3 上下文注入层（每会话开始时构建）

来源：`04-记忆与知识/MEMORY.md` P0 段 + 激活的 Skill SKILL.md 入口锚点

构建时机：
- 会话开始时：加载 MEMORY.md P0 段
- Skill 激活时：加载对应 SKILL.md 入口锚点
- 不激活时：不加载 Skill 正文

### L4 动态追加层（每轮迭代更新）

当前日期、当前会话拒绝记录、当前会话错误履历。

---

## 三、与 agent.prompt §0 的对应关系

| agent.prompt §0 层级 | Alice 四层 | 文件 |
|---------------------|-----------|------|
| P0（agent.prompt 自身） | L1（部分） | agent.prompt |
| P0（SOUL.md + BOUNDARY.md） | L1 | SOUL.md / BOUNDARY.md |
| P0（MEMORY.md P0 段） | L3 | MEMORY.md |
| P1（CAPABILITY.md） | L2 | CAPABILITY.md |
| P1（SOP.md） | L2 | SOP.md |
| P2（AWKN-PROGRAMMER.md） | L2 | AWKN-PROGRAMMER.md |
| P2（工作记忆） | L4 | task_plan.md 等 |
| archive/ STATE-MAP | 新增 | STATE-MAP.md |

---

## 四、注入优化收益

| 指标 | 全量加载 | 分层注入 | 改善 |
|------|---------|---------|------|
| L1 稳定部分命中 KV Cache | ❌ | ✅ | 每次请求节省 L1 重注入成本 |
| Skill 按需加载 | 部分 | ✅ | 纯查询场景不加载任何 Skill |
| 动态层最小化 | ❌ | ✅ | L4 仅包含当前轮次的动态数据 |
| 压缩友好 | ❌ | ✅ | L4 可独立压缩/丢弃 |

---

## 五、不适用场景

天火当前运行在 IDE 框架中，Prompt 分层的完整实现（L1 的 KV Cache 优化）需要 IDE 框架支持。文档化本架构为未来优化留出空间。
