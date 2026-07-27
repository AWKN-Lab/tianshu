# 天枢 Agent OS 3.0 工程文档集

> 版本：v1.4  
> 日期：2026-07-27  
> 状态：00—21 文档齐备；R0、R1 已完成；R2 组件实现接近完成，Release Gate 等待 Review 与 Shadow  
> 权威项目：`AWKN-Lab/tianshu`

## 一、定位

天枢是 AWKN Agent OS 总框架、运行时协议、治理规则和进化闭环的权威实现位置。

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

天枢集中建设输入治理、Intent/Goal、Claim/Context、Policy/Skill、Model/Tool Broker、Evidence Loop、Delivery、Outcome、Memory Write Gate 和 Evolve。

### 2.2 AWKN Memory OS

AWKN Memory OS 独立部署、独立发布、独立使用，通过 `MemoryBackend` 协议向天枢提供长期 Claim、Experience、Rule、Context Ledger、Immutable Render、持久化事务、Project Grant、CAS、Outbox 和治理能力。

WP17A 使用 `tianshu-core-contracts-v1` Fixture，权威 Source Commit 为 `17cbda273aeed121f81f281ae9c7088e2565c00f`。

### 2.3 其他项目

其他 AWKN 业务项目可以研究相同机制，不接入天枢 Runtime，不继承天枢数据库、Feature Flag 或发布生命周期。

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
| [06-Tool-Model-Broker.md](./06-Tool-Model-Broker.md) | 模型、工具、供应商、执行许可、累计风险和回执 |
| [07-Evidence-Gain-Loop.md](./07-Evidence-Gain-Loop.md) | 预期证据、执行、偏差、策略切换和停止条件 |
| [08-Delivery-Evidence-Memory-Evolve.md](./08-Delivery-Evidence-Memory-Evolve.md) | Delivery、Outcome、Memory Write 和 Evolve |
| [09-AWKN-Memory-OS挂载协议.md](./09-AWKN-Memory-OS挂载协议.md) | Memory OS 独立运行与天枢挂载协议 |
| [10-其他项目独立进化参考.md](./10-其他项目独立进化参考.md) | 各项目可研究的机制和独立实施方向 |
| [11-实施路线工作包与验收.md](./11-实施路线工作包与验收.md) | 工作包、依赖、验收和执行顺序 |

### 3.2 实施级工程文档

| 文档 | 作用 | 治理任务 |
|---|---|---|
| [12-工程实施总设计.md](./12-工程实施总设计.md) | 代码映射、依赖 DAG、Coordinator、PR 拆分和回滚 | #27 |
| [13-Contracts与Canonical-JSON规范.md](./13-Contracts与Canonical-JSON规范.md) | Schema、Canonical JSON、Stable Hash、ID、核心契约和错误码 | #28 |
| [14-数据模型与Migration设计.md](./14-数据模型与Migration设计.md) | SQLite DDL、v11—v19、回填、索引和恢复 | #29 |
| [15-状态机事件与事务边界.md](./15-状态机事件与事务边界.md) | 状态转换、Event、Receipt、Saga、Replay 和事务边界 | #30 |
| [16-Adapter-Shadow-FeatureFlag迁移手册.md](./16-Adapter-Shadow-FeatureFlag迁移手册.md) | Engine v2 Adapter、Shadow Diff、灰度、降级和删除条件 | #31 |
| [17-测试矩阵与Release-Runbook.md](./17-测试矩阵与Release-Runbook.md) | WP 测试矩阵、CI、Golden、RC、发布和回滚 | #32 |
| [18-Memory-OS-vNext双仓实施RFC.md](./18-Memory-OS-vNext双仓实施RFC.md) | 双仓协议、CAS、Outbox、兼容和发布顺序 | #33、#42、#78 |
| [19-Loop-Engineering与大型Agent-Prompt迁移启示.md](./19-Loop-Engineering与大型Agent-Prompt迁移启示.md) | Goal 外层循环、上下文隔离和 Prompt 编译治理 | #34 |
| [20-组件金字塔与模块职责边界.md](./20-组件金字塔与模块职责边界.md) | C01—C09、有界模块、数据 Owner、Port/Adapter、架构扫描 | #35 |
| [21-Agent-OS-3.0总开发计划.md](./21-Agent-OS-3.0总开发计划.md) | R0—R6、WP 调度、状态模型、Evidence Index、一致性清单和当前看板 | #43 |

## 四、当前实施状态

```text
R0 Baseline                Done
→ R1 Contract Kernel       Done
→ R2 Trusted Decision Core Components near complete
   WP02 Trusted Input       main@20c52409
   WP03 Intent / Goal       main@a461e408
   WP04 Claim Ledger        main@df174845，Migration v12
   WP05A Context Planner    main@b5c9c401
   WP05B Context Render     PR #64，run #128通过，Review Blocked
   R2 Shadow Exit           #66，未开始
→ R3 Governed Execution    #67—#71
→ R4 Outcome & Memory      #72—#75 + #42
→ R5 Shadow Beta           #76—#79 + #78
→ R6 Production Candidate  #80
```

当前 `main`：`b5c9c401057be0a2ca0900bbdc36c407185f932a`。  
当前 Migration：v12。  
PR #64 机器验证：276 tests，0 fail，三平台成功。

## 五、统一状态与 Mode

工作包状态：

```text
DESIGNED
→ CONTRACT_FROZEN
→ IMPLEMENTED_MODE_0
→ SHADOW_READY
→ SHADOW_VALIDATED
→ ENFORCED
→ LEGACY_REMOVED
```

Mode `0`：未接 Runtime，不进入 Shadow Sample，Rollback 为回退 Squash Commit或停止导入 Public Contract。

Shadow：Engine v2 保持默认，禁止真实外部副作用，Feature Flag 按 Execution 冻结。

Enforce：每次只切换一个权威 Owner，并具备一键回退。

## 六、已冻结 P0 工程决定

1. `ExecutionCoordinator` 作为 C01—C09 主链编排器；
2. 二级有界模块是代码隔离、数据归属和独立测试的最小单元；
3. 每个模块区分 Domain、Application、Ports、Adapters、Persistence、Observability；
4. 跨组件只允许 Contracts、`public.ts`、Inbound Port、Domain Event 和 Receipt Ref；
5. 新核心禁止兄弟实现导入、直接 SQLite、模块级可变单例；
6. `ExecutionEnvelope` 保存 Ref、状态、Hash 和 revision；
7. Receipt 使用统一 Envelope 与分类 Payload；
8. Claim 使用 `epistemicStatus + confirmationLevel`；
9. Goal 只有 Goal Judge 可以生成 `ACHIEVED`；
10. Shadow 禁止外部副作用；
11. Feature Flag 在 Execution 创建时冻结；
12. Agent OS Migration 统一进入 Registry，目前实施至 v12；
13. Memory OS 分为 WP17A 和 WP17B；
14. 认证、Grant、协议不兼容必须 fail-closed；
15. 除 Memory OS 外，不增加跨仓运行依赖。

## 七、当前治理入口

- 总计划与里程碑：#43；
- 架构债务：#35；
- Docs 基线：#26、#65；
- PR #64 Review Blocker：#63；
- R2 Shadow Exit：#66；
- Model Benchmark：#41、#69、#79；
- Memory OS Protocol：#42、#78；
- R3—R6 Issue Tree：#67—#80。
