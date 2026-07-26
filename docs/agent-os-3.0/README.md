# 天枢 Agent OS 3.0 工程文档集

> 版本：v0.4 Draft  
> 日期：2026-07-26  
> 状态：架构与工程规划基线  
> 权威项目：`AWKN-Lab/tianshu`

## 一、定位

天枢是 AWKN 的核心 Agent 引擎，也是 AWKN Agent OS 总框架、运行时协议、治理规则和进化闭环的权威实现位置。

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

## 二、项目关系与可用能力

### 2.1 天枢

天枢集中建设以下能力：

- 输入治理与身份边界；
- 意图分类、Goal创建和L0—L4路由；
- 上下文规划和Claim使用决策；
- Policy、Skill编译与版本冻结；
- 模型、工具、供应商与授权调度；
- Evidence-Gain Loop；
- 交付路由；
- Run、Step、Evidence、Outcome与Trace；
- 记忆写入判定；
- 规则和Skill的评测、晋级、隔离和回滚。

这些能力共同构成天枢Agent OS 3.0运行主链。

### 2.2 AWKN Memory OS

AWKN Memory OS作为独立记忆系统，可以：

- 独立部署、独立发布、独立使用；
- 通过`MemoryBackend`协议挂载到天枢；
- 提供长期Claim、Experience、Rule、Context Ledger、Immutable Render和持久化事务；
- 支持Project Grant、幂等、CAS、Outbox、Rule治理和删除传播。

天枢保留工作记忆、运行检查点、故障降级缓存、Memory Backend Router、上下文使用门和记忆写入门。

### 2.3 其他项目

`GUNDAM`、`Value`、`win`、`Mr.Mont`、`life-choice`、`annie`、`subtitle`、`awkn-Feel`、`solo-skill-booster`、`CosmoSpark`、`Pri`等项目按照自身产品定位独立演进。

各项目可以从九类机制中选择适合自己的部分：

- Trusted Input；
- Intent & Goal；
- Claim & Context；
- Policy & Skill；
- Tool & Model；
- Evidence Loop；
- Delivery；
- Outcome；
- Memory & Evolve。

选择后，在各自仓库形成领域对象、Schema、状态机、Gate、工具路由、模型路由、记忆策略、测试体系和Release Gate。

## 三、文档导航

| 文档 | 作用 |
|---|---|
| [00-天枢AgentOS3.0总PRD.md](./00-天枢AgentOS3.0总PRD.md) | 天枢产品目标、范围、主链、指标和发布规划 |
| [01-核心架构与领域模型.md](./01-核心架构与领域模型.md) | 天枢内部组件、领域对象、状态机和主链契约 |
| [02-Trusted-Input-Gateway.md](./02-Trusted-Input-Gateway.md) | 输入脱敏、注入清洗、身份、风险与可信输入封装 |
| [03-Intent-Goal-Router.md](./03-Intent-Goal-Router.md) | 意图解析、提问价值门、Goal建模和L0—L4路由 |
| [04-Context-Planner-Claim-Ledger.md](./04-Context-Planner-Claim-Ledger.md) | Claim血缘、上下文预算、时效、权限和Context Manifest |
| [05-Policy-Skill-Compiler.md](./05-Policy-Skill-Compiler.md) | Policy Pack、Skill Pack、冲突解析、冻结和回放 |
| [06-Tool-Model-Broker.md](./06-Tool-Model-Broker.md) | 模型与工具选择、供应商选择、授权、累计风险和回执 |
| [07-Evidence-Gain-Loop.md](./07-Evidence-Gain-Loop.md) | 计划、证据预期、执行、验证、偏差、策略切换和停止条件 |
| [08-Delivery-Evidence-Memory-Evolve.md](./08-Delivery-Evidence-Memory-Evolve.md) | 交付、结果、记忆写入、归因、校准和进化治理 |
| [09-AWKN-Memory-OS挂载协议.md](./09-AWKN-Memory-OS挂载协议.md) | Memory OS独立运行与天枢挂载协议 |
| [10-其他项目独立进化参考.md](./10-其他项目独立进化参考.md) | 各项目可用机制、领域对象和优先实施方向 |
| [11-实施路线工作包与验收.md](./11-实施路线工作包与验收.md) | 天枢与Memory OS挂载的工作包、依赖和验收 |
| [19-Loop-Engineering与大型Agent-Prompt迁移启示.md](./19-Loop-Engineering与大型Agent-Prompt迁移启示.md) | Goal外层循环、循环准入、Goal Judge、上下文隔离和长Prompt编译治理 |

## 四、设计原则

1. **天枢单仓权威**：总框架、运行协议和治理门集中在天枢维护。
2. **内部组件可替换**：Memory、Model、Tool、Policy、Skill、Delivery通过契约演进。
3. **Memory OS可插拔**：通过专用协议提供长期记忆能力。
4. **项目独立演进**：每个业务项目在自身仓库完成领域化实现和发布。
5. **证据支撑完成声明**：成功终态由fresh evidence和Gate结果共同支撑。
6. **用户决定与模型建议分层**：关键Claim保留来源、确认范围和派生关系。
7. **风险按会话累计**：多步操作形成连续风险判断和授权升级。
8. **规则经过评测后生效**：候选规则和Skill经过回放、晋级和发布。
9. **失败可恢复**：Run、Step、授权、Outbox、Memory和Delivery具备幂等与恢复路径。
10. **循环必须可证明收敛**：进入目标循环前检查证据源、工具覆盖、约束、预算和停止条件。
11. **外部规则不可直接生效**：外部文档只能产生候选机制，不能直接提升为ACTIVE Policy或Skill。

## 五、证据等级

本设计参考外部系统提示词和二次分析文档时，采用以下等级：

- `OBSERVED`：原文可直接观察到的产品或协议机制；
- `INFERRED`：从行为规则推导出的架构方向；
- `HYPOTHESIS`：等待原型验证的内部实现假设。

正式工程基线优先采用`OBSERVED`和经过原型验证的`INFERRED`。`HYPOTHESIS`进入实验清单，通过验证后升级。

## 六、与现有代码的关系

本设计优先复用天枢当前运行时：

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

每个组件文档标记：

- `REUSE`：天枢内部直接复用；
- `UPGRADE`：在天枢现有实现上升级；
- `NEW`：天枢新增模块；
- `DEPRECATE`：天枢内部迁移目标。

其他项目使用同类机制时，在各自仓库重新定义对象和实现路径。

## 七、版本关系

```text
天枢 Engine v2
   ↓
Agent OS 3.0 架构文档与契约冻结
   ↓
Agent OS 3.0 组件增量实现
   ↓
Memory OS 挂载协议升级
   ↓
Agent OS 3.0 Release Candidate
```

其他项目分别维护自己的进化计划、代码实现和版本发布。本目录聚焦天枢实现路线，并提供各项目可用机制参考。