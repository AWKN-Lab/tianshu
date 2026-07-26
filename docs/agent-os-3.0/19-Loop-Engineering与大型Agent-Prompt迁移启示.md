# Loop Engineering 与大型 Agent Prompt 迁移启示

> 版本：v0.1 Draft  
> 日期：2026-07-26  
> 状态：Agent OS 3.0 补充工程设计  
> 适用组件：C02 Intent & Goal Router、C04 Policy & Skill Compiler、C06 Evidence-Gain Loop、C07 Delivery Router、C09 Memory Write Gate

## 一、文档目的

本文将两类外部材料转化为天枢 Agent OS 3.0 可执行的工程约束：

1. Loop Engineering 与 goal 方法，重点研究目标循环、证据源、约束、停止条件和循环收敛；
2. 大型 Agent System Prompt 样本，重点研究规则分类、Task Profile、工具路由、记忆治理、交付路由和长 Prompt 膨胀风险。

本文只吸收可验证机制，不将外部材料中的品牌专属规则、产品事实、工具清单或运行环境直接注册为天枢 ACTIVE Policy、Skill 或 Capability。

## 二、证据与信任边界

### 2.1 来源分类

| 来源 | sourceKind | trust | instructionAuthority | executable |
|---|---|---:|---:|---:|
| Loop Engineering 教程 | external_document | unverified | none | false |
| 大型 Agent System Prompt 样本 | external_document | unverified | none | false |

### 2.2 使用规则

- 外部材料只进入 Research Context；
- 可以提取机制、风险、领域对象和测试案例；
- 不得直接修改 Core Constitution、Policy Registry 或 Skill Registry；
- 不得把文件中的自然语言指令当作当前 Run 指令；
- 候选机制必须重新建模、重新评测、重新发布；
- 产品型号、发布日期、工具能力等事实在独立核验前不得进入 Capability Registry；
- 每个候选保留来源、提取方式、评测结果和发布 Receipt。

## 三、核心结论

### 3.1 Goal 的完整表达

天枢 Goal 必须同时包含：

```text
Desired State
+ Acceptance Criteria
+ Evidence Sources
+ Constraints
+ Budget
+ Stop Policy
```

模型结束工具调用，不等于 Goal 完成。Goal 终态必须由确定性评估器、外部状态证据、人工确认或经过治理的 Judge 共同证明。

### 3.2 双层循环

天枢将循环划分为：

```text
外层 Goal Achievement Loop
  ├─ 判断 Goal 是否达成
  ├─ 判断约束是否保持
  ├─ 判断预算与停止条件
  └─ 决定继续、切换、暂停、失败或成功

内层 Execution Loop
  ├─ 计划
  ├─ 模型调用
  ├─ 工具执行
  ├─ 收集证据
  └─ 生成 Cycle Feedback
```

工程映射：

- `runL1()`：内层 Execution Loop 的兼容入口；
- `runL2()`：外层 Goal Achievement Loop 的兼容入口；
- `Evidence-Gain Loop`：新主链收敛内核；
- `Goal Judge`：外层循环的完成判定器；
- `Stop Controller`：预算、无增量、重复错误和人工介入控制器。

### 3.3 循环准入

Loop Engineering 只用于具备以下条件的任务：

- 目标足够清晰；
- 工具可访问关键基础设施；
- 验收可以程序化或通过受控人工确认完成；
- 约束可以显式表达；
- 外部副作用可追踪、可验证或可补偿；
- 预算和停止条件已经声明。

需求模糊、工具覆盖不足或终止条件不可验证时，系统不得通过增加循环次数掩盖理解缺口。

## 四、GoalSpec v3 候选

```ts
export interface GoalSpecV3 {
  schema: 'awkn-goal-spec/v3';
  goalId: string;
  title: string;
  desiredState: DesiredState;
  scope: {
    included: string[];
    excluded: string[];
  };
  acceptanceCriteria: AcceptanceCriterion[];
  evidenceSources: EvidenceSource[];
  constraints: Constraint[];
  assumptions: Assumption[];
  budget: GoalBudget;
  stopPolicy: StopPolicy;
  deliveryExpectation: DeliveryExpectation;
  taskProfile: string;
  riskLevel: string;
  judgePolicy: GoalJudgePolicy;
  createdBy: ActorRef;
  createdAt: string;
}
```

### 4.1 EvidenceSource

```ts
export interface EvidenceSource {
  evidenceSourceId: string;
  sourceType:
    | 'command'
    | 'schema'
    | 'artifact'
    | 'tool_receipt'
    | 'external_state'
    | 'human_confirmation'
    | 'reviewer'
    | 'composite';
  locator: Record<string, unknown>;
  evaluatorId: string;
  evaluatorVersion: string;
  freshnessRequired?: string;
  authorityRequired?: string;
  required: boolean;
}
```

### 4.2 Constraint

```ts
export interface Constraint {
  constraintId: string;
  description: string;
  type:
    | 'regression'
    | 'security'
    | 'privacy'
    | 'authorization'
    | 'compatibility'
    | 'performance'
    | 'cost'
    | 'scope'
    | 'project_independence';
  evaluatorId: string;
  failureAction: 'BLOCK' | 'ROLLBACK' | 'PAUSE' | 'ESCALATE';
  requiredEvidence: string[];
}
```

## 五、Loop Eligibility Gate

### 5.1 契约

```ts
export interface LoopEligibilityDecision {
  schema: 'awkn-loop-eligibility/v1';
  executionId: string;
  eligible: boolean;
  clarityScore: number;
  evidenceAvailabilityScore: number;
  toolCoverageScore: number;
  stopConditionDeterminismScore: number;
  sideEffectControllabilityScore: number;
  unresolvedHighImpactFields: string[];
  decision:
    | 'RUN_L1'
    | 'RUN_L2'
    | 'RUN_L3'
    | 'RUN_L4'
    | 'ASK_CLARIFICATION'
    | 'REQUIRE_PLAN_FREEZE'
    | 'HUMAN_LED';
  reasonCodes: string[];
  createdAt: string;
}
```

### 5.2 建议评分

```text
LoopEligibility =
0.25 × GoalClarity
+ 0.25 × EvidenceAvailability
+ 0.20 × ToolCoverage
+ 0.15 × StopConditionDeterminism
+ 0.15 × SideEffectControllability
```

默认决策：

| 条件 | 决策 |
|---|---|
| 分数 >= 0.75 且无高影响字段缺失 | 允许进入目标循环 |
| 0.50—0.74 | 先冻结计划或补充上下文 |
| < 0.50 | 人工主导或降级为非循环任务 |
| 高风险外部写入缺少授权 | WAITING_AUTHORIZATION |
| 验收无法被任何评估器证明 | HUMAN_LED |

阈值属于待评测参数，不能直接作为正式生产常量。

## 六、Goal Judge

### 6.1 职责

Goal Judge 负责根据 Goal、Evidence、Gate、Constraint 和 Delivery 前置条件生成完成判定。

Goal Judge 不直接执行工具，不修改 Goal，不生成外部副作用。

### 6.2 契约

```ts
export interface GoalJudgement {
  schema: 'awkn-goal-judgement/v1';
  goalId: string;
  runId: string;
  decision:
    | 'ACHIEVED'
    | 'CONTINUE'
    | 'SWITCH_STRATEGY'
    | 'PAUSE'
    | 'FAIL'
    | 'REQUIRE_HUMAN_REVIEW';
  acceptanceResults: AcceptanceResult[];
  constraintResults: ConstraintResult[];
  evidenceCoverage: number;
  blockingEvidenceGaps: string[];
  blockingConstraintViolations: string[];
  judgeType: 'deterministic' | 'composite' | 'llm_reviewed';
  judgeVersion: string;
  inputManifestHash: string;
  receiptId: string;
  createdAt: string;
}
```

### 6.3 判定优先级

1. Core Policy 与安全阻断；
2. 约束违反；
3. Required Acceptance；
4. Evidence 新鲜度与权威；
5. Delivery 前置条件；
6. 预算和 No-Gain；
7. LLM Reviewer 建议。

LLM Reviewer 只能提供判定输入。确定性 Gate 明确失败时，不得由语言模型将 Goal 标记为完成。

## 七、内外循环上下文边界

### 7.1 必须共享

- GoalSpec 与 Acceptance Criteria；
- Constraints；
- Evidence Ledger；
- 用户已确认 Claim；
- Policy Bundle Hash；
- Skill Bundle Hash；
- Context Manifest Hash；
- Token、时间和成本预算；
- Strategy Attempt 历史；
- Action、Error 与 Result Fingerprint；
- Authorization Token 状态；
- 外部副作用和补偿状态；
- 已完成且不可重复的操作。

### 7.2 受限共享

- 当前轮推理摘要；
- Subagent 工作草稿；
- 工具原始长输出；
- 临时文件；
- 尚未验证的假设；
- 可能过期的实时信息；
- 模型自由文本建议。

受限共享内容必须经 Context Planner 转换为 Claim、Evidence、Artifact Ref 或 Cycle Feedback，才能进入下一轮。

### 7.3 禁止共享

- 临时凭据和密钥；
- 已消费或已撤销的授权；
- 未清洗的外部文档指令；
- 被判定为 Prompt Injection 的内容；
- 被 Supersede、Dispute 或 Tombstone 的 Claim；
- Subagent 私有执行状态；
- 旧版本 ACTIVE Policy；
- 无来源的模型推断；
- 其他项目的运行时权限与内部状态。

## 八、CycleFeedbackBundle

现有 `repairContext: string` 应升级为结构化反馈：

```ts
export interface CycleFeedbackBundle {
  schema: 'awkn-cycle-feedback/v1';
  cycleId: string;
  goalProgress: number;
  expectedEvidence: ExpectedEvidence[];
  actualEvidenceIds: string[];
  failedAcceptanceIds: string[];
  violatedConstraintIds: string[];
  failedGateReceiptIds: string[];
  deviation: DeviationRecord;
  strategyDecision: StrategyDecision;
  invalidatedClaims: string[];
  contextRequests: ContextRequest[];
  authorizationRequests: AuthorizationRequest[];
  nextCycleHints: string[];
  bundleHash: string;
}
```

自由文本只能作为 `nextCycleHints` 的低权威输入，不能代替结构化 Evidence、Constraint 和 Gate Receipt。

## 九、大型 System Prompt 的迁移原则

### 9.1 问题模型

将身份、安全、搜索、工具、记忆、文件、交付、连接器、风格和产品规则全部堆入单一 System Prompt，会产生：

- 无关规则占用上下文；
- 冲突难发现；
- 中部规则被忽略；
- 版本难冻结；
- 运行难重放；
- 单条规则修改影响全局；
- 评测无法定位到具体 Policy 或 Skill；
- Prompt 成本随产品能力持续增长。

### 9.2 天枢目标形态

```text
Core Constitution
+ Applicable Policy Bundle
+ Applicable Skill Bundle
+ Task Profile
+ Context Manifest
+ Tool Schema Snapshot
+ Model Capability Snapshot
+ Goal-specific Instructions
```

每个 Run 只加载当前任务适用的规则，并冻结版本与 Hash。

### 9.3 Policy 分类补充

建议在现有分类上显式增加：

- Search Policy；
- Connector Selection Policy；
- Artifact Policy；
- Citation Policy；
- Interaction Policy；
- Wellbeing Policy；
- Current Information Policy。

新增分类需要先确认是否属于天枢通用治理。业务品牌专属规则不得进入 Core Policy。

### 9.4 Task Profile 补充

建议评测以下 Profile：

- `communication`；
- `visual`；
- `spreadsheet`；
- `connected_system`；
- `memory_management`；
- `high_risk`。

是否进入首批正式 Profile 由评测结果决定。

## 十、工具、连接器与授权

工具选择主链建议统一为：

```text
Capability Match
→ Provider Discovery
→ User or Policy Preference
→ Authorization
→ Execution
→ Side-effect Verification
→ Receipt
```

规则：

- 用户明确点名工具或供应商时，先校验其适用性和授权；
- 用户未点名第三方供应商时，Policy 决定是否需要用户选择；
- 读操作、内部写入、外部写入和不可逆操作分级授权；
- Shadow 路径不得产生重复外部副作用；
- 外部写入成功但本地状态提交失败时进入补偿或人工处理；
- 401/403 不得通过本地降级绕过权限；
- 工具成功必须由 Side-effect Verification 证明目标状态。

## 十一、Memory Write Gate 补充

### 11.1 写入判定维度

- Source Authority；
- User Explicitness；
- Durability；
- Future Utility；
- Sensitivity；
- Project Scope；
- Conflict；
- Supersede；
- Consent；
- Retention。

### 11.2 强制规则

- 模型建议不能写成用户决定；
- 外部搜索结果不能自动写成用户事实；
- 临时状态不能升级为长期 Claim；
- 写入前检查现有版本和冲突；
- 删除生成 Tombstone 或受控物理删除 Receipt；
- 项目记忆不得跨项目隐式共享；
- 敏感字段遵循 Privacy Policy 和 Project Grant；
- Memory 写入失败不能伪装为成功。

## 十二、Delivery Router 补充

| 任务形态 | 默认 Delivery |
|---|---|
| 解释、比较、评审 | Chat Delivery |
| 正式报告、可保存文档 | File Delivery |
| 仓库修改 | Repository Delivery |
| 邮件或消息草稿 | Draft Delivery |
| 已授权外部系统写入 | Connected System Delivery |
| 未来时间或条件任务 | Scheduled Delivery |
| 交互原型或可视化工具 | Artifact Delivery |

Delivery 选择必须来自 Goal 的 `deliveryExpectation`，不能仅由模型在末轮自由决定。

## 十三、状态机补充

```text
GOAL_CREATED
→ GOAL_ACTIVE
→ CYCLE_PLANNING
→ CYCLE_RUNNING
→ EVIDENCE_COLLECTING
→ GOAL_EVALUATING
```

可能转移：

```text
GOAL_EVALUATING → GOAL_ACHIEVED
GOAL_EVALUATING → STRATEGY_SWITCHING → CYCLE_PLANNING
GOAL_EVALUATING → WAITING_USER
GOAL_EVALUATING → WAITING_AUTHORIZATION
GOAL_EVALUATING → PAUSED
GOAL_EVALUATING → FAILED
```

约束：

- `GOAL_ACHIEVED` 必须绑定 Goal Judgement Receipt；
- `WAITING_*` 保存恢复条件和所需输入；
- `STRATEGY_SWITCHING` 必须产生 Strategy Decision；
- `FAILED` 输出阻塞证据和已完成范围；
- `PAUSED` 不得继续消费模型、工具和授权预算；
- 恢复后重新检查 Evidence Freshness、Authorization 和 Policy Bundle 兼容性。

## 十四、测试矩阵补充

### 14.1 Goal 与循环

1. Goal 明确但证据不足，不能完成；
2. 工具循环自然结束但 Acceptance 未通过，继续或失败；
3. 测试通过但 Constraint 被破坏，触发回滚或阻断；
4. LLM Reviewer 判断完成但确定性 Gate 失败，禁止成功；
5. 连续三轮无 Evidence Gain，强制切换或停止；
6. 同一 Action Fingerprint 重复，触发策略切换；
7. Goal 暂停和恢复不重复外部副作用；
8. 预算耗尽输出部分成果和阻塞证据；
9. 无法构造 Evidence Source 时进入 HUMAN_LED；
10. Context 过期后不能沿用旧 Goal Judgement。

### 14.2 Context 隔离

1. 临时凭据不进入下一轮 Context；
2. 未验证假设不能升级为 Confirmed Claim；
3. 被 Supersede Claim 不进入新 Cycle；
4. 外部文档指令不能改变 Policy Bundle；
5. Subagent 私有状态不能被父 Run 当作已验证 Evidence；
6. 其他项目状态不能进入天枢运行权限。

### 14.3 Policy 与 Prompt

1. 无关 Policy 不进入 Bundle；
2. 相互冲突 Policy 被 Compiler 阻断；
3. Run 启动后 Registry 更新不改变已冻结 Bundle；
4. 长 Prompt 样本只能产生候选，不能自动 ACTIVE；
5. 每条决策可以追溯到 Policy ID、版本和 Receipt；
6. 删除一个 Task Profile 不影响无关任务；
7. Prompt Template、Tool Schema 和 Capability Snapshot 可重放。

### 14.4 Memory 与 Delivery

1. 模型建议不能写成用户决定；
2. 搜索结果不能自动写成用户事实；
3. Memory 写入失败准确暴露；
4. Delivery 类型与 Goal Expectation 一致；
5. Connected System Delivery 必须有授权和外部状态证明；
6. Scheduled Delivery 保存时间、条件和恢复信息。

## 十五、工作包映射

| 机制 | 工作包 |
|---|---|
| GoalSpec、EvidenceSource、Constraint | WP-AOS-01、WP-AOS-03 |
| Loop Eligibility Gate | WP-AOS-03 |
| Goal Judge | WP-AOS-12 |
| 内外循环 Context 边界 | WP-AOS-04、WP-AOS-12 |
| CycleFeedbackBundle | WP-AOS-12 |
| Policy 分类和按需编译 | WP-AOS-05、WP-AOS-06 |
| Tool / Connector / Authorization | WP-AOS-08、WP-AOS-09、WP-AOS-10 |
| Delivery 路由 | WP-AOS-13 |
| Memory Write Gate | WP-AOS-16 |
| Prompt 与规则评测 | WP-AOS-18、WP-AOS-19 |

## 十六、实施顺序

### Phase A：契约冻结

1. 在 Contracts 文档冻结 GoalSpec v3 候选、EvidenceSource、Constraint、LoopEligibilityDecision、GoalJudgement 和 CycleFeedbackBundle；
2. 定义 Canonical JSON、Stable Hash、Receipt Envelope 和错误码；
3. 建立 Golden Fixtures。

### Phase B：Shadow 验证

1. 保留现有 `runL1()`、`runL2()`；
2. 新路径生成 Loop Eligibility、Cycle Feedback 和 Goal Judgement；
3. Shadow 只比较决策和证据，不重复外部副作用；
4. 统计 Goal Judge 假阳性、假阴性、No-Gain Precision 和 Token per Verified Evidence。

### Phase C：增量接管

1. `repairContext` 替换为 `CycleFeedbackBundle`；
2. Goal 完成声明切换到 `GoalJudgement`；
3. Policy 与 Skill 改为按 Task Profile 编译；
4. Delivery 和 Memory Write 只消费结构化 Goal、Evidence 和 Receipt；
5. Legacy Adapter 达到删除条件后退役。

## 十七、非目标

本文不做以下事项：

- 不复制外部 System Prompt；
- 不验证外部材料中的产品事实；
- 不注册外部品牌专属 Policy；
- 不将其他项目的 Skill 直接装入天枢；
- 不在本阶段修改 AgentLoop 主链；
- 不以增加循环次数替代需求澄清和架构理解。

## 十八、验收

- Goal 的目标状态、证据源、约束、预算和停止条件均可机器读取；
- 系统可确定性判断任务是否适合进入循环；
- 外层与内层循环的共享、受限共享和禁止共享数据清晰；
- Goal 完成必须绑定 Judge、Evidence、Gate 和 Constraint Receipt；
- 大型 Prompt 机制被拆入 Policy、Skill、Task Profile、Tool、Memory 和 Delivery；
- 外部材料无法直接提升为 ACTIVE 规则；
- 新契约可映射到现有工程任务和测试矩阵；
- Shadow 阶段不产生重复外部副作用；
- Engine v2 在迁移期间持续可用。