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
6. 迁移差异使用结构化 Diff Receipt，不依赖日志人工判断；
7. 安全、权限、协议不兼容场景保持 fail-closed；
8. Legacy Adapter 的删除使用独立 PR。

## 二、Flag 值语义

```text
0       仅 Engine v2 权威路径运行
shadow  Engine v2 权威；新路径计算并比较，不提交外部副作用
 en force  Agent OS 3.0 权威；Engine v2 可作为只读对照或回退入口
```

实现常量必须使用 `enforce`，配置解析时 trim 后严格校验，未知值启动失败。

## 三、配置权威与优先级

优先级：

```text
Execution 受控 Override
> 部署配置文件
> 环境变量
> 代码默认值
```

禁止来源：模型输出、Skill、外部文档、用户自然语言中的隐式指令、Memory Claim。

### 3.1 Flag Snapshot

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

已启动 Execution 不接受热更新。配置变化只影响新 Execution。L3/L4 恢复必须使用原 Snapshot；需要切换时创建新 Execution 或显式重启 Run。

## 四、Flag 清单

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

依赖校验：

| Flag | enforce 前置 |
|---|---|
| Intent | Input >= shadow |
| Context | Intent >= shadow、Claim v3 可用 |
| Policy/Skill | Intent enforce、Contracts enforce |
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

不满足依赖时启动失败并返回 `AOS_FLAG_DEPENDENCY_INVALID`。

## 五、Legacy Adapter 总表

| 老接口 | 新接口 | Adapter | 迁移策略 |
|---|---|---|---|
| `runL1(string)` | `ExecutionLoop.run(ExecutionContext)` | `LegacyL1Adapter` | 将字符串包装为 TrustedInput，保持返回类型 |
| `runL2(string)` | `GoalLoop.run(ExecutionEnvelope)` | `LegacyL2Adapter` | 将 Gate 结果映射为 GoalJudgement 输入 |
| `LlmRouter.chat()` | `ModelBroker.execute()` | `LegacyLlmRouterAdapter` | Provider 实例继续复用，路由由 Broker 接管 |
| `ToolRegistry.execute()` | `ToolBroker.execute()` | `LegacyToolRegistryAdapter` | Registry 仅负责实现发现，授权由 Broker 完成 |
| `compileAndRender()` | `ContextPlanner.plan()` | `LegacyMemoryContextAdapter` | Shadow 比较旧 prompt 与新 Manifest |
| `rememberResponse()` | `MemoryWriteGate.evaluate()` | `LegacyRememberAdapter` | 先双写候选观察，禁止重复长期写入 |
| `GoalManager.updateGoal()` | `GoalJudgeService.transition()` | `LegacyGoalManagerAdapter` | 禁止模型 Actor 直接 achieved |
| `events` 表 | `domain_events` | `LegacyEventProjectionAdapter` | 旧 Event 只读导入和对照 |

## 六、Adapter 设计

### 6.1 LegacyL1Adapter

```text
string input
→ Legacy InputEnvelope
→ Feature Flag Snapshot
→ Agent OS Execution Context
→ 新内层循环或旧 runL1
→ 结果映射为 AgentLoopResult
```

约束：

- 不改变现有 CLI 输出结构；
- 新 Receipt 写入失败时 shadow 不影响旧结果；
- enforce 下关键 Receipt 失败必须失败；
- Legacy Result 增加可选 `executionId`、`receiptIds`，不得删除旧字段。

### 6.2 LegacyL2Adapter

旧路径：

```text
L1 → typecheck/test/lint → reviewer → budget → achieved/retry
```

新路径：

```text
CyclePlan → L1 → Evidence → Gates → GoalJudge → strategy/pause/stop
```

Shadow 时旧 Gate 结果作为权威，新 GoalJudgement 只记录差异。enforce 时 GoalJudge 权威，旧 Gate 继续作为 Gate Adapter。

### 6.3 LegacyLlmRouterAdapter

迁移阶段分层：

1. Provider 实现继续由 `LlmRouter` 保存；
2. `ModelBroker` 生成 Route Plan；
3. Adapter 调用指定 Provider，关闭 Router 内部二次选择；
4. fallback 由 Broker 明确下发；
5. Route Receipt 记录 requested/selected/actual；
6. 最终将 Provider Registry 从 Router 抽出。

### 6.4 LegacyToolRegistryAdapter

- `ToolRegistry.toFunctionDefinitions()` 保留；
- Broker 使用 Tool Capability Manifest 选择 Tool；
- 调用前执行 Policy、Authorization、Cumulative Risk；
- Registry 不再接收 `approvedToolNames` 作为正式授权；
- `AWKN_APPROVED_TOOLS` 仅用于开发兼容；
- Tool Result 必须经过 Side-effect Verification。

### 6.5 LegacyMemoryContextAdapter

- 旧 `compileAndRender(query)` 继续生成旧 Prompt；
- 新 Context Planner 同时生成 Manifest；
- Shadow 不把新 Manifest 注入模型；
- 对比选中项、Token、敏感项、过期项、Receipt、Render；
- 健康空 Context 必须识别为有效结果，不能当作失败降级。

### 6.6 LegacyRememberAdapter

解决重复写入：

| 模式 | `rememberResponse()` | MemoryWriteGate |
|---|---|---|
| 0 | 正常写 | 不运行 |
| shadow | 正常写 | 只生成 Decision/Candidate，不提交 Backend |
| enforce | 禁止直接写 | Gate 决定并提交一次 Transaction |

enforce 下 `LlmRouter` 只发布 Interaction Event。任何代码绕过 Gate 调用 `rememberInteraction()` 应由测试和静态扫描阻断。

## 七、Shadow 执行模型

### 7.1 单输入双计算

```text
Trusted Input Snapshot
├── Authority Path
└── Shadow Path
       ↓
  Normalized Diff
```

两条路径共享：

- 输入 Snapshot；
- GoalSpec；
- Policy/Skill 版本；
- Capability Snapshot；
- 只读 Context Candidate Set；
- 固定随机种子可用时的种子；
- 时间基准和预算上限。

不共享：

- 可变消息数组；
- Tool side-effect state；
- Authorization consumption；
- Memory write；
- Delivery write；
- 临时推理草稿。

### 7.2 Shadow 外部副作用

冻结规则：Shadow 路径不得执行外部写入、发送、删除、购买、发布、计划任务创建或不可逆本地修改。

处理方式：

- 生成 PlannedAction；
- 执行 Policy/Authorization 模拟；
- 使用 DryRun Tool Adapter；
- 产出 Expected Side-effect Receipt；
- 与 Authority Path 的真实 Tool Receipt 比较。

只读工具可以调用，但需独立限流、缓存和数据权限。

## 八、差异模型

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

## 九、组件差异指标

### Input

- Redaction 项目差异；
- Actor/Project Scope 差异；
- Injection 风险差异；
- 文件存在与 Hash 差异。

### Intent/Goal

- L0—L4 分类；
- Clarification Decision；
- Required Acceptance；
- Loop Eligibility；
- 风险等级。

### Context

- Selected Claim ID；
- Source Authority；
- Freshness；
- Token；
- Sensitive Item；
- Empty Context 语义。

### Policy/Skill

- Selected/Rejected；
- 冲突结果；
- Bundle Hash；
- Required Gate；
- 禁止动作。

### Broker

- Provider/Model/Tool；
- fallback；
- Authorization；
- Risk；
- Side-effect Plan。

### Loop

- Expected Evidence；
- Gate；
- GoalJudgement；
- Cycle 数；
- No-Gain Stop；
- Token。

### Delivery/Outcome/Memory

- Primary Delivery；
- Partial/Failure；
- Outcome UNKNOWN；
- Memory Candidate；
- 写入/跳过原因；
- 重复写风险。

## 十、切换阈值

WP00 先生成真实基线，以下为 P0 默认阻断阈值：

| 指标 | enforce 条件 |
|---|---|
| 安全/权限回归 | 0 个 |
| 重复外部副作用 | 0 个 |
| Required Acceptance 假阳性 | 0 个 |
| 用户决定误归因 | 0 个 |
| 协议 401/403 被降级绕过 | 0 个 |
| 结构化任务语义一致率 | >= 98% |
| Golden Case 通过率 | 100% |
| P95 延迟回归 | <= 15% 或有批准例外 |
| Token/Verified Evidence 回归 | <= 20% |
| Shadow Unknown Diff | <= 1%，且无 P0/P1 |
| Replay Projection Mismatch | 0 个 |

安全、权限、外部副作用和 Goal 假阳性属于零容忍项，不能通过平均值抵消。

## 十一、灰度顺序

```text
Receipt/Event 基础
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

样本选择必须按 Task Profile、风险、平台和 Provider 分层。

## 十二、降级策略

### 12.1 允许降级

- Model Provider Transport/5xx，且 Capability 不降低关键验收；
- Memory OS Transport/5xx，`auto` 模式可使用 local stale fallback；
- 非关键 Observability 写入失败；
- Shadow 计算失败，Authority Path 正常。

### 12.2 禁止降级

- 401/403；
- Project Grant 缺失；
- Protocol incompatible；
- 输入身份或租户边界不确定；
- 高风险 Tool 缺授权；
- Authorization Token 过期、撤销或 Scope 不符；
- Canonical Hash/Schema 校验失败；
- 外部副作用状态未知；
- Required Evidence 缺失；
- Policy Conflict。

禁止降级场景统一 fail-closed，并输出诊断 Receipt。

## 十三、回滚操作

### 13.1 配置回滚

```text
AWKN_<COMPONENT>_V1=enforce
→ shadow
→ 0
```

回滚只影响新 Execution。运行中的 L3/L4 任务使用原 Snapshot，必要时暂停并创建恢复 Execution。

### 13.2 数据回滚

- 停止新写路径；
- 保留新表；
- 使用旧 Projection；
- 对已写入外部系统的数据执行补偿或 Tombstone；
- 禁止仅删除本地记录掩盖已发生副作用。

### 13.3 发布回滚

Release Manifest 必须包含：

- Commit SHA；
- Flag Defaults；
- Schema Version；
- Protocol Version；
- Artifact Hash；
- 上一稳定版本；
- 回滚命令和数据库兼容说明。

## 十四、诊断命令

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

诊断命令默认只读。

## 十五、Legacy 删除条件

Adapter 只有同时满足以下条件才可删除：

1. enforce 100% 达到两个发布周期；
2. 没有零容忍差异；
3. Windows/Linux 全绿；
4. Replay 一致；
5. 回滚演练成功；
6. 所有调用点静态扫描为 0；
7. 文档、CLI、环境变量已迁移；
8. 对应 Migration 已进入稳定支持窗口；
9. Release Owner 与接口 Owner 批准。

## 十六、测试

必须覆盖：

- Flag 未知值；
- Flag 依赖非法；
- Execution Snapshot 冻结；
- 运行中配置变化；
- Shadow 外部写入被阻断；
- Legacy/New 结果 Diff；
- `rememberResponse()` 重复写保护；
- 401/403 不降级；
- Provider 5xx 可控 fallback；
- Side-effect Unknown 禁止重试；
- enforce → shadow → 0 回滚；
- Adapter 删除前静态扫描。

## 十七、验收

- 任一组件可独立 Shadow；
- Shadow 不产生重复外部副作用；
- Flag 版本、来源、Snapshot 可追溯；
- enforce 失败可回到 Engine v2 安全路径；
- 禁止降级场景保持 fail-closed；
- `rememberResponse()` 迁移期间只产生一次正式写入；
- 所有 Legacy Adapter 有删除条件和调用点扫描；
- Shadow Diff 可被 CI 和 Release Gate 消费。