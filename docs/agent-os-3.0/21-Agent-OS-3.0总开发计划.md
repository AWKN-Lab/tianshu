# 天枢 Agent OS 3.0 总开发计划

> 文档编号：TS-AOS-PLAN-021  
> 版本：v1.0 Draft  
> 日期：2026-07-26  
> 关联：PR #25、#38、#39，Issue #26、#35、#36、#37、#40、#41、#42  
> 权威范围：`AWKN-Lab/tianshu` Agent OS 3.0 代码开发、迁移、测试与发布调度

## 一、计划目标

本文把产品 PRD、工程设计、组件金字塔和 WP-AOS-00—19 转化为可执行的开发顺序。

开发计划回答六个问题：

1. 当前处于哪个里程碑；
2. 下一个必须完成的工作包是什么；
3. 哪些工作可以并行；
4. 哪些依赖未满足时禁止开工；
5. 每个阶段以什么证据退出；
6. 何时可以从 Engine v2 Shadow 切换到 Agent OS 3.0 Enforce。

## 二、开发金字塔

```text
L0 产品结果
   可验证完成、风险受控、失败可恢复、持续进化

L1 发布里程碑
   R0 Baseline
   R1 Contract Kernel
   R2 Trusted Decision Core
   R3 Governed Execution Kernel
   R4 Outcome & Memory Loop
   R5 Shadow Beta
   R6 Production Candidate

L2 开发流
   Foundation / Trust / Context / Governance / Execution / Outcome / Migration / Release

L3 工作包
   WP-AOS-00—19、WP17A、WP17B

L4 交付单元
   Issue → 短分支 → Draft PR → CI Evidence → Review → Squash Merge
```

工作包不得脱离所属发布里程碑单独宣布“完成”。代码合并不等于发布里程碑完成；必须满足里程碑退出条件。

## 三、计划假设

推荐按以下能力配置估算：

- 1 名主开发负责架构和最终合并；
- AI Coding Agent 承担实现、测试、Fixture 和静态审查；
- 兼职架构评审与安全评审；
- 一个工程周期为 3—5 个工作日；
- 同时打开的代码 PR 不超过 2 个；
- 同时修改 Runtime 主执行链的 PR 不超过 1 个。

在该假设下，R0—R6 建议使用 14—18 个工程周期。该范围用于工作量规划，不作为对外发布日期承诺。

## 四、工作包统一调度表

旧文档中个别工作包名称存在简写差异，开发调度统一使用下表名称；契约语义仍以 12—20 号工程文档为准。

| WP | 调度名称 | 主要交付 | 前置依赖 | 当前状态 |
|---|---|---|---|---|
| WP-AOS-00 | Baseline & Architecture Gate | 架构扫描、跨平台 CI、依赖/SBOM/Audit、Baseline Manifest | 无 | **已合并 main，PR #39** |
| WP-AOS-01 | Core Contracts | Canonical JSON、Stable Hash、Goal/Claim/Evidence/Receipt/Event/Auth 契约与 Golden | WP00 | **PR #38 待切回 main 复验** |
| WP-AOS-02 | Trusted Input Gateway | Duplicate-Key Parser、Identity Scope、DLP、Injection Guard、Input Receipt | WP01 | **下一主线，Issue #40** |
| WP-AOS-03 | Intent & Goal Router | Intent、Execution Level、Task Profile、GoalSpec Factory、Loop Eligibility | WP01、WP02 | 未开始 |
| WP-AOS-04 | Claim Ledger | Claim Repository、Source Registry、Authority/Freshness/Conflict | WP01、WP02 | 未开始 |
| WP-AOS-05 | Context Planner | Utility、Token Allocator、Manifest、Render Binder | WP04 | 未开始 |
| WP-AOS-06 | Policy Compiler | Policy Registry、Conflict Resolver、Compiled Policy Bundle | WP01、WP02 | 未开始 |
| WP-AOS-07 | Skill Compiler | Skill Registry、Capability Contract、Compiled Skill Bundle；清理 Legacy Skill Singleton | WP01、WP06 | 未开始 |
| WP-AOS-08 | Model Broker | Provider Port、Model Routing、Fallback、Fake Provider Benchmark | WP01、WP03、WP05 | Issue #41 已登记 |
| WP-AOS-09 | Tool Broker & Authorization | Tool Catalog、Policy Evaluation、原子预占、Side-effect Receipt | WP01、WP02、WP06 | 未开始 |
| WP-AOS-10 | Evidence-Gain Loop | Cycle Plan、Evidence Delta、No-Gain、Strategy Switch、Stop Controller | WP03、WP05—09 | 未开始 |
| WP-AOS-11 | Delivery Router | Delivery Contract、Adapter、Verification、Compensation | WP01、WP09、WP10 | 未开始 |
| WP-AOS-12 | Evidence & Outcome | Evidence Ledger、Outcome Recorder、Attribution、Calibration | WP10、WP11 | 未开始 |
| WP-AOS-13 | Memory Write Gate | Memory Candidate、Sensitivity、Retention、Write Decision | WP04、WP12 | 未开始 |
| WP-AOS-14 | Evolve v2 | Candidate、Replay、Promotion、Quarantine、Rollback | WP12、WP13 | 未开始 |
| WP-AOS-15 | ExecutionCoordinator | C01—C09 主链编排、ExecutionEnvelope Revision、Saga | WP02—14 Public Ports | 未开始；只能先建 Skeleton |
| WP-AOS-16 | Adapter / Shadow / Feature Flag | Engine v2 Adapter、Shadow Diff、灰度、回滚和 Legacy 删除 | WP15 与对应组件 | 未开始 |
| WP17A | Memory OS Protocol Contracts | 双仓 Schema、Golden、兼容矩阵 | WP01、WP04、WP13 | Issue #42 已登记 |
| WP17B | Memory OS Adapter & Governance | Grant、CAS、Outbox、Fail-closed、双仓发布 | WP17A、WP13、WP16 | 未开始 |
| WP-AOS-18 | Observability & Benchmark | Trace、Metrics、Token/Latency、Replay、Release Evidence | WP00；贯穿全程 | 部分完成，Issue #41 |
| WP-AOS-19 | Release & Legacy Removal | Release Candidate、迁移演练、回滚、Legacy 清零 | WP00—18 | 未开始 |

## 五、发布里程碑

### R0：Baseline — 已完成

范围：WP-AOS-00。

已完成：

- 三平台 CI；
- 140 项旧基线测试；
- Architecture Scan；
- Baseline Manifest；
- Dependency Manifest；
- CycloneDX SBOM；
- npm Audit Evidence；
- Legacy DB、Singleton、跨组件导入债务计数。

退出证据：PR #39 Squash Merge 到 `main`。

### R1：Contract Kernel — 当前阶段

范围：WP-AOS-01。

必须完成：

- Core Contract Surface；
- Canonical JSON 与 Stable Hash；
- Safe Integer、Schema ID、UTC 时间；
- Goal、Claim、Evidence、Receipt、Event、Authorization；
- Claim v2 → v3 Migration；
- 跨平台、跨语言 Golden Fixture；
- Contract Architecture Boundary。

退出条件：

1. PR #38 Base 为 `main`；
2. 精确 Head 在 Ubuntu Node 20/22 与 Windows Node 20 全部通过；
3. Diff 仅包含 Contracts、Tests、Fixtures；
4. 0 Architecture Blocking；
5. Squash Merge；
6. `main` Push CI 成功。

### R2：Trusted Decision Core

范围：WP-AOS-02—05。

目标：把原始输入转化为可信 Input、Intent、Goal、Claim 和 Context Manifest。

关键路径：

```text
WP02 Trusted Input
→ WP03 Intent & Goal
→ WP04 Claim Ledger
→ WP05 Context Planner
```

允许并行：WP03 的纯 Domain Contract 可与 WP04 Repository Port 并行；任何 Runtime 接入必须等待 WP02 Input Receipt。

退出条件：

- 外部 JSON 不再通过普通 `JSON.parse()` 直接进入权威对象；
- GoalSpec 由受信输入和 Task Profile 产生；
- Claim Source、Authority、Freshness、Permission 可追踪；
- Context Manifest 可重放；
- Engine v2 输入路径仍保持默认，Agent OS 路径处于 `shadow`。

### R3：Governed Execution Kernel

范围：WP-AOS-06—10、WP-AOS-18 的 Provider Benchmark 部分。

目标：形成 Policy、Skill、Model、Tool 与 Evidence Loop 的受控执行内核。

关键路径：

```text
WP06 Policy
→ WP07 Skill
→ WP08 Model Broker
→ WP09 Tool & Authorization
→ WP10 Evidence-Gain Loop
```

WP08 与 WP09 可在 Public Port 冻结后并行。WP10 必须等待两者均可由 Fake Adapter 确定性测试。

退出条件：

- Policy 与 Skill 分仓、分 Registry、分 Bundle；
- LlmRouter 不再承担 Context 和 Memory 写入权威；
- ToolRegistry 不再承担 Authorization 和执行全职责；
- Fake Model/Tool 可完成 Deterministic Loop；
- Evidence Delta、No-Gain、Budget 和 Stop Receipt 可重放；
- 所有外部副作用绑定 Authorization 与 Receipt。

### R4：Outcome & Memory Loop

范围：WP-AOS-11—14、WP17A。

关键路径：

```text
WP11 Delivery
→ WP12 Evidence & Outcome
→ WP13 Memory Write Gate
→ WP14 Evolve v2
```

WP17A 可在 WP01 合并后启动协议 Golden；与天枢运行集成必须等待 WP13。

退出条件：

- Delivery 成功、Evidence 成立、Outcome 有效三类状态分离；
- Memory 不再由 LLM Response 自动写入；
- Memory Candidate 具备 Source、Confirmation、Sensitivity、Retention；
- Evolve 只消费经过评测的 Correction、Outcome 与运行证据；
- Memory OS 双仓 Golden Hash 一致。

### R5：Shadow Beta

范围：WP-AOS-15、16、17B、18。

目标：建立 ExecutionCoordinator，并以 Shadow 方式与 Engine v2 对比。

执行顺序：

1. 建立 Composition Root 与 Coordinator Skeleton；
2. 每次只接入一个组件 Port；
3. Shadow 路径禁止外部副作用；
4. 记录 Input、Decision、Evidence、Delivery、Outcome Diff；
5. 达到阈值后单组件切换 `enforce`；
6. 保留一键回退 Engine v2。

退出条件：

- Shadow 样本达到 Release Runbook 规定数量；
- P0/P1 Diff 为 0；
- Goal、Policy、Authorization、Delivery、Memory 的 Unknown/Blocked 语义一致；
- 401/403、Grant 缺失、Protocol Incompatible 均 fail-closed；
- Windows/Linux Replay 一致；
- 回滚演练成功。

### R6：Production Candidate

范围：WP-AOS-19。

必须完成：

- Migration v11—v19 演练；
- 备份、恢复、前滚、回滚；
- 负载、Chaos、Security、SBOM、Audit；
- Token/Verified Evidence 和成本基线；
- Legacy DB Import、Singleton、Cross-component Import 清零或具有书面豁免；
- AgentLoop、LlmRouter、ToolRegistry、MemoryBackendRouter、EventStore、GoalManager 的权威职责完成迁移；
- Release Candidate Manifest。

## 六、关键路径与并行开发流

### 6.1 总关键路径

```text
WP00
→ WP01
→ WP02
→ WP03
→ WP04
→ WP05
→ WP06/07/08/09
→ WP10
→ WP11
→ WP12
→ WP13
→ WP14
→ WP15
→ WP16
→ WP19
```

### 6.2 可并行流

| 开发流 | 可并行区间 | 禁止事项 |
|---|---|---|
| Trust | WP02 与 WP06 Domain 设计 | WP06 不得绕过 Trusted Input Source |
| Context | WP04 Repository Port 与 WP03 Domain | Context Render 不得先于 Claim 权威规则 |
| Broker | WP08 与 WP09 | WP10 不得依赖具体 Provider/Tool 实现 |
| Memory OS | WP17A 与 WP02—09 | WP17B 运行集成不得早于 WP13 |
| Observability | WP18 贯穿全程 | 不得把真实 Provider 波动设为确定性 Gate |
| Migration | WP16 Adapter 可随组件逐步准备 | 同一阶段不得同时切换多个权威 Owner |

## 七、PR 与分支计划

### 7.1 PR 原则

- 一个有界模块一个 PR；
- 一个 PR 只允许一个权威数据 Owner；
- Runtime 主链变更与 Migration 不放在同一 PR；
- Schema/Migration 必须先于使用它的 Application PR；
- 每个 PR 必须有明确 Rollback；
- 每个 PR 必须声明 `0 | shadow | enforce`；
- 每个 PR 必须提供 Contract、Unit、Integration、Architecture Evidence；
- 默认 Squash Merge；
- 堆叠 PR 深度不超过 2。

### 7.2 推荐分支命名

```text
chore/aos-<wp>-<topic>
feat/aos-<wp>-<topic>
refactor/aos-<wp>-<topic>
test/aos-<wp>-<topic>
```

### 7.3 WIP 限制

- 最多 2 个开放代码 PR；
- 最多 1 个修改 Execution 主链的 PR；
- 最多 1 个未合并 Migration PR；
- 当前 PR 未形成可验证证据时，不开启下一关键路径 PR；
- 文档 PR 可以并行，但不得改变已冻结契约而不触发代码影响评估。

## 八、每个工作包的完成定义

一个 WP 只有同时满足以下条件才标记 Done：

1. Public Contract 已冻结；
2. Domain/Application/Port/Adapter 边界符合文档 20；
3. 数据 Owner 唯一；
4. Schema、Event、Receipt 和错误码一致；
5. Unit、Contract、Integration、Golden/Replay 测试通过；
6. Architecture Scan 无新增阻断；
7. Feature Flag 与 Rollback 明确；
8. CI Artifact 可追溯；
9. Issue 验收项全部勾选；
10. PR 已合并且 `main` CI 成功。

仅完成设计、仅提交代码、仅通过本地测试或仅关闭 Issue 均不构成 WP Done。

## 九、风险控制

### 9.1 P0 风险

- `MemoryBackendRouter` catch-all fallback 错误降级认证/协议失败；
- Legacy GoalManager 允许模型请求 `achieved`；
- AgentLoop 同时拥有 Goal、Model、Tool、Gate 和终态权威；
- ToolRegistry 同时承担 Catalog、Policy、Approval、Execution、Sandbox 与 Audit；
- EventStore 直接触发 Memory Write；
- 新旧 Migration Registry 分裂；
- 普通 `JSON.parse()` 静默覆盖重复 Key。

P0 风险必须绑定明确 WP 和删除条件，禁止以“Legacy”作为长期豁免理由。

### 9.2 进度风险

- 同时重构六个大型聚合类；
- 在 Public Port 未冻结前编写 Coordinator；
- 将 Shadow 与外部副作用放入同一路径；
- 为追求进度跳过 Golden、Replay 或 Windows 验证；
- 堆叠 PR 超过两层；
- 以真实模型性能波动替代确定性基准。

## 十、当前执行看板

截至 2026-07-26：

| 项目 | 状态 | 下一动作 |
|---|---|---|
| PR #39 / WP00 | **已 Squash Merge** | 观察 `main` Push CI |
| PR #38 / WP01 | Draft，堆叠 Base 已失效 | Base 切回 `main`，精确 Head 复验，Squash Merge |
| PR #25 / 文档体系 | Draft | 加入本文，完成术语一致性审查后合并 |
| WP02 / #40 | Ready to Start | 从 Duplicate-Key-Aware Parser 和 Input Receipt 开始 |
| WP08/18 / #41 | Planned | 等 WP01 后建立 Fake Provider Port |
| WP17A / #42 | Planned | WP01 合并后冻结跨仓 Fixture Version |
| #35 | Open | 按 WP 清零六个聚合点与架构债务 |
| #36 | Open | 作为总实施 Epic 跟踪 R0—R6 |

## 十一、最近三个执行动作

严格按以下顺序：

```text
1. PR #38 切回 main 并完成最终复验、Squash Merge
2. 更新 PR #25：加入总开发计划、当前代码状态和 R0/R1 结果
3. 启动 WP-AOS-02：Trusted Input Gateway，首个 PR 只做可信 JSON Parser + Input Contract/Receipt
```

WP-AOS-02 首个 PR 明确不包含 Intent Router、Goal Router、Claim Ledger 或 Runtime 主链切换。
