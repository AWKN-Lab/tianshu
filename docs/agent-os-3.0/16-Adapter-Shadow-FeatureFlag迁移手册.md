# Adapter、Shadow Mode 与 Feature Flag 迁移手册

> 文档编号：TS-AOS-MIGRATE-016  
> 版本：v1.0 Draft  
> 关联：PR #25、Issue #31、WP-AOS-19  
> 目标：Engine v2 向 Agent OS 3.0 增量迁移

## 一、迁移原则

1. Engine v2 在 RC 前持续可运行；
2. 新组件先作为旁路观察者，再进入主链；
3. Shadow 默认只读，不产生外部副作用；
4. 每个 Flag 独立启用、独立评估、独立回滚；
5. Feature Flag 在 Execution 创建时冻结；
6. 迁移差异使用结构化 Diff Receipt；
7. 安全、权限、协议不兼容场景保持 fail-closed；
8. Legacy Adapter 的删除使用独立 PR。

## 二、Flag 值与配置权威

```text
0        仅 Engine v2 权威路径运行
shadow   Engine v2 权威；新路径计算并比较，不提交外部副作用
enforce  Agent OS 3.0 权威；Engine v2 作为只读对照或回退入口
```

未知值启动失败。配置优先级：

```text
Execution 受控 Override
> 部署配置文件
> 环境变量
> 代码默认值
```

模型输出、Skill、外部文档、Memory Claim 均无权修改 Flag。

```ts
interface FeatureFlagSnapshot {
  schema: 'awkn-feature-flag-snapshot/v1';
  snapshotId: string;
  flags: Record<AgentOsFlag, '0' | 'shadow' | 'enforce'>;
  sourceVersions: Record<string, string>;
  sourceHash: string;
  frozenAt: string;
}
```

已启动 Execution 不接受热更新。L3/L4 恢复使用原 Snapshot；切换配置需要新 Execution 或显式重启 Run。

## 三、Flag 清单与依赖

```text
AWKN_INPUT_GATEWAY_V1
AWKN_INTENT_ROUTER_V1
AWKN_CONTEXT_PLANNER_V1
AWKN_POLICY_COMPILER_V1
AWKN_SKILL_COMPILER_V1
AWKN_MODEL_BROKER_V1
AWKN_TOOL_BROKER_V1
AWKN_CUMULATIVE_RISK_V1
AWKN_EVIDENCE_LOOP_V1
AWKN_DELIVERY_ROUTER_V1
AWKN_OUTCOME_V1
AWKN_MEMORY_WRITE_GATE_V1
AWKN_MEMORY_TRANSACTION_V2
AWKN_EVOLVE_V2
AWKN_RECEIPT_STORE_V1
AWKN_EVENT_STORE_V2
AWKN_MEMORY_PROTOCOL_VNEXT
```

| Flag | enforce 前置 |
|---|---|
| Intent | Input >= shadow |
| Context | Intent >= shadow、Claim v3 可用 |
| Policy/Skill | Intent、Contracts enforce |
| Model Broker | Policy >= shadow |
| Tool Broker | Input、Policy enforce |
| Cumulative Risk | Tool Broker enforce |
| Evidence Loop | Goal、Context、Skill、Broker enforce |
| Delivery | Tool Broker、Evidence Loop enforce |
| Outcome | Delivery enforce |
| Memory Write | Claim、Outcome enforce |
| Memory Transaction | Memory Write enforce |
| Evolve | Policy/Skill、Evidence、Outcome enforce |
| Memory Protocol vNext | Contracts、Context、Memory Transaction enforce |

依赖不满足返回 `AOS_FLAG_DEPENDENCY_INVALID`。

## 四、Legacy Adapter 总表

| 老接口 | 新接口 | Adapter | 迁移策略 |
|---|---|---|---|
| `runL1(string)` | `ExecutionLoop.run(ExecutionContext)` | `LegacyL1Adapter` | 字符串包装为 TrustedInput，保持返回类型 |
| `runL2(string)` | `GoalLoop.run(ExecutionEnvelope)` | `LegacyL2Adapter` | Gate 结果映射为 GoalJudgement 输入 |
| `LlmRouter.chat()` | `ModelBroker.execute()` | `LegacyLlmRouterAdapter` | Provider 实现继续复用，Broker 接管路由 |
| `ToolRegistry.execute()` | `ToolBroker.execute()` | `LegacyToolRegistryAdapter` | Registry 负责实现发现，Broker 负责授权 |
| `compileAndRender()` | `ContextPlanner.plan()` | `LegacyMemoryContextAdapter` | Shadow 比较旧 Prompt 与新 Manifest |
| `rememberResponse()` | `MemoryWriteGate.evaluate()` | `LegacyRememberAdapter` | Shadow 只产候选，enforce 只写一次 |
| `GoalManager.updateGoal()` | `GoalJudgeService.transition()` | `LegacyGoalManagerAdapter` | 禁止模型 Actor 直接 achieved |
| `events` | `domain_events` | `LegacyEventProjectionAdapter` | 旧 Event 只读导入和对照 |

## 五、Adapter 设计

### 5.1 LegacyL1Adapter

```text
string input
→ Legacy InputEnvelope
→ Feature Flag Snapshot
→ Agent OS Execution Context
→ 新内层循环或旧 runL1
→ AgentLoopResult
```

- 不删除现有返回字段；
- 可增加 `executionId`、`receiptIds`；
- shadow Receipt 失败不影响旧结果；
- enforce 关键 Receipt 失败必须失败。

### 5.2 LegacyL2Adapter

旧路径：

```text
L1 → typecheck/test/lint → reviewer → budget → achieved/retry
```

新路径：

```text
CyclePlan → L1 → Evidence → Gates → GoalJudge → strategy/pause/stop
```

shadow 以旧 Gate 路径为权威，新 GoalJudgement 只记录差异。enforce 以 GoalJudge 为权威，旧 Gate 继续作为 Gate Adapter。

### 5.3 LegacyLlmRouterAdapter

1. Provider 实现暂留 `LlmRouter`；
2. `ModelBroker` 生成 Route Plan；
3. Adapter 调用指定 Provider，关闭 Router 二次选择；
4. fallback 由 Broker 明确下发；
5. Route Receipt 记录 requested/selected/actual；
6. 最终将 Provider Registry 从 Router 抽出。

### 5.4 LegacyToolRegistryAdapter

- `toFunctionDefinitions()` 保留；
- Broker 使用 Capability Manifest；
- 调用前执行 Policy、Authorization、Cumulative Risk；
- `approvedToolNames` 和 `AWKN_APPROVED_TOOLS` 仅作开发兼容；
- Tool Result 必须经过 Side-effect Verification。

### 5.5 LegacyMemoryContextAdapter

- 旧 `compileAndRender(query)` 继续生成旧 Prompt；
- Context Planner 同时生成 Manifest；
- shadow 不把新 Manifest 注入模型；
- 比较选中项、Token、敏感项、过期项、Receipt、Render；
- 健康空 Context 是有效结果，不触发失败降级。

### 5.6 LegacyRememberAdapter

| 模式 | `rememberResponse()` | MemoryWriteGate |
|---|---|---|
| 0 | 正常写 | 不运行 |
| shadow | 正常写 | 只生成 Decision/Candidate |
| enforce | 禁止直接写 | Gate 提交一次 Transaction |

enforce 下 `LlmRouter` 只发布 Interaction Event。静态扫描必须阻断绕过 Gate 的 `rememberInteraction()` 调用。

## 六、Shadow 执行模型

```text
Trusted Input Snapshot
├── Authority Path
└── Shadow Path
       ↓
  Normalized Diff
```

共享：输入 Snapshot、GoalSpec、Policy/Skill 版本、Capability Snapshot、只读 Context Candidate Set、时间基准和预算。

隔离：可变消息、Tool 副作用状态、Authorization consumption、Memory write、Delivery write、临时推理草稿。

### 6.1 外部副作用

Shadow 禁止：外部写入、发送、删除、购买、发布、创建计划任务和不可逆本地修改。

Shadow 只生成 PlannedAction、模拟 Policy/Authorization、调用 DryRun Adapter、产出 Expected Side-effect Receipt。只读工具可调用，但必须独立限流、缓存和权限。

## 七、Shadow Diff

```ts
interface ShadowDiffReceipt {
  schema: 'awkn-shadow-diff-receipt/v1';
  executionId: string;
  component: string;
  authorityVersion: string;
  shadowVersion: string;
  semanticDiff: DiffItem[];
  safetyDiff: DiffItem[];
  sideEffectDiff: DiffItem[];
  performanceDiff: MetricDiff[];
  evidenceDiff: DiffItem[];
  verdict: 'MATCH' | 'ACCEPTABLE' | 'BLOCKING';
  evaluatorVersion: string;
  createdAt: string;
}
```

差异分类：

```text
EXACT
SEMANTIC_EQUIVALENT
EXPECTED_IMPROVEMENT
EXPECTED_DEGRADATION
SAFETY_REGRESSION
AUTHORIZATION_REGRESSION
SIDE_EFFECT_MISMATCH
EVIDENCE_MISMATCH
PERFORMANCE_REGRESSION
UNKNOWN
```

### 7.1 组件指标

- Input：Redaction、Scope、Injection、文件 Hash；
- Intent/Goal：L0—L4、Clarification、Acceptance、Loop Eligibility、Risk；
- Context：Claim、Authority、Freshness、Token、Sensitive、Empty Context；
- Policy/Skill：Selected/Rejected、Conflict、Bundle Hash、Gate；
- Broker：Provider、Model、Tool、fallback、Authorization、Side-effect Plan；
- Loop：Expected Evidence、Gate、GoalJudgement、Cycle、No-Gain、Token；
- Delivery/Outcome/Memory：Primary Delivery、Partial、UNKNOWN、Candidate、重复写。

## 八、切换阈值

| 指标 | enforce 条件 |
|---|---|
| 安全/权限回归 | 0 个 |
| 重复外部副作用 | 0 个 |
| Required Acceptance 假阳性 | 0 个 |
| 用户决定误归因 | 0 个 |
| 401/403 降级绕过 | 0 个 |
| 结构化任务语义一致率 | >= 98% |
| Golden Case 通过率 | 100% |
| P95 延迟回归 | <= 15% 或批准例外 |
| Token/Verified Evidence 回归 | <= 20% |
| Shadow Unknown Diff | <= 1%，且无 P0/P1 |
| Replay Projection Mismatch | 0 个 |

零容忍项不能通过平均值抵消。WP00 完成后可版本化调整非安全阈值。

## 九、灰度顺序

```text
Receipt/Event
→ Input
→ Intent/Goal
→ Claim/Context
→ Policy/Skill
→ Model Broker
→ Tool Broker/Authorization
→ Evidence Loop
→ Delivery
→ Outcome
→ Memory Write
→ Evolve
→ Memory Protocol vNext
```

每个组件：

```text
0
→ shadow 5%
→ shadow 25%
→ shadow 100%
→ enforce 5%
→ enforce 25%
→ enforce 100%
→ Legacy 删除评审
```

样本按 Task Profile、Risk、Platform、Provider 分层。

## 十、降级策略

### 10.1 允许

- Provider Transport/5xx，且 fallback 满足 Required Capability；
- Memory OS Transport/5xx，auto 使用 local stale fallback；
- 非关键 Observability 写入失败；
- Shadow 计算失败且 Authority Path 正常。

### 10.2 禁止

- 401/403；
- Project Grant 缺失；
- Protocol/Schema incompatible；
- 身份或租户边界不确定；
- 高风险 Tool 缺授权；
- Authorization 过期、撤销、Scope 不符；
- Canonical Hash/Schema 失败；
- 外部副作用状态未知；
- Required Evidence 缺失；
- Policy Conflict。

禁止降级场景 fail-closed，并生成诊断 Receipt。

## 十一、回滚

### Flag

```text
enforce → shadow → 0
```

只影响新 Execution。运行中的 L3/L4 使用原 Snapshot，必要时暂停并创建恢复 Execution。

### 数据

- 停止新写路径；
- 保留新表和 Event；
- 使用旧 Projection；
- 对外部写入执行补偿或 Tombstone；
- 禁止删除本地记录掩盖已发生副作用。

### 发布

Release Manifest 保存 Commit、Flag Defaults、Schema、Protocol、Artifact Hash、上一稳定版本和回滚命令。

## 十二、诊断命令

```text
awkn flags show --execution <id>
awkn shadow report --component <name> --since <time>
awkn shadow explain --execution <id>
awkn adapter status
awkn side-effect verify --execution <id>
awkn memory duplicate-scan
awkn replay verify --execution <id>
awkn rollback check --target <release>
```

## 十三、Legacy 删除条件

1. enforce 100% 达到两个发布周期；
2. 零容忍差异为 0；
3. Windows/Linux 全绿；
4. Replay 一致；
5. 回滚演练成功；
6. 调用点静态扫描为 0；
7. 文档、CLI、环境变量迁移完成；
8. Schema 进入稳定支持窗口；
9. Release Owner 与接口 Owner 批准。

## 十四、测试与验收

测试：未知 Flag、依赖非法、Snapshot 冻结、运行中配置变化、Shadow 写入阻断、Legacy/New Diff、Memory 重复写、401/403、Provider 5xx、Side-effect Unknown、回滚和 Adapter 调用点扫描。

验收：

- 任一组件可独立 Shadow；
- Shadow 不产生重复外部副作用；
- Flag 版本、来源、Snapshot 可追溯；
- enforce 失败可回到 Engine v2 安全路径；
- 禁止降级场景保持 fail-closed；
- Memory 迁移期间只产生一次正式写入；
- Legacy Adapter 有明确删除条件；
- Shadow Diff 可被 CI 和 Release Gate 消费。