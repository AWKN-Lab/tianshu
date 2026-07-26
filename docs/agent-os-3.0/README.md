# 天枢 Agent OS 3.0 工程文档集

> 版本：v1.2 Engineering Draft  
> 日期：2026-07-26  
> 状态：工程文档与总开发计划已齐备；R0 已完成，R1 进入合并 Gate  
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

天枢集中建设：输入治理、Intent/Goal、Claim/Context、Policy/Skill、Model/Tool Broker、Evidence Loop、Delivery、Outcome、Memory Write Gate 和 Evolve。

### 2.2 AWKN Memory OS

AWKN Memory OS 独立部署、独立发布、独立使用，通过 `MemoryBackend` 协议向天枢提供长期 Claim、Experience、Rule、Context Ledger、Immutable Render、持久化事务、Project Grant、CAS、Outbox 和治理能力。

### 2.3 其他项目

其他 AWKN 业务项目可以研究和复用机制，不接入天枢 Runtime，不继承天枢数据库、Feature Flag 或发布生命周期。

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

| 文档 | 作用 | Issue |
|---|---|---|
| [12-工程实施总设计.md](./12-工程实施总设计.md) | 代码映射、依赖 DAG、Coordinator、PR 拆分和回滚 | #27 |
| [13-Contracts与Canonical-JSON规范.md](./13-Contracts与Canonical-JSON规范.md) | Schema、Canonical JSON、Stable Hash、ID、核心契约和错误码 | #28 |
| [14-数据模型与Migration设计.md](./14-数据模型与Migration设计.md) | SQLite DDL、v11—v19 Migration、回填、索引和恢复 | #29 |
| [15-状态机事件与事务边界.md](./15-状态机事件与事务边界.md) | 状态转换、Event、Receipt、Saga、Replay 和事务边界 | #30 |
| [16-Adapter-Shadow-FeatureFlag迁移手册.md](./16-Adapter-Shadow-FeatureFlag迁移手册.md) | Engine v2 Adapter、Shadow Diff、灰度、降级和删除条件 | #31 |
| [17-测试矩阵与Release-Runbook.md](./17-测试矩阵与Release-Runbook.md) | WP 测试矩阵、CI、Golden、RC、发布和回滚 Runbook | #32 |
| [18-Memory-OS-vNext双仓实施RFC.md](./18-Memory-OS-vNext双仓实施RFC.md) | 双仓协议、Endpoint、CAS、Outbox、兼容和发布顺序 | #33 |
| [19-Loop-Engineering与大型Agent-Prompt迁移启示.md](./19-Loop-Engineering与大型Agent-Prompt迁移启示.md) | Goal 外层循环、循环准入、Goal Judge、上下文隔离和 Prompt 编译治理 | #34 |
| [20-组件金字塔与模块职责边界.md](./20-组件金字塔与模块职责边界.md) | 六层金字塔、C01—C09 有界模块、数据 Owner、Port/Adapter、架构适应性测试 | #35 |
| [21-Agent-OS-3.0总开发计划.md](./21-Agent-OS-3.0总开发计划.md) | R0—R6 发布里程碑、WP 调度、关键路径、并行流、WIP、DoD 和当前执行看板 | #43 |

## 四、工程文档完成状态

- [x] 工程实施总设计；
- [x] Contracts 与 Canonical JSON；
- [x] 数据模型与 Migration；
- [x] 状态机、事件与事务边界；
- [x] Adapter、Shadow Mode 与 Feature Flag；
- [x] 测试矩阵与 Release Runbook；
- [x] Memory OS vNext 双仓 RFC；
- [x] Loop Engineering 与大型 Agent Prompt 迁移研究；
- [x] 组件金字塔与模块职责边界；
- [x] R0—R6 总开发计划、关键路径和完成定义。

文档交付已经完成。代码、Migration、CI、Protocol 和 RC 按总开发计划及 WP-AOS-00—19 独立实施和验收。

## 五、已冻结的 P0 工程决定

1. 新增 `ExecutionCoordinator` 作为 C01—C09 主链编排器；
2. C01—C09 是一级能力组件组，二级有界模块是代码隔离、数据归属和独立测试的最小单元；
3. 每个有界模块统一区分 Domain、Application、Ports、Adapters、Persistence、Observability；
4. 跨组件调用只允许经过 Contracts、`public.ts`、Inbound Port、Domain Event 和 Receipt Ref；
5. 新 Agent OS 核心禁止直接导入兄弟组件实现、直接访问 SQLite 和使用模块级可变单例；
6. `ExecutionEnvelope` 保存 Ref、状态、Hash 和 revision；
7. Receipt 使用统一 Envelope 和分类 Payload；
8. EventStore 与业务投影同事务，ReceiptStore 保存证明材料；
9. Claim 使用 `epistemicStatus + confirmationLevel` 双轴；
10. Canonical JSON、Stable Hash、ID、时间和 unknown/null/omitted 语义已定义；
11. Authorization 使用服务端引用令牌、原子预占和撤销；
12. Goal 只有 `GoalJudgeService` 可以更新为 ACHIEVED；
13. Shadow 路径禁止外部副作用；
14. Feature Flag 在 Execution 创建时冻结；
15. Agent OS 新 Migration 从 v11 开始，统一进入 Registry；
16. Memory OS 协议拆为 WP17A Contracts 和 WP17B Adapter/Governance；
17. 401/403、Grant 和协议不兼容禁止 local 降级；
18. 除 Memory OS 外，不增加跨仓运行依赖。

## 六、发布里程碑 Gate

```text
R0 Baseline                已完成：PR #39 已合并 main
→ R1 Contract Kernel       当前：PR #38 切回 main 后最终复验
→ R2 Trusted Decision Core WP02—05
→ R3 Governed Execution    WP06—10
→ R4 Outcome & Memory      WP11—14 + WP17A
→ R5 Shadow Beta           WP15—18 + WP17B
→ R6 Production Candidate  WP19
```

PR #25 承载产品、工程和开发计划文档基线。代码开发使用独立短分支和独立 PR，禁止把多个发布里程碑放入一个长期开发分支。