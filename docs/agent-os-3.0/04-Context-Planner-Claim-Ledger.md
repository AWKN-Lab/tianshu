# Context Planner 与 Claim Ledger 工程设计

> 组件编号：C03  
> 工程动作：UPGRADE  
> 复用：MemoryBackend Router、Memory Context Receipt、LLM Memory Enrichment、EventStore

## 一、职责

Context Planner负责在每次执行前建立最小充分上下文。它需要回答四个问题：

1. 当前任务可以使用哪些Claim、项目状态、外部事实、Policy和Skill；
2. 每条信息的来源、权威、时效和权限是否满足要求；
3. 哪些内容会改变决策，哪些内容只增加Token；
4. 最终注入模型的上下文是否可重现。

Claim Ledger负责维护声明血缘，不等同于长期记忆存储。它可以从当前会话、历史对话、项目文件、外部来源和Memory OS接收Claim，并为Context Planner提供统一视图。

## 二、核心流程

```text
IntentDecision + GoalSpec
→ Query Plan
→ Candidate Sources
→ Claim Extraction/Resolution
→ Authority & Freshness Check
→ Permission Check
→ Context Utility Score
→ Token Allocation
→ Conflict Handling
→ Included/Excluded Decision
→ Context Manifest
→ Immutable Render
```

## 三、Claim Lineage v2

```ts
export interface Claim {
  schema: 'awkn-claim/v2';
  claimId: string;
  content: string;
  contentHash: string;
  originator: 'human' | 'assistant' | 'system' | 'external';
  speaker: 'human' | 'assistant' | 'system' | 'tool';
  claimType: 'fact' | 'preference' | 'decision' | 'goal' | 'constraint' | 'hypothesis' | 'recommendation' | 'prediction' | 'observation';
  epistemicStatus: 'proposed' | 'asserted' | 'confirmed' | 'derived' | 'disputed' | 'superseded' | 'expired';
  confirmationScope: 'none' | 'direction' | 'option' | 'field_level';
  sourceRefs: SourceRef[];
  derivedFrom: string[];
  authority: number;
  confidence: number;
  sensitivityClass: string;
  projectId?: string;
  userId?: string;
  validFrom?: string;
  validUntil?: string;
}
```

## 四、来源优先级

同一字段冲突时，默认权威顺序：

```text
当前Human明确字段
> 权威外部系统当前状态
> 历史Human明确字段
> 已确认Decision Record
> 项目权威文档
> Tool Observation
> Assistant Recommendation
> Conversation Summary
> Model Inference
```

领域适配器可以调整顺序。例如投资行情优先实时数据源，酒店项目参数优先用户确认后的Decision Bundle。

## 五、确认范围

| 范围 | 含义 | 示例 |
|---|---|---|
| none | 无确认 | 模型提出方案B |
| direction | 认可方向 | “这个方向可以” |
| option | 选择方案 | “采用方案B” |
| field_level | 明确字段 | “方案B，预算20万，9月启动” |

规则：

- 方向认可不能确认全部步骤；
- 方案选择不能自动确认模型给出的理由；
- Summary不能提高确认范围；
- 后续实际执行可以产生Observation Claim，但仍需与Decision Claim区分。

## 六、Context Utility Score

```text
Utility =
0.30 × DecisionImpact
+ 0.20 × TaskRelevance
+ 0.15 × SourceTrust
+ 0.10 × Freshness
+ 0.10 × Novelty
+ 0.10 × UserExpectation
- 0.15 × SensitivityRisk
- 0.10 × TokenCost
- 0.10 × ContradictionRisk
```

### 6.1 决策影响测试

每条候选内容必须回答：

- 删除它是否改变结论；
- 删除它是否改变执行路径；
- 删除它是否改变需要询问的问题；
- 删除它是否改变授权、风险或验收；
- 删除它是否影响用户明确要求的格式。

全部为否时，默认不进入上下文。

## 七、三级上下文

### L0 Identity Capsule

稳定且高频的小型上下文：

- 当前用户和组织；
- 当前项目；
- 输出偏好；
- 固定安全与授权边界。

### L1 Context Index

只放目录信息：

- Claim组名称；
- 描述；
-项目范围；
- 更新时间；
- 权限；
- 来源类型。

### L2 On-demand Context

根据任务按需读取：

- 具体Claim；
- 原始来源引用；
- 版本；
- 有效期；
- 冲突状态；
- 使用原因。

## 八、Freshness Contract

```ts
export interface FreshnessContract {
  class: 'STATIC' | 'SLOW_CHANGING' | 'TIME_SENSITIVE' | 'REAL_TIME';
  observedAt: string;
  sourcePublishedAt?: string;
  validUntil?: string;
  refreshPolicy: 'none' | 'before_use' | 'before_decision' | 'always';
  sourceAuthority: string;
  conflictStatus: 'none' | 'suspected' | 'confirmed';
}
```

### 8.1 默认策略

| 类型 | 默认处理 |
|---|---|
| STATIC | 可复用，定期审计 |
| SLOW_CHANGING | 使用前检查有效期 |
| TIME_SENSITIVE | 输出前刷新 |
| REAL_TIME | 每次决策前刷新 |

“未搜索到”只能记录为检索未命中，不能自动生成不存在Claim。

## 九、Context Manifest

```ts
export interface ContextManifest {
  schema: 'awkn-context-manifest/v1';
  contextId: string;
  executionId: string;
  query: string;
  tokenBudget: number;
  included: ContextItemDecision[];
  excluded: ContextItemDecision[];
  conflicts: ContextConflict[];
  sourceReceipts: string[];
  policyVersion: string;
  plannerVersion: string;
  manifestHash: string;
  createdAt: string;
}
```

`ContextItemDecision`至少包含：

- Claim或文档Ref；
- Utility Score；
- Token估算；
- Included/Excluded；
- 原因码；
- Freshness；
- Authority；
- Sensitivity；
- Permission Decision。

## 十、Token Budget Allocator

建议默认比例：

| 区域 | 比例 |
|---|---:|
| 核心任务与Goal | 20% |
| Policy与System Contract | 20% |
| 高影响Claim | 25% |
| 项目与领域知识 | 20% |
| 工具Schema与Skill摘要 | 10% |
| 安全余量 | 5% |

当预算不足时，裁剪顺序：

1. 低影响个性化信息；
2. 重复背景；
3. 可由工具按需获取的信息；
4. 低权威推断；
5. 历史细节。

不得裁剪：

- 用户当前明确约束；
- 授权范围；
- 安全Policy；
- Goal验收；
- 当前失败证据；
- 外部副作用参数。

## 十一、冲突处理

```text
发现冲突
→ 判断是否同一字段
→ 比较权威与时效
→ 检查是否可自动判定
→ 可判定：生成Supersede关系
→ 不可判定且高影响：请求用户确认
→ 不可判定且低影响：保留冲突并采用保守值
```

冲突不能通过覆盖旧值消失。旧Claim进入 `superseded` 或 `disputed`，保留血缘。

## 十二、Memory Backend关系

Context Planner只依赖统一接口：

```ts
export interface ContextSourceAdapter {
  search(plan: ContextQueryPlan): Promise<ContextCandidate[]>;
  read(refs: string[]): Promise<ContextItem[]>;
  verifyFreshness(items: ContextItem[]): Promise<ContextItem[]>;
}
```

适配器包括：

- Current Conversation；
- Conversation Archive；
- Local Runtime Memory；
- AWKN Memory OS；
- GitHub/Drive等内部来源；
- Web或领域数据源；
- Policy Registry；
- Skill Registry。

## 十三、现有代码改造

### REUSE

- `memory/router.ts`
- `memory/backend.ts`
- `memory/awkn-memory-os-backend.ts`
- `llm/router.ts`中的Memory Enrichment
- `context-ledger-v1`

### UPGRADE

- `compileAndRender()`输入增加Goal、Policy、Authority和Freshness；
- LLM Router只接收已冻结Context Manifest；
- `rememberResponse()`移出LLM Router，交给Memory Write Gate；
- Context使用结果提交Consumption和Usage Receipt。

### NEW

- `context/planner.ts`
- `context/claim-ledger.ts`
- `context/utility-score.ts`
- `context/freshness.ts`
- `context/manifest-store.ts`

## 十四、测试

1. Assistant建议不能成为Human Decision；
2. 简单“可以”只确认方向；
3. 原始Human消息优先于Summary；
4. 过期实时数据不能进入决策上下文；
5. 未命中搜索不能生成“不存在”结论；
6. 敏感且未请求的信息不进入上下文；
7. 无关记忆被排除并记录原因；
8. 相同输入和相同源版本生成稳定Manifest Hash；
9. Context冲突保留双方来源；
10. Memory OS不可用时标记stale或降级，禁止伪造远端Receipt。

## 十五、验收

- 所有main_dialogue模型调用都绑定Context Manifest；
- 每条上下文可解释来源和使用原因；
- 每条排除项有Reason Code；
- 时间敏感事实符合Freshness Contract；
- 关键Claim可追溯到原始来源；
- Context Token预算可观测。