# Evidence-Gain Loop 工程设计

> 组件编号：C06  
> 工程动作：UPGRADE  
> 复用：AgentLoop、LoopMonitor、GoalManager、Quality Gates、Artifact Bundle、EventStore、Trace

## 一、职责

Evidence-Gain Loop是天枢执行收敛内核。每轮执行必须以获得新证据、减少不确定性或完成验收为目标。

现有L2流程已经具备：

- L1执行；
- 类型、测试和Lint Gate；
- Artifact Bundle；
- 独立Reviewer；
- Budget Gate；
- 修复上下文；
- Run与Cycle事件。

本组件在现有能力上增加：

- Hypothesis；
- Expected Evidence；
- Evidence Delta；
- Deviation Type；
- Strategy Switch；
- No-Gain停止；
- Outcome反馈。

## 二、主流程

```text
GoalSpec
→ Build Cycle Plan
→ Declare Hypothesis
→ Declare Expected Evidence
→ Execute Actions
→ Collect Evidence
→ Calculate Evidence Delta
→ Evaluate Gates
→ Diagnose Deviation
→ Continue / Switch / Pause / Stop
→ Record Cycle Receipt
```

## 三、Cycle Plan

```ts
export interface EvidenceCyclePlan {
  schema: 'awkn-evidence-cycle-plan/v1';
  cycleId: string;
  runId: string;
  cycleNumber: number;
  objective: string;
  hypothesis: string;
  expectedEvidence: ExpectedEvidence[];
  plannedActions: PlannedAction[];
  selectedStrategy: string;
  policyBundleHash: string;
  skillBundleHash: string;
  contextManifestHash: string;
  budgetSlice: CycleBudget;
}
```

## 四、Expected Evidence

```ts
export interface ExpectedEvidence {
  expectedEvidenceId: string;
  description: string;
  sourceType: 'command' | 'tool' | 'artifact' | 'external_state' | 'human_confirmation';
  evaluatorId: string;
  successPredicate: Record<string, unknown>;
  freshnessRequired?: string;
  required: boolean;
}
```

每个重要动作需要回答：

- 执行后预期看到什么；
- 哪个工具或评估器证明它；
- 什么结果支持当前假设；
- 什么结果推翻当前假设；
- 没有结果时如何处理。

## 五、Evidence Delta

```ts
export interface EvidenceDelta {
  schema: 'awkn-evidence-delta/v1';
  cycleId: string;
  addedEvidenceIds: string[];
  removedOrInvalidatedEvidenceIds: string[];
  confirmedClaimIds: string[];
  disputedClaimIds: string[];
  uncertaintyBefore: number;
  uncertaintyAfter: number;
  acceptanceProgressBefore: number;
  acceptanceProgressAfter: number;
  deltaScore: number;
  gainType: 'progress' | 'root_cause' | 'constraint_discovery' | 'strategy_elimination' | 'none' | 'regression';
}
```

### 5.1 Delta Score

```text
DeltaScore =
0.35 × AcceptanceProgress
+ 0.25 × UncertaintyReduction
+ 0.20 × NewVerifiedEvidence
+ 0.10 × StrategyElimination
+ 0.10 × RiskReduction
- 0.30 × Regression
```

即使验收进度没有上升，确认根因或排除错误策略也可以形成有效增量。

## 六、偏差分类

| 类型 | 含义 | 默认动作 |
|---|---|---|
| EXECUTION_ERROR | 工具、命令或代码执行失败 | 修复执行错误 |
| HYPOTHESIS_REJECTED | 证据推翻当前假设 | 切换假设 |
| CONTEXT_GAP | 缺少必要事实或文件 | 请求Context Planner增补 |
| AUTHORIZATION_GAP | 权限不足 | WAITING_AUTHORIZATION |
| CAPABILITY_GAP | 当前模型或工具能力不足 | 请求Broker切换 |
| ACCEPTANCE_MISMATCH | 执行成功但不满足验收 | 调整计划 |
| REPEATED_PATTERN | 动作和错误重复 | 强制策略切换 |
| NO_EVIDENCE | 没有新证据 | 停止或人工介入 |
| REGRESSION | 新动作破坏已有能力 | 回滚或隔离 |

## 七、策略切换

Strategy Switcher维护策略历史：

```ts
export interface StrategyAttempt {
  strategyId: string;
  hypothesis: string;
  actionFingerprint: string;
  resultFingerprint: string;
  evidenceDeltaScore: number;
  failureType?: string;
  usedAt: string;
}
```

切换触发：

- 同一Action Fingerprint重复；
- 同一错误指纹达到阈值；
- 连续两轮Delta过低；
- 当前假设被推翻；
- Reviewer指出架构级问题；
- 成本继续上升且验收无进展。

切换选项：

- 更换假设；
- 更换Skill；
- 更换模型；
- 更换工具；
- 缩小任务范围；
- 回到方案冻结；
- 请求用户选择；
- 结束并输出阻塞证据。

## 八、停止控制

### 8.1 成功

- 所有Required Acceptance通过；
- Delivery前置条件满足；
- 无阻断Policy；
- Evidence等级满足Goal要求。

### 8.2 失败

- 预算耗尽；
- 无可用执行能力；
- 前提失效；
- 安全或权限Policy阻断；
- 无法恢复的外部失败。

### 8.3 暂停

- 等待用户确认；
- 等待外部系统；
- 等待定时触发；
- 等待人工审核。

### 8.4 No-Gain

默认：

```text
连续3轮 deltaScore <= 0
或
连续3轮 actionFingerprint相同
或
连续3轮 errorFingerprint相同
```

处理顺序：

1. 强制Strategy Switch；
2. 已切换过且仍无增量，进入PAUSED或FAILED；
3. 输出已证实内容、未解决问题和下一步建议。

## 九、Cycle Receipt

```json
{
  "schema": "awkn-cycle-receipt/v1",
  "runId": "run_xxx",
  "cycle": 4,
  "hypothesis": "构建失败由迁移缺失造成",
  "expectedEvidenceIds": ["ee_1"],
  "actualEvidenceIds": ["ev_8"],
  "deltaScore": 0.62,
  "deviationType": "HYPOTHESIS_REJECTED",
  "strategyDecision": "SWITCH",
  "nextStrategy": "inspect runtime config",
  "tokens": 3200,
  "durationMs": 18000
}
```

## 十、现有AgentLoop改造

### REUSE

- `runL1()`工具循环；
- `runL2()`Run与Cycle框架；
- LoopMonitor；
- deterministic gates；
- Artifact Bundle；
- independent review；
- EventStore和Trace。

### UPGRADE

1. `repairContext: string`升级为`CycleFeedbackBundle`；
2. Cycle开始前创建EvidenceCyclePlan；
3. Gate执行后计算EvidenceDelta；
4. LoopMonitor接收Action、Error和Evidence指纹；
5. LLM失败、工具失败和Gate失败采用统一Deviation；
6. `runL2`支持PAUSED和WAITING状态；
7. Goal进度由AcceptanceProgress更新。

### NEW

- `loop/evidence-loop.ts`
- `loop/cycle-planner.ts`
- `loop/evidence-delta.ts`
- `loop/deviation.ts`
- `loop/strategy-switcher.ts`
- `loop/stop-controller.ts`

## 十一、L3与L4扩展

### L3

- 每次触发创建新Run或恢复旧Run；
- 检查上次Evidence与外部状态；
- 幂等执行；
- 没有变化时记录`NO_CHANGE`，不制造虚假增量。

### L4

- 每个Agent子任务生成子Run；
- Workflow Graph节点声明Expected Evidence；
- 父Run只聚合经过验证的Evidence；
- 子Agent失败不能自动被父Agent改写为成功；
- 多Agent结论冲突进入Conflict Evidence。

## 十二、指标

- Evidence Gain Rate；
- Mean Cycles to Acceptance；
- Strategy Switch Effectiveness；
- Repeated Action Rate；
- No-Gain Stop Precision；
- Gate Failure Recovery Rate；
- Human Escalation Rate；
- Token per Verified Evidence；
- Regression Rate。

## 十三、测试

1. 每轮开始前存在Expected Evidence；
2. 无新增证据不能生成正Delta；
3. 根因确认可以生成有效Delta；
4. 同一动作重复触发Strategy Switch；
5. 同一错误重复达到阈值后停止；
6. Context Gap可以返回Context Planner；
7. Capability Gap可以请求Broker切换；
8. Regression触发回滚或隔离；
9. Goal达成需要Evidence与Gate同时通过；
10. Run恢复不会重复已确认副作用。

## 十四、验收

- L2每轮都有Cycle Receipt；
- 连续无增量时系统不会盲目循环；
- Strategy Switch可观测；
- Evidence与Acceptance进度可查询；
- 现有质量Gate和Artifact Bundle继续工作；
- 历史Run可通过Event重放恢复Cycle状态。