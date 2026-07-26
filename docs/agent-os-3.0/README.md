# 天枢 Agent OS 3.0 工程文档集

> 版本：v0.1 Draft  
> 日期：2026-07-26  
> 状态：架构与工程规划基线  
> 权威项目：`AWKN-Lab/tianshu`

## 一、定位

天枢是 AWKN 的核心 Agent 引擎，也是 AWKN Agent OS 总框架、运行时协议、治理规则和进化闭环的唯一权威实现位置。

本轮升级将现有 `Goal / Loop / Gate / Tool / Memory / Evidence / Evolve` 内核扩展为一条完整运行主链：

```text
用户输入
   │
   ▼
Trusted Input Gateway
   │
   ▼
Intent & Goal Router
   │
   ▼
Context Planner
   │
   ▼
Policy & Skill Compiler
   │
   ▼
Tool & Model Broker
   │
   ▼
Evidence-Gain Loop
   │
   ▼
Delivery Router
   │
   ▼
Evidence & Outcome
   │
   ▼
Memory Write Gate
   │
   ▼
Evolve
```

## 二、项目权威边界

### 2.1 天枢

天枢负责：

- 输入治理与身份边界；
- 意图分类、Goal 创建和 L0—L4 路由；
- 上下文规划和 Claim 使用决策；
- Policy、Skill 编译与版本冻结；
- 模型、工具、供应商与授权调度；
- Evidence-Gain Loop；
- 交付路由；
- Run、Step、Evidence、Outcome 与 Trace；
- 记忆写入判定；
- 规则和 Skill 的评测、晋级、隔离和回滚。

### 2.2 AWKN Memory OS

AWKN Memory OS 是独立记忆系统，也可以通过 `MemoryBackend` 协议挂载到天枢。

天枢保留：

- 工作记忆；
- 运行检查点；
- 故障降级缓存；
- Memory Backend Router；
- 上下文使用与写入门禁。

Memory OS负责：

- 长期 Claim、Experience、Rule、Context Ledger；
- 跨项目权限；
- 持久化事务；
- Immutable Render；
- Consumption、Citation、Outcome Attribution；
- 版本和删除依赖。

### 2.3 GUNDAM

GUNDAM 是 Codex 专属桌面 Agent 产品。它可以吸收天枢的治理协议、授权回执、模型路由透明度和任务恢复能力，但不承担 AWKN 总框架权威。

### 2.4 垂直项目

`Value`、`win`、`Mr.Mont`、`annie`、`subtitle`、`life-choice` 等项目可以：

- 嵌入天枢运行时；
- 通过 SDK 或协议调用天枢；
- 独立吸收某些组件；
- 保留自身领域模型、领域 Gate 和交付界面。

## 三、文档导航

| 文档 | 作用 |
|---|---|
| [00-天枢AgentOS3.0总PRD.md](./00-天枢AgentOS3.0总PRD.md) | 产品目标、范围、主链、指标和发布边界 |
| [01-核心架构与领域模型.md](./01-核心架构与领域模型.md) | 组件边界、领域对象、状态机和主链契约 |
| [02-Trusted-Input-Gateway.md](./02-Trusted-Input-Gateway.md) | 输入脱敏、注入清洗、身份、风险与可信输入封装 |
| [03-Intent-Goal-Router.md](./03-Intent-Goal-Router.md) | 意图解析、提问价值门、Goal 建模和 L0—L4 路由 |
| [04-Context-Planner-Claim-Ledger.md](./04-Context-Planner-Claim-Ledger.md) | Claim 血缘、上下文预算、时效、权限和 Context Manifest |
| [05-Policy-Skill-Compiler.md](./05-Policy-Skill-Compiler.md) | Policy Pack、Skill Pack、冲突解析、冻结和回放 |
| [06-Tool-Model-Broker.md](./06-Tool-Model-Broker.md) | 模型与工具选择、供应商选择、授权、累计风险和回执 |
| [07-Evidence-Gain-Loop.md](./07-Evidence-Gain-Loop.md) | 计划、证据预期、执行、验证、偏差、策略切换和停止条件 |
| [08-Delivery-Evidence-Memory-Evolve.md](./08-Delivery-Evidence-Memory-Evolve.md) | 交付、结果、记忆写入、归因、校准和进化治理 |
| [09-AWKN-Memory-OS挂载协议.md](./09-AWKN-Memory-OS挂载协议.md) | Memory OS 独立运行与天枢挂载协议 |
| [10-其他项目组件吸收矩阵.md](./10-其他项目组件吸收矩阵.md) | 各仓库按组件吸收的路径和优先级 |
| [11-实施路线工作包与验收.md](./11-实施路线工作包与验收.md) | 工作包、依赖、里程碑、测试和验收标准 |

## 四、设计原则

1. **天枢单核权威**：总框架、协议和运行门在天枢维护。
2. **组件可替换**：Memory、Model、Tool、Policy、Skill、Delivery 都通过契约挂载。
3. **证据先于完成声明**：没有 fresh evidence 时，Run 不能进入成功终态。
4. **用户决定与模型建议分层**：每个关键 Claim 都保留来源、确认范围和派生关系。
5. **风险按会话累计**：多步低风险操作组合后可以升级授权等级。
6. **规则经过评测后生效**：候选规则和 Skill 必须经过回放、晋级和发布。
7. **失败可恢复**：Run、Step、授权、Outbox、Memory 和 Delivery 都需要幂等与恢复路径。
8. **领域能力留在领域项目**：天枢提供通用内核，垂直项目维护业务语义。

## 五、证据等级

本设计参考外部系统提示词和二次分析文档时，采用以下等级：

- `OBSERVED`：原文可直接观察到的产品或协议机制；
- `INFERRED`：从行为规则推导出的架构方向；
- `HYPOTHESIS`：缺少直接证据的模型内部实现假设。

正式工程基线只使用 `OBSERVED` 和经过原型验证的 `INFERRED`。`HYPOTHESIS` 进入实验清单，不直接进入生产要求。

## 六、与现有代码的关系

本设计优先复用当前运行时：

- `runtime/src/core/agent-loop.ts`
- `runtime/src/goal/`
- `runtime/src/gates/`
- `runtime/src/tools/`
- `runtime/src/llm/`
- `runtime/src/memory/`
- `runtime/src/evidence/`
- `runtime/src/workflow/`
- `runtime/src/evolve/`
- `runtime/src/observability/`
- `runtime/src/skills/`

每个组件文档都会标记：

- `REUSE`：直接复用；
- `UPGRADE`：在现有实现上升级；
- `NEW`：新增模块；
- `DEPRECATE`：逐步淘汰。

## 七、版本关系

```text
天枢 Engine v2
   ↓
Agent OS 3.0 架构文档与契约冻结
   ↓
Agent OS 3.0 组件增量实现
   ↓
垂直项目分批接入
   ↓
Agent OS 3.0 Release Candidate
```

本目录不修改现有生产行为。实现工作必须按 `11-实施路线工作包与验收.md` 分批进入代码。