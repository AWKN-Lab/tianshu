# 天枢 Agent OS 3.0 工程文档集

> 版本：v1.0 Engineering Draft  
> 日期：2026-07-26  
> 状态：架构与实施级工程文档已齐备，等待评审  
> 权威项目：`AWKN-Lab/tianshu`

## 一、定位

天枢是 AWKN 的核心 Agent 引擎，也是 AWKN Agent OS 总框架、运行时协议、治理规则和进化闭环的权威实现位置。

Agent OS 3.0 运行主链：

```text
Trusted Input Gateway
→ Intent & Goal Router
→ Context Planner
→ Policy & Skill Compiler
→ Tool & Model Broker
→ Evidence-Gain Loop
→ Delivery Router
→ Evidence & Outcome
→ Memory Write Gate
→ Evolve
```

## 二、项目边界

### 2.1 天枢

天枢集中建设：

- 输入治理与身份边界；
- 意图分类、Goal、L0—L4 路由；
- Claim、Context Manifest 和上下文预算；
- Policy、Skill 编译与版本冻结；
- 模型、工具、授权和累计风险调度；
- Evidence-Gain Loop；
- Delivery、Outcome、Receipt 和 Trace；
- Memory Write Gate；
- 规则和 Skill 的评测、晋级、隔离和回滚。

### 2.2 AWKN Memory OS

AWKN Memory OS 独立部署、独立发布、独立使用，通过 `MemoryBackend` 协议向天枢提供长期 Claim、Experience、Rule、Context Ledger、Immutable Render、持久化事务、Project Grant、CAS、Outbox 和治理能力。

天枢保留工作记忆、运行检查点、故障降级缓存、Backend Router、Context 使用门和 Memory Write Gate。

### 2.3 其他项目

`GUNDAM`、`Value`、`win`、`Mr.Mont`、`life-choice`、`annie`、`subtitle`、`awkn-Feel`、`solo-skill-booster`、`CosmoSpark`、`Pri` 等项目按照各自产品定位独立演进。它们可以研究和复用机制，不接入天枢 Runtime，不继承天枢数据库、Feature Flag 或发布生命周期。

## 三、文档导航

### 3.1 产品与组件设计

| 文档 | 作用 |
|---|---|
| [00-天枢AgentOS3.0总PRD.md](./00-天枢AgentOS3.0总PRD.md) | 产品目标、范围、主链、指标和发布规划 |
| [01-核心架构与领域模型.md](./01-核心架构与领域模型.md) | 九个组件、领域对象、状态机和主链契约 |
| [02-Trusted-Input-Gateway.md](./02-Trusted-Input-Gateway.md) | 输入脱敏、注入清洗、身份、风险和可信输入 |
| [03-Intent-Goal-Router.md](./03-Intent-Goal-Router.md) | 意图、澄清价值门、Goal 和 L0—L4 路由 |
| [04-Context-Planner-Claim-Ledger.md](./04-Context-Planner-Claim-Ledger.md) | Claim 血缘、上下文预算、时效、权限和 Manifest |
| [05-Policy-Skill-Compiler.md](./05-Policy-Skill-Compiler.md) | Policy/Skill、冲突解析、冻结和回放 |
| [06-Tool-Model-Broker.md](./06-Tool-Model-Broker.md) | 模型、工具、供应商、授权、累计风险和回执 |
| [07-Evidence-Gain-Loop.md](./07-Evidence-Gain-Loop.md) | 预期证据、执行、偏差、策略切换和停止条件 |
| [08-Delivery-Evidence-Memory-Evolve.md](./08-Delivery-Evidence-Memory-Evolve.md) | Delivery、Outcome、Memory Write 和 Evolve |
| [09-AWKN-Memory-OS挂载协议.md](./09-AWKN-Memory-OS挂载协议.md) | Memory OS 独立运行与天枢挂载协议 |
| [10-其他项目独立进化参考.md](./10-其他项目独立进化参考.md) | 各项目可研究的机制和独立实施方向 |
| [11-实施路线工作包与验收.md](./11-实施路线工作包与验收.md) | 20 个工作包、依赖、验收和执行顺序 |

### 3.2 实施级工程文档

| 文档 | 作用 | 关联 Issue |
|---|---|---|
| [12-工程实施总设计.md](./12-工程实施总设计.md) | 代码映射、依赖 DAG、Coordinator、PR 拆分和回滚 | #27 |
| [13-Contracts与Canonical-JSON规范.md](./13-Contracts与Canonical-JSON规范.md) | Schema、Canonical JSON、Stable Hash、ID、核心契约和错误码 | #28 |
| [14-数据模型与Migration设计.md](./14-数据模型与Migration设计.md) | SQLite DDL、v11—v19 Migration、回填、索引和恢复 | #29 |
| [15-状态机事件与事务边界.md](./15-状态机事件与事务边界.md) | 状态转换、Event、Receipt、Saga、Replay 和事务边界 | #30 |
| [16-Adapter-Shadow-FeatureFlag迁移手册.md](./16-Adapter-Shadow-FeatureFlag迁移手册.md) | Engine v2 Adapter、Shadow Diff、灰度、降级和删除条件 | #31 |
| [17-测试矩阵与Release-Runbook.md](./17-测试矩阵与Release-Runbook.md) | WP 测试矩阵、CI、Golden、RC、发布和回滚 Runbook | #32 |
| [18-Memory-OS-vNext双仓实施RFC.md](./18-Memory-OS-vNext双仓实施RFC.md) | 双仓协议、Endpoint、CAS、Outbox、兼容和发布顺序 | #33 |
| [19-Loop-Engineering与大型Agent-Prompt迁移启示.md](./19-Loop-Engineering与大型Agent-Prompt迁移启示.md) | Goal 外层循环、循环准入、Goal Judge、上下文隔离和 Prompt 编译治理 | #34 |

## 四、工程文档完成状态

- [x] 工程实施总设计；
- [x] Contracts 与 Canonical JSON；
- [x] 数据模型与 Migration；
- [x] 状态机、事件与事务边界；
- [x] Adapter、Shadow Mode 与 Feature Flag；
- [x] 测试矩阵与 Release Runbook；
- [x] Memory OS vNext 双仓 RFC；
- [x] Loop Engineering 与大型 Agent Prompt 迁移研究。

上述状态代表文档交付完成。代码、Migration、CI、Protocol 和 RC 仍按 WP-AOS-00—19 独立实施和验收。

## 五、已冻结的 P0 工程决定

1. 新增 `ExecutionCoordinator` 作为 C01—C09 主链编排器；
2. `ExecutionEnvelope` 保存 Ref、状态、Hash 和 revision；
3. Receipt 使用统一 Envelope 和分类 Payload；
4. EventStore 与业务投影同事务，ReceiptStore 保存证明材料；
5. Claim 使用 `epistemicStatus + confirmationLevel` 双轴；
6. Canonical JSON、Stable Hash、ID、时间和 unknown/null/omitted 语义已定义；
7. Authorization 使用服务端引用令牌、原子预占和撤销；
8. Goal 只有 `GoalJudgeService` 可以更新为 ACHIEVED；
9. Shadow 路径禁止外部副作用；
10. Feature Flag 在 Execution 创建时冻结；
11. Agent OS 新 Migration 从 v11 开始，统一进入 Registry；
12. Memory OS 协议拆为 WP17A Contracts 和 WP17B Adapter/Governance；
13. 401/403、Grant 和协议不兼容禁止 local 降级；
14. 除 Memory OS 外，不增加任何跨仓运行依赖。

## 六、设计原则

1. **天枢单仓权威**：总框架、运行协议和治理门集中在天枢维护。
2. **内部组件可替换**：Memory、Model、Tool、Policy、Skill、Delivery 通过契约演进。
3. **Memory OS 可插拔**：通过专用协议提供长期记忆能力。
4. **项目独立演进**：每个业务项目在自身仓库完成领域化实现和发布。
5. **证据支撑完成声明**：成功终态由新鲜 Evidence、Constraint 和 Gate 共同支撑。
6. **用户决定与模型建议分层**：Claim 保留来源、确认范围和派生关系。
7. **风险按会话累计**：多步操作形成连续风险判断和授权升级。
8. **规则经过评测后生效**：候选规则和 Skill 经过回放、晋级和发布。
9. **失败可恢复**：Run、Step、Authorization、Outbox、Memory 和 Delivery 具备幂等与恢复路径。
10. **循环必须可证明收敛**：进入 Goal Loop 前检查证据源、工具覆盖、约束、预算和停止条件。
11. **外部规则不可直接生效**：外部文档只能生成 Candidate，不能直接成为 ACTIVE Policy 或 Skill。
12. **文档与代码状态分离**：本目录完成工程设计，不代表对应代码工作包已经完成。

## 七、与现有代码的关系

优先复用：

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

迁移动作：

- `REUSE`：直接复用；
- `UPGRADE`：基于现有实现升级；
- `NEW`：新增组件；
- `DEPRECATE`：迁移完成后的内部退役目标。

## 八、实施 Gate

```text
Gate 0  工程文档评审与语义冻结
→ Gate 1  WP-AOS-00 Baseline Freeze
→ Gate 2  WP-AOS-01 Core Contracts
→ Gate 3  分段 Shadow
→ Gate 4  分段 Enforce
→ Gate 5  Compatibility、Hardening 与 RC
```

PR #25 当前只承载文档基线。代码开发应使用独立短分支和独立 PR，禁止把 20 个工作包放入一个长期开发分支。