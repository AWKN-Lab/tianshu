# 天枢 Agent OS 3.0 工程文档集

> 版本：v0.2 Draft  
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

## 二、仓库关系与权威边界

### 2.1 天枢

天枢只负责自身运行时与自身产品边界：

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

这些组件属于天枢内部实现，不作为其他仓库的公共运行时、公共 SDK 或公共服务。

### 2.2 AWKN Memory OS

AWKN Memory OS 是唯一允许与天枢建立运行时挂载关系的独立仓库。

它可以：

- 独立部署、独立发布、独立使用；
- 通过 `MemoryBackend` 协议挂载到天枢；
- 为天枢提供长期 Claim、Experience、Rule、Context Ledger、Immutable Render 和持久化事务。

天枢保留工作记忆、运行检查点、故障降级缓存、Memory Backend Router、上下文使用门和记忆写入门。

### 2.3 其他仓库

`GUNDAM`、`Value`、`win`、`Mr.Mont`、`life-choice`、`annie`、`subtitle`、`awkn-Feel`、`solo-skill-booster`、`CosmoSpark`、`Pri` 等项目全部保持独立：

- 不嵌入天枢 Runtime；
- 不调用天枢 Service；
- 不依赖天枢 SDK；
- 不采用天枢作为运行时权威；
- 不与天枢共享发布、Schema、Registry、Feature Flag 或生命周期；
- 不要求兼容天枢协议。

这些项目可以研究相同机制，并在各自仓库中独立设计、编码、测试、发布。文档中的“吸收”只表示机制启发，不表示代码、协议或运行时复用。

## 三、文档导航

| 文档 | 作用 |
|---|---|
| [00-天枢AgentOS3.0总PRD.md](./00-天枢AgentOS3.0总PRD.md) | 天枢自身产品目标、范围、主链、指标和发布边界 |
| [01-核心架构与领域模型.md](./01-核心架构与领域模型.md) | 天枢内部组件边界、领域对象、状态机和主链契约 |
| [02-Trusted-Input-Gateway.md](./02-Trusted-Input-Gateway.md) | 天枢输入脱敏、注入清洗、身份、风险与可信输入封装 |
| [03-Intent-Goal-Router.md](./03-Intent-Goal-Router.md) | 天枢意图解析、提问价值门、Goal 建模和 L0—L4 路由 |
| [04-Context-Planner-Claim-Ledger.md](./04-Context-Planner-Claim-Ledger.md) | 天枢 Claim 血缘、上下文预算、时效、权限和 Context Manifest |
| [05-Policy-Skill-Compiler.md](./05-Policy-Skill-Compiler.md) | 天枢 Policy Pack、Skill Pack、冲突解析、冻结和回放 |
| [06-Tool-Model-Broker.md](./06-Tool-Model-Broker.md) | 天枢模型与工具选择、供应商选择、授权、累计风险和回执 |
| [07-Evidence-Gain-Loop.md](./07-Evidence-Gain-Loop.md) | 天枢计划、证据预期、执行、验证、偏差、策略切换和停止条件 |
| [08-Delivery-Evidence-Memory-Evolve.md](./08-Delivery-Evidence-Memory-Evolve.md) | 天枢交付、结果、记忆写入、归因、校准和进化治理 |
| [09-AWKN-Memory-OS挂载协议.md](./09-AWKN-Memory-OS挂载协议.md) | Memory OS 独立运行与天枢挂载协议 |
| [10-其他项目独立进化参考.md](./10-其他项目独立进化参考.md) | 其他仓库可独立研究的机制与各自进化方向，不构成接入关系 |
| [11-实施路线工作包与验收.md](./11-实施路线工作包与验收.md) | 仅针对天枢与 Memory OS 挂载的工作包、依赖和验收 |

## 四、设计原则

1. **天枢单仓权威**：总框架、运行协议和治理门只在天枢维护。
2. **内部组件可替换**：Memory、Model、Tool、Policy、Skill、Delivery 在天枢内部通过契约替换。
3. **Memory OS例外**：只允许 Memory OS 通过专用协议挂载。
4. **其他项目严格独立**：机制可以借鉴，代码、协议、运行时和发布体系不共享。
5. **证据先于完成声明**：没有 fresh evidence 时，Run 不能进入成功终态。
6. **用户决定与模型建议分层**：每个关键 Claim 都保留来源、确认范围和派生关系。
7. **风险按会话累计**：多步低风险操作组合后可以升级授权等级。
8. **规则经过评测后生效**：候选规则和 Skill 必须经过回放、晋级和发布。
9. **失败可恢复**：Run、Step、授权、Outbox、Memory 和 Delivery 都需要幂等与恢复路径。

## 五、证据等级

本设计参考外部系统提示词和二次分析文档时，采用以下等级：

- `OBSERVED`：原文可直接观察到的产品或协议机制；
- `INFERRED`：从行为规则推导出的架构方向；
- `HYPOTHESIS`：缺少直接证据的模型内部实现假设。

正式工程基线只使用 `OBSERVED` 和经过原型验证的 `INFERRED`。`HYPOTHESIS` 进入实验清单，不直接进入生产要求。

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
- `DEPRECATE`：天枢内部逐步淘汰。

这些标记不适用于其他仓库。

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

其他仓库的进化计划、代码实现和版本发布必须分别在各自仓库维护。本目录不修改现有生产行为；天枢实现工作按 `11-实施路线工作包与验收.md` 分批进入代码。
