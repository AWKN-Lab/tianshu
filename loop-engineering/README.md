# Loop Engineering 系统总览

> 版本：v1.0 ｜ 日期：2026-07-09 ｜ 状态：设计稿

## 结论先行

Loop Engineering 是 awkn引擎 的下一代执行内核。它用四层 Loop 模型替换线性 Agent 调用，让 Agent 在"循环 + 验证"中收敛到目标，而不是一次性猜答案。

本系统自带 Node.js 轻量运行时，**不依赖 awkn-agent**，可独立嵌入任何工程链路。

---

## 一、四层 Loop 模型

四层模型从低到高，逐层把"决策权"从用户交给系统。

| 层级 | 名称 | 交出的东西 | 触发方式 | 停止判定 | 主用工具 | 适用场景 |
|------|------|-----------|---------|---------|---------|---------|
| L1 | Turn-based | 验证步骤 | 用户手动 | 用户判断 | Skill | 单步验证、调研、文档生成 |
| L2 | Goal-based | 停止条件 | 用户手动 | 确定性评估器 | /goal | 修 bug、补测试、跑通构建 |
| L3 | Time-based | 触发时机 | 时间驱动 | 评估器或时长 | /loop /schedule | 巡检、监控、定时同步 |
| L4 | Proactive | 整个决策流程 | 组合驱动 | 工作流自决 | 全部 + 动态工作流 | 长任务自治、多 agent 协作 |

**升级路径**：先 L1 验证可行性，再 L2 跑通闭环，需要时上 L3 定时，成熟后试 L4 自治。**禁止跳级**。

---

## 二、七条铁律

| # | 铁律 | 落地点 |
|---|------|-------|
| 1 | 确定性优先 | 停止条件用测试通过数/分数/lint 计数，不用"看起来对了"这类描述性判断 |
| 2 | 循环里必须有"说不"的 | 每个 Loop 至少一个 gate：测试失败 / 类型报错 / 第二 agent review 拒绝 |
| 3 | hook 短平快 | hook 同步阻塞，<200ms，重活下放 Skill 异步执行 |
| 4 | Skill 沉淀"好"的标准 | "好"的定义写进 Skill，不靠 Agent 临场发挥 |
| 5 | token 是硬约束 | 每轮有预算，超限走 3-strike 协议，不靠模型自觉 |
| 6 | 先 L2 再 L4 | L4 必须建立在 L2 闭环跑通之上，禁止跳级 |
| 7 | 代码库要干净 | 每轮结束跑 lint/format，脏代码视为 gate 不通过 |

---

## 三、与 awkn-agent 的关系

| 项目 | awkn-agent | Loop Engineering |
|------|-----------|-----------------|
| 定位 | 通用 Agent 容器 | 工程专用执行内核 |
| 运行时 | Python 为主 | Node.js 轻量运行时 |
| 依赖关系 | — | **不依赖 awkn-agent** |
| 调用方式 | MCP / HTTP | 进程内函数 + 子进程 |
| 复用资产 | — | 复用 agents/tianhuo 配置、skills/ 插件、awkn-* 技能 |

**明确声明**：

- Loop Engineering 运行时是独立 Node.js 进程，零 awkn-agent 依赖
- 复用 awkn 生态的**配置和技能定义**，但不复用 awkn-agent 的**运行时**
- agents/tianhuo 配置作为 L4 调度的 agent 模板
- skills/ 目录作为 Skill 仓库，通过文件路径加载

---

## 四、目录结构

```
awkn引擎/loop-engineering/
├── README.md                    # 本文档，总览
├── loop-commands.md             # /goal /loop /schedule /hook /skill 命令清单
├── skill-registry-loop.md       # 12 个核心 Loop 技能接入清单
├── quality-gates.md             # 7 个质量门禁定义
└── token-strategy.md            # token 控制策略
```

后续 Node.js 运行时目录（本次不创建）：

```
loop-engineering/runtime/        # Node.js 运行时（后续建设）
├── commands/                    # 5 个命令实现
├── gates/                       # 7 个门禁实现
├── scheduler/                   # L3 时间调度
└── orchestrator/                # L4 工作流编排
```

---

## 五、快速开始

### 步骤 1：选定 Loop 层级

按"先 L2 再 L4"铁律，新任务默认从 L2 起步：

| 任务类型 | 推荐起步层级 |
|---------|------------|
| 单次调研 / 单步验证 | L1 |
| 修 bug / 补测试 / 跑通构建 | L2 |
| 定时巡检 / 监控同步 | L3 |
| 多 agent 自治长任务 | L4（需 L2 已跑通） |

### 步骤 2：写意图，不写步骤

L2 入口是 `/goal`，**只写意图，不写步骤**。示例模板见 `loop-commands.md`。

### 步骤 3：选定停止条件

L2 默认 4 项标准集（详见 `quality-gates.md`）：

| 检查项 | 默认值 |
|-------|-------|
| 类型检查 | 0 错误 |
| 测试 | 0 failed |
| lint | 0 新增 |
| 审核 | PASS |

### 步骤 4：跑 Loop

```
/goal <意图>
/loop --max-rounds 20 --budget 200k
```

运行时每轮：调度 Skill → 跑门禁 → 不通过则反馈给 Agent → 下一轮。

### 步骤 5：盯用量

每轮看 token 消耗，超预算走 3-strike 协议。详见 `token-strategy.md`。

---

## 六、文档导航

| 文档 | 解决什么问题 |
|------|------------|
| README.md（本文档） | 系统全貌、四层模型、铁律、快速开始 |
| loop-commands.md | 5 个命令怎么用、参数怎么传、示例 |
| skill-registry-loop.md | 12 个技能怎么接、调度规则、强制链 |
| quality-gates.md | 7 个门禁定义、L2 标准集、组合规则 |
| token-strategy.md | 6 条省钱策略、预算建议、3-strike 协议 |

---

## 七、术语表

| 术语 | 含义 |
|------|------|
| Loop | 循环执行单元，有明确停止条件 |
| Turn | 单轮执行，一个 Loop 由多个 Turn 组成 |
| Gate | 质量门禁，决定 Turn 是否通过 |
| Skill | 可复用的能力单元，沉淀"好"的标准 |
| Hook | 短平快的同步钩子，<200ms |
| 评估器 | L2 停止判定的确定性函数 |
| 强制链 | 已有项目修改必须走的技能序列 |
