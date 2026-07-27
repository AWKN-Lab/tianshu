# 天枢 Agent OS 3.0 总开发计划

> 文档编号：TS-AOS-PLAN-021  
> 版本：v1.2  
> 日期：2026-07-27  
> 治理 Epic：Issue #43  
> 权威范围：`AWKN-Lab/tianshu` Agent OS 3.0 开发、迁移、测试、Shadow 与发布调度

## 一、计划目标

本文把产品 PRD、工程设计、组件金字塔和 WP-AOS-00—19 转化为可执行的发布顺序。

本计划回答：

1. 当前处于哪个发布里程碑；
2. 每个工作包的前置依赖；
3. 哪些工作允许并行；
4. 哪些 Gate 未满足时禁止开工或合并；
5. 每个阶段使用什么证据退出；
6. Engine v2、Mode `0`、Shadow、Enforce 与 Legacy Removal 如何切换。

代码合并只代表交付单元进入主线。工作包和发布里程碑必须分别判定。

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
   Foundation / Trust / Context / Governance
   Execution / Outcome / Memory / Migration / Release

L3 工作包
   WP-AOS-00—19、WP17A、WP17B

L4 交付单元
   Issue → 短分支 → Draft PR → Evidence → Review → Squash Merge
```

## 三、统一状态模型

所有工作包统一使用以下状态：

1. `DESIGNED`；
2. `CONTRACT_FROZEN`；
3. `IMPLEMENTED_MODE_0`；
4. `SHADOW_READY`；
5. `SHADOW_VALIDATED`；
6. `ENFORCED`；
7. `LEGACY_REMOVED`。

### 3.1 Mode `0`

- Feature Flag：`NOT_APPLICABLE`；
- Runtime Exposure：`NONE`；
- 不进入 Shadow Sample；
- Rollback：回退 Squash Commit，或停止导入 Public Contract；
- Mode `0` 合并不构成发布里程碑退出。

### 3.2 Shadow

- Engine v2 保持默认；
- Shadow 禁止真实外部副作用；
- Feature Flag 在 Execution 创建时冻结；
- 记录输入、决策、证据、交付和 Outcome Diff；
- P0/P1 Diff 未清零时禁止 Enforce。

### 3.3 Enforce

- 每次只切换一个权威 Owner；
- 同一 Execution 不混用新旧权威；
- 必须具备一键回退；
- Legacy 删除由 WP19 统一收口。

## 四、工作包调度表

| WP | 调度名称 | 主要交付 | 前置依赖 | Issue | 当前状态 |
|---|---|---|---|---:|---|
| WP-AOS-00 | Baseline & Architecture Gate | 三平台 CI、Architecture、Dependency、SBOM、Audit | 无 | #36 | **已完成** |
| WP-AOS-01 | Core Contracts | Canonical JSON、Stable Hash、核心 Contracts、Golden | WP00 | #37 | **已完成** |
| WP-AOS-02 | Trusted Input Gateway | Duplicate-Key Parser、Input Contract、Input Receipt | WP01 | #40 | `IMPLEMENTED_MODE_0` |
| WP-AOS-03 | Intent & Goal Router | Intent、L0—L4、Eligibility、Goal Factory、Goal Judge | WP01、WP02 | — | `IMPLEMENTED_MODE_0` |
| WP-AOS-04 | Claim Ledger | Resolver、Repository Port、双 Adapter、CAS、Replay、v12 | WP01、WP02 | #59 | `IMPLEMENTED_MODE_0` |
| WP-AOS-05 | Context Planner | Utility、Budget、Manifest、Immutable Render | WP04 | #61、#63 | 05A 已合并；05B `REVIEW_BLOCKED` |
| R2 Exit | Trusted Decision Shadow | WP02—05 Shadow、Diff、Replay、Exit Report | WP05B | #66 | 未开始 |
| WP-AOS-06 | Policy Compiler | Registry、Conflict Resolver、Compiled Bundle | WP01、WP02 | #67 | `DESIGNED` |
| WP-AOS-07 | Skill Compiler | Skill Registry、Capability、Bundle、Singleton 清理 | WP06 | #68 | `DESIGNED` |
| WP-AOS-08 | Model Broker | Provider Port、Routing、Fallback、Fake Provider | WP03、WP05 | #69、#41 | Spec 部分冻结 |
| WP-AOS-09 | Tool Broker | Catalog、Permission、Sandbox、Receipt | WP02、WP06 | #70 | `DESIGNED` |
| WP-AOS-10 | Evidence-Gain Loop | Evidence Delta、No-Gain、Budget、Stop | WP03、WP05—09 | #71 | `DESIGNED` |
| WP-AOS-11 | Delivery Router | Delivery、Verification、Retry、Compensation | WP09、WP10 | #72 | `DESIGNED` |
| WP-AOS-12 | Evidence & Outcome | Evidence Ledger、Outcome、Attribution | WP10、WP11 | #73 | `DESIGNED` |
| WP-AOS-13 | Memory Write Gate | Candidate、Sensitivity、Retention、Write Decision | WP04、WP12 | #74 | `DESIGNED` |
| WP-AOS-14 | Evolve v2 | Evaluation、Promotion、Quarantine、Rollback | WP12、WP13 | #75 | `DESIGNED` |
| WP-AOS-15 | ExecutionCoordinator | Composition Root、Execution CAS、Saga | WP02—14 Ports | #76 | `DESIGNED` |
| WP-AOS-16 | Adapter / Shadow / Flag | Engine v2 Adapter、Diff、Enforce、Rollback | WP15 | #77 | `DESIGNED` |
| WP17A | Memory OS Protocol | 双仓 Fixture、Manifest、兼容矩阵 | WP01 | #42 | `PROTOCOL_SPEC_FROZEN` |
| WP17B | Memory OS Adapter | Grant、CAS、Outbox、Fail-closed | WP17A、WP13、WP16 | #78 | `DESIGNED` |
| WP-AOS-18 | Observability | Trace、Metrics、Benchmark、Release Evidence | WP00，贯穿全程 | #79、#41 | Baseline 已有，完整实现未开始 |
| WP-AOS-19 | Release & Legacy Removal | RC、Migration 演练、回滚、Legacy 清零 | WP00—18 | #80 | `DESIGNED` |

## 五、发布里程碑

### R0：Baseline — 已完成

范围：WP-AOS-00。

完成证据：

- PR #39 Squash Merge；
- Ubuntu Node 20、Ubuntu Node 22、Windows Node 20；
- 140 项基线测试，0 fail；
- Architecture Scan；
- Baseline Manifest；
- Dependency Manifest；
- CycloneDX 1.5；
- npm Audit 0 已知漏洞；
- Issue #36 已关闭。

### R1：Contract Kernel — 已完成

范围：WP-AOS-01。

完成证据：

- PR #38 Squash Merge；
- `main@17cbda273aeed121f81f281ae9c7088e2565c00f`；
- 181 项测试，0 fail；
- Contract Diff 只包含 Contracts、Tests、Fixtures；
- Architecture Blocking = 0。

### R2：Trusted Decision Core — 当前阶段

范围：WP-AOS-02—05。

当前主线：

| 能力 | 状态 | 证据 |
|---|---|---|
| Trusted Input | 已进入 main | `main@20c52409` |
| Intent / Goal / Eligibility | 已进入 main | `main@22d5b54d` |
| Deterministic Goal Judge | 已进入 main | `main@a461e408` |
| Claim Resolution | 已进入 main | `main@7c33e7e6` |
| Claim Repository Port | 已进入 main | `main@d22e3cc7` |
| Migration Registry v1—v10 | 已进入 main | `main@769eb9f2` |
| Core Persistence v11 | 已进入 main | `main@d41539bb` |
| Claim SQLite v12 | 已进入 main | `main@df174845` |
| Context Manifest Planner | 已进入 main | `main@b5c9c401` |
| Immutable Context Render | PR #64 | run #128 已通过，语义 Review 未完成 |

当前 `main`：`b5c9c401057be0a2ca0900bbdc36c407185f932a`。  
当前 Migration：v12。  
PR #64：99 Unit + 177 Contract = 276 tests，0 fail。

R2 Exit 条件：

- [x] 原始 JSON 通过 Trusted Input 解析；
- [x] GoalSpec 由受信信号与 Task Profile 产生；
- [x] Claim Source、Authority、Freshness、Permission 可追踪；
- [x] Context Manifest 可重放；
- [ ] PR #64 完成语义 Review与必要修复；
- [ ] Context Manifest / Render v13 Persistence 决策；
- [ ] WP02—05 接入只读 Shadow；
- [ ] Engine v2 保持默认；
- [ ] Shadow 无外部副作用；
- [ ] Windows/Linux Replay 一致；
- [ ] R2 Exit Report。

当前判定：`COMPONENT_COMPLETE_PENDING_REVIEW / RELEASE_GATE_BLOCKED`。

### R3：Governed Execution Kernel

范围：WP06—10、WP18 Benchmark。

```text
WP06 Policy
├─→ WP07 Skill
└─→ WP09 Tool Broker

WP03 + WP05
└─→ WP08 Model Broker

WP06 + WP07 + WP08 + WP09
└─→ WP10 Evidence-Gain Loop
```

退出条件：

- Policy 与 Skill 独立 Registry、独立 Bundle；
- LlmRouter 不拥有 Context 与 Memory Write 权威；
- ToolRegistry 只保留 Catalog 兼容入口；
- Fake Model/Tool 完成确定性循环；
- Evidence Delta、No-Gain、Budget、Stop Receipt 可重放；
- 外部副作用绑定 Permission 与 Receipt。

### R4：Outcome & Memory Loop

范围：WP11—14、WP17A。

```text
WP11 Delivery
→ WP12 Evidence & Outcome
→ WP13 Memory Write Gate
→ WP14 Evolve v2
```

退出条件：

- Delivery、Evidence、Outcome 三类状态分离；
- LLM Response 不自动写长期 Memory；
- Memory Candidate 具备 Source、Confirmation、Sensitivity、Retention；
- Evolve 只消费经过评测的证据；
- Memory OS Fixture 与 Hash 协议一致。

### R5：Shadow Beta

范围：WP15、WP16、WP17B、WP18。

退出条件：

- ExecutionCoordinator 只通过 Public Ports 编排；
- Shadow 样本达到 Runbook 阈值；
- P0/P1 Diff = 0；
- 认证、Grant、协议错误 fail-closed；
- Windows/Linux Replay 一致；
- 回滚演练成功。

### R6：Production Candidate

范围：WP19。

退出条件：

- Migration v11—v19 全路径演练；
- Backup、Restore、Forward、Rollback；
- Load、Chaos、Security、SBOM、Audit；
- Token/Verified Evidence 与成本基线；
- Direct DB Import、Singleton、Cross-component Import 清零；
- 六个 Legacy 聚合类删除或只保留无权威兼容壳；
- Release Candidate Manifest 签发。

## 六、WIP 与 PR 规则

- 最多 2 个开放代码 PR；
- 最多 1 个修改 Execution 主链的 PR；
- 最多 1 个未合并 Migration PR；
- 堆叠 PR 深度不超过 2；
- 一个有界模块一个 PR；
- 一个 PR 只允许一个权威数据 Owner；
- Runtime 主链变更与 Migration 分 PR；
- Schema/Migration 先于使用它的 Application；
- 默认 Squash Merge；
- 每个 PR 声明 Mode、Rollback、Evidence；
- 文档 PR 不修改 `runtime/**` 时不运行 runtime-ci。

## 七、工作包完成定义

一个工作包标记 Done 前必须满足：

1. Public Contract 冻结；
2. Domain/Application/Port/Adapter 边界通过；
3. 数据 Owner 唯一；
4. Schema、Event、Receipt、Error 一致；
5. Unit、Contract、Integration、Golden/Replay 通过；
6. Architecture Scan 无新增阻断；
7. Mode、Feature Flag、Rollback 明确；
8. CI Artifact 可追溯；
9. Issue 验收项回填证据；
10. PR 已合并，精确 Head Evidence 成功。

仅完成设计、仅提交代码、仅关闭 Issue、仅通过本地测试均不构成 Done。

## 八、Legacy 架构债务

当前基线：

- Direct DB Import：20；
- Module-level Singleton：12；
- Cross-component Implementation Import：22；
- New Blocking Violation：0；
- Legacy Exception：1，删除责任 WP07。

六个大型聚合点：

| Legacy | 迁移责任 |
|---|---|
| AgentLoop | WP10、WP15、WP16、WP19 |
| LlmRouter | WP05、WP08、WP13、WP16 |
| ToolRegistry | WP06、WP09、WP16 |
| MemoryBackendRouter | WP05、WP13、WP17B、WP16 |
| EventStore | WP12、WP15、WP16 |
| GoalManager | WP03、WP15、WP16 |

Architecture Blocking = 0 只代表新核心没有增加同类阻断，不代表 Legacy Debt 已清零。

## 九、Benchmark 与 Memory OS 协议决策

### 9.1 Model Benchmark

Issue #41 已冻结：

- Fixture：`awkn-model-benchmark-fixtures/v1`；
- Seed：`1096239950`；
- Warmup 5，Measurement 30；
- 性能仅在同 Runner Class 比较；
- Token/Route/Failure/Hash 是确定性 Gate；
- Wall-clock 与真实 Provider Cost 是观察指标；
- 输出 Schema：`awkn-runtime-benchmark/v1`。

### 9.2 Memory OS Fixture Protocol

Issue #42 已冻结：

- Authority：`AWKN-Lab/tianshu`；
- Source Commit：`17cbda273aeed121f81f281ae9c7088e2565c00f`；
- Fixture Version：`tianshu-core-contracts-v1`；
- Manifest：`awkn-protocol-fixture-manifest/v1`；
- Memory OS 使用不可变 Vendor Copy；
- Hash 或协议不兼容必须 fail-closed。

## 十、Release Evidence Index

| 交付 | PR / Issue | 精确 Head / Merge | CI / Evidence | 状态 |
|---|---|---|---|---|
| WP00 Baseline | PR #39 / #36 | merge `f86506a4` | 三平台、140 tests、SBOM、Audit | Done |
| WP01 Contracts | PR #38 | merge `17cbda27` | 三平台、181 tests、Golden | Done |
| WP02 Trusted Input | PR #44 / #40 | merge `20c52409` | Duplicate Key、NFC、Limits、Receipt | Mode 0 |
| WP03 Intent/Goal | 多个短 PR | `5cc182e7`、`22d5b54d`、`a461e408` | Intent、Eligibility、Judge | Mode 0 |
| WP04 Claim | 多个短 PR / #59 | `7c33e7e6`、`d22e3cc7`、`df174845` | Resolver、Conformance、v12 | Mode 0 |
| Migration Registry | — | `769eb9f2`、`d41539bb` | v1—v12 | Done |
| WP05A Context | PR #62 / #61 | merge `b5c9c401` | Planner、Budget、Manifest | Mode 0 |
| WP05B Render | PR #64 / #63 | head `2d487c0f` | run #128，276 tests | Review Blocked |
| R2 Shadow | #66 | — | 尚未开始 | Blocked |
| Docs Baseline | PR #25 / #26 / #65 | 当前分支 | Docs-only | 本次收口 |

PR #64 Artifact：

- Ubuntu 20：`sha256:d34fe676f6d790a51f899021df22d824c375595f3e27e157fd7ebc9fd1f01b58`；
- Ubuntu 22：`sha256:1f6dccb0a891955c28fd50cfcce4167dce01e4ff98869bd5cb0cb23ee6cb18e6`；
- Windows 20：`sha256:d7fd498fa05e9a3579dca740bec1f15fdfe03a51d8c44749052b28ea0c4714f4`。

## 十一、术语与契约一致性清单

### 11.1 权威来源

- 已实现 Schema：`runtime/src/contracts/*.ts`；
- Public Surface：`runtime/src/contracts/public.ts`；
- 组件 Public Surface：各组件 `public.ts`；
- Migration 顺序：`runtime/src/store/agent-os-migration-registry.ts`；
- 文档不得覆盖代码中已发布的 Schema literal。

### 11.2 已核对的核心命名

| 领域 | 权威名称 / Schema | 状态 |
|---|---|---|
| Actor | `awkn-actor-ref/v1` | 已实现 |
| Execution Scope | `awkn-execution-scope/v1` | 已实现 |
| Object Ref | `awkn-object-ref/v1` | 已实现 |
| Context Manifest | `awkn-context-manifest/v1` | 已实现 |
| Context Render Input | `awkn-context-render-input/v1` | PR #64 |
| Immutable Context Render | `awkn-immutable-context-render/v1` | PR #64 |
| Protocol Fixture Manifest | `awkn-protocol-fixture-manifest/v1` | Spec Frozen |
| Runtime Benchmark | `awkn-runtime-benchmark/v1` | Spec Frozen |

### 11.3 统一状态术语

- Goal Verdict：以 Goal Judge Contract 为准；模型文本不能直接生成 `ACHIEVED`；
- Context：`READY | BLOCKED`；
- Work Package：使用本文件第三节状态模型；
- Mode：`0 | shadow | enforce`；
- Protocol Fixture：`ACTIVE | DEPRECATED | RETIRED`。

### 11.4 Event、Receipt、Error 规则

- 已实现 Event 名称以 `runtime/src/contracts/events.ts` 为准；
- Receipt Envelope 与已知 Payload 以 `receipts.ts` 为准；
- 结构化错误以 `errors.ts` 和模块公开 Error Union 为准；
- 新文档示例不得创建未登记 Error Code；
- 新 Event/Receipt/Error 必须先进入 Public Contract，再进入 Application。

### 11.5 已登记未解决项

PR #64 在合并前仍需语义决定：

1. `localeCompare()` 是否替换为 Unicode Code Point Comparator；
2. Immutable Render verify-on-read；
3. Section 唯一、Item 唯一、Section/Item 一致等跨字段不变量。

上述项目需要代码修改时必须重新运行 CI。本次文档收口不代替代码 Review。

## 十二、当前执行看板

| 项目 | 状态 | 下一动作 |
|---|---|---|
| R0 | Done | 持续证据归档 |
| R1 | Done | WP17A 使用 Golden |
| R2 Components | 接近完成 | PR #64 Review 与必要修复 |
| R2 Release Gate | Blocked | #66 Shadow Integration |
| Docs | 本次收口 | PR #25 Squash Merge |
| R3 | Issue Tree Ready | #67 WP06 Policy Compiler |
| Memory OS | Protocol Spec Frozen | #42 跨仓实现 |
| Benchmark | Spec Frozen | #41 / #69 / #79 实现 |

## 十三、最近执行顺序

```text
1. 完成 PR #64 语义 Review与必要代码修复
2. PR #64 Squash Merge并归档 main Evidence
3. 执行 #66 R2 Shadow Integration与Exit Review
4. 启动 #67 WP06 Policy Compiler
5. WP08与WP09在Public Port冻结后并行
```
