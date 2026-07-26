# Intent & Goal Router 工程设计

> 组件编号：C02  
> 工程动作：UPGRADE  
> 复用：GoalManager、CLI、Cron、Orchestrator、AgentLoop

## 一、职责

Intent & Goal Router 将可信输入转成执行意图，负责：

- 判断 L0、L1、L2、L3 或 L4；
- 判断是否创建 Goal；
- 识别外部副作用和时间依赖；
- 判断是否需要补充信息；
- 建立验收条件、预算和停止策略；
- 选择领域适配器和运行模板。

## 二、核心流程

```text
TrustedInput
→ Intent Extraction
→ Task Shape Classification
→ Missing Information Analysis
→ Clarification Value Gate
→ L0—L4 Routing
→ GoalSpec Factory
→ Domain Adapter Selection
→ Intent Receipt
```

## 三、核心契约

```ts
export interface IntentDecision {
  schema: 'awkn-intent-decision/v1';
  intentId: string;
  executionLevel: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  primaryIntent: string;
  secondaryIntents: string[];
  requestedOutcome: string;
  deliverableTypes: string[];
  externalSideEffects: boolean;
  timeDependency: 'none' | 'deadline' | 'scheduled' | 'condition_watch';
  domain: string;
  confidence: number;
  assumptions: Assumption[];
  missingFields: MissingField[];
  clarificationDecision: 'ASK_USER' | 'CONTINUE_WITH_EXPLICIT_ASSUMPTION' | 'CONTINUE';
  reasonCodes: string[];
}
```

## 四、L0—L4判定

| 层级 | 判定条件 | 是否创建持久Run |
|---|---|---|
| L0 | 解释、评价、比较、总结；无外部写入 | 否 |
| L1 | 一次执行可完成；工具数量有限 | 可选 |
| L2 | 需要多轮修复；有确定性验收和Gate | 是 |
| L3 | 有时间、周期或未来条件；需要恢复 | 是 |
| L4 | 多Agent、多项目或多外部系统；有依赖图 | 是 |

路由遵循逐级升级原则。高层级需要更完整的范围、授权、预算和恢复协议。

## 五、Clarification Value Gate

### 5.1 评分

```text
ClarificationValue =
0.35 × AnswerImpact
+ 0.25 × UncertaintyReduction
+ 0.20 × SafetyImpact
+ 0.10 × Irreversibility
+ 0.10 × UserEffortInverse
```

### 5.2 决策

| 分数 | 动作 |
|---|---|
| >= 0.70 | ASK_USER |
| 0.40—0.69 | CONTINUE_WITH_EXPLICIT_ASSUMPTION |
| < 0.40 | CONTINUE |

### 5.3 必须补充信息的场景

- 目标收件人、金额、生产环境等不可逆字段缺失；
- 存在多个同名项目或资源；
- 用户意图有相互排斥的解释；
- 高影响工具缺少授权范围；
- L3任务缺少可解析时间或条件；
- L4任务缺少目标、边界或验收。

### 5.4 不应重复询问

- 当前对话已经提供；
- Claim Ledger中存在高权威且有效的字段；
- 可以从代码、配置或权威系统确定性读取；
- 缺失字段不会改变结果；
- 用户要求按现有信息完成。

## 六、GoalSpec v2

```ts
export interface GoalSpec {
  schema: 'awkn-goal-spec/v2';
  goalId: string;
  title: string;
  objective: string;
  scope: { included: string[]; excluded: string[] };
  acceptanceCriteria: AcceptanceCriterion[];
  constraints: ClaimRef[];
  assumptions: Assumption[];
  budget: {
    maxCycles: number;
    maxTurns: number;
    maxTokens: number;
    maxDurationMs?: number;
    maxCost?: number;
  };
  stopPolicy: StopPolicy;
  deliveryExpectation: DeliveryExpectation;
  riskLevel: string;
  createdBy: ActorRef;
  createdAt: string;
}
```

## 七、验收条件

| 类型 | 示例 | 评估器 |
|---|---|---|
| Command | `npm run check` 通过 | Process Evaluator |
| Schema | JSON符合Schema | Schema Evaluator |
| File | 文件存在且Hash有效 | Artifact Evaluator |
| State | PR合并、邮件发送、外部记录创建 | External State Evaluator |
| Numeric | 错误数=0、评分达到阈值 | Metric Evaluator |
| Human | 用户明确批准 | Human Confirmation Evaluator |
| Composite | 多条件AND/OR | Composite Evaluator |

每条验收条件必须声明证据来源、时效、失败处理和评估器版本。

## 八、StopPolicy

```ts
export interface StopPolicy {
  success: StopCondition[];
  failure: StopCondition[];
  pause: StopCondition[];
  strategySwitch: StopCondition[];
  humanEscalation: StopCondition[];
}
```

默认停止条件：

- Goal达成；
- 预算超限；
- 连续3轮无Evidence Delta；
- 同一错误指纹重复3次；
- 无可用模型或工具；
- 权限不足；
- 用户取消；
- 输入前提失效。

## 九、领域适配器

```ts
export interface DomainAdapter {
  domain: string;
  detect(input: TrustedInput): Promise<number>;
  enrichIntent(intent: IntentDecision): Promise<IntentDecision>;
  buildGoal(intent: IntentDecision): Promise<Partial<GoalSpec>>;
  defaultPolicies(): string[];
  defaultSkills(): string[];
  defaultGates(): string[];
}
```

首批适配器：

- engineering
- investment
- hotel_decision
- life_decision
- fitness
- media_pipeline

领域适配器只能提供领域默认值，最终执行仍需经过天枢的 Policy、Broker 和 Gate。

## 十、Intent Receipt

```json
{
  "schema": "awkn-intent-receipt/v1",
  "intentId": "intent_xxx",
  "inputId": "in_xxx",
  "level": "L2",
  "domain": "engineering",
  "externalSideEffects": false,
  "clarification": "CONTINUE",
  "goalCreated": true,
  "reasonCodes": ["MULTI_STEP", "DETERMINISTIC_ACCEPTANCE"],
  "routerVersion": "intent-router/1.0",
  "createdAt": "ISO-8601"
}
```

## 十一、现有代码改造

### REUSE

- `goal/goal-manager.ts`
- `core/agent-loop.ts`
- `cron/`
- `orchestrator/`
- `cli.ts`

### UPGRADE

1. GoalManager接受GoalSpec v2；
2. CLI入口先调用Intent Router；
3. `runL2`从GoalSpec读取Acceptance和StopPolicy；
4. L3任务冻结创建时的Actor、Policy和Authorization；
5. L4通过Workflow Graph执行。

### NEW

- `intent/router.ts`
- `intent/classifier.ts`
- `intent/clarification-gate.ts`
- `intent/goal-factory.ts`
- `intent/domain-registry.ts`

## 十二、测试

1. 静态解释路由到L0；
2. 单次文件读取路由到L1；
3. 修复构建并跑测试路由到L2；
4. 每日巡检路由到L3；
5. 跨仓库、多Agent、发布任务路由到L4；
6. 已存在信息不能再次询问；
7. 高影响缺失字段必须询问；
8. 低影响缺失字段采用显式假设；
9. L2缺少确定性验收时不得启动；
10. L4未经完整授权不能运行。

## 十三、验收

- 所有入口产出Intent Receipt；
- L0—L4契约测试全通过；
- GoalSpec可以持久化、恢复和重放；
- Clarification决定带有原因码；
- Domain Adapter不能跳过通用治理链。