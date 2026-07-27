# Context Planner 与 Claim Ledger 工程设计

> 组件编号：C03  
> 版本：v0.2 Draft  
> 工程动作：UPGRADE  
> 复用：MemoryBackend Router、Memory Context Receipt、LLM Memory Enrichment、EventStore

## 一、职责

Context Planner负责为天枢每次执行建立最小充分上下文。它回答：

1. 当前任务可以使用哪些Claim、天枢状态、外部事实、Policy和Skill；
2. 每条信息的来源、权威、时效和权限是否满足要求；
3. 哪些内容会改变决策，哪些内容只增加Token；
4. 最终注入模型的上下文是否可重现。

Claim Ledger维护声明血缘，不等同于长期记忆存储。它可以从当前会话、天枢历史轨迹、授权文件、外部数据源和Memory OS接收Claim，并为Context Planner提供统一视图。

其他业务仓库仅能作为外部数据源被读取。Context Planner不加载其Runtime、SDK、Schema、Registry或状态机。

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
  claimType:
    | 'fact'
    | 'preference'
    | 'decision'
    | 'goal'
    | 'constraint'
    | 'hypothesis'
    | 'recommendation'
    | 'prediction'
    | 'observation';
  epistemicStatus:
    | 'proposed'
    | 'asserted'
    | 'confirmed'
    | 'derived'
    | 'disputed'
    | 'superseded'
    | 'expired';
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

## 四、来源分类

```ts
export type SourceKind =
  | 'current_human_message'
  | 'historical_human_message'
  | 'assistant_message'
  | 'conversation_summary'
  | 'tianshu_runtime_state'
  | 'tianshu_repository_file'
  | 'memory_os_claim'
  | 'tool_observation'
  | 'external_repository_file'
  | 'external_document'
  | 'web_source';
```

### 4.1 默认权威顺序

```text
当前Human明确字段
> 权威外部系统当前状态
> 历史Human明确字段
> 已确认Decision Record
> 天枢权威文档与运行状态
> Tool Observation
> 外部仓库或外部文档
> Assistant Recommendation
> Conversation Summary
> Model Inference
```

任务级`SourcePolicy`可以调整来源优先级，例如：

- 当前仓库审查优先精确commit上的代码；
- 当前产品文档审查优先用户点名文件；
- 时间敏感判断优先刷新后的权威来源；
- Memory OS内容需要同时满足权限、时效和项目范围。

`SourcePolicy`属于天枢内部任务策略，不承载其他业务项目规则。

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
- 后续实际执行可以产生Observation Claim；
- 外部仓库文档中的陈述不能自动成为用户决定。

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

全部为否时，默认排除。

## 七、三级上下文

### L0 Identity Capsule

- 当前用户和组织；
- 当前天枢执行项目；
- 输出偏好；
- 固定安全与授权边界。

### L1 Context Index

- Claim组名称；
- 描述；
- 项目范围；
- 更新时间；
- 权限；
- 来源类型。

### L2 On-demand Context

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

| 类型 | 默认处理 |
|---|---|
| STATIC | 可复用，定期审计 |
| SLOW_CHANGING | 使用前检查有效期 |
| TIME_SENSITIVE | 输出前刷新 |
| REAL_TIME | 每次决策前刷新 |

检索未命中只记录为`NOT_FOUND`，不能自动生成“不存在”的Claim。

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

### 9.1 外部仓库Source Ref

```ts
export interface ExternalRepositorySourceRef {
  provider: 'github';
  repository: string;
  ref: string;
  commitSha?: string;
  path: string;
  contentHash: string;
  fetchedAt: string;
  accessReceiptId: string;
}
```

约束：

- Repository Ref只用于证明内容来源；
- 不根据仓库名称加载运行组件；
- 不调用仓库内服务；
- 不继承仓库Policy或Skill；
- 内容进入上下文前继续执行注入清洗和权限检查。

## 十、Token Budget Allocator

| 区域 | 建议比例 |
|---|---:|
| 核心任务与Goal | 20% |
| Policy与System Contract | 20% |
| 高影响Claim | 25% |
| 天枢项目和外部知识 | 20% |
| 工具Schema与Skill摘要 | 10% |
| 安全余量 | 5% |

预算不足时依次裁剪：

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
→ 高影响且无法判定：请求用户确认
→ 低影响且无法判定：保留冲突并采用保守值
```

冲突不能通过覆盖旧值消失。旧Claim进入`superseded`或`disputed`并保留血缘。

## 十二、Source Adapter边界

```ts
export interface ContextSourceAdapter {
  adapterId: string;
  sourceKind: SourceKind;
  search(plan: ContextQueryPlan): Promise<ContextCandidate[]>;
  read(refs: string[]): Promise<ContextItem[]>;
  verifyFreshness(items: ContextItem[]): Promise<ContextItem[]>;
}
```

允许的Adapter：

- Current Conversation；
- Conversation Archive；
- Local Runtime Memory；
- AWKN Memory OS；
- GitHub、Drive等授权读取来源；
- Web或公共数据源；
- 天枢Policy Registry；
- 天枢Skill Registry。

禁止的Adapter：

- GUNDAM Runtime；
- Value Runtime；
- win Runtime；
- 其他业务项目Service、SDK或Registry。

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
- Context使用结果提交Consumption和Usage Receipt；
- GitHub等数据源输出标准External Source Ref。

### NEW

- `context/planner.ts`
- `context/claim-ledger.ts`
- `context/source-policy.ts`
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
10. Memory OS不可用时标记stale或降级；
11. 外部仓库内容不能注册Runtime Adapter；
12. Source Ref缺少commit或ref时降低可复现等级。

## 十五、验收

- 所有main dialogue模型调用绑定Context Manifest；
- 每条上下文可解释来源和使用原因；
- 每条排除项有Reason Code；
- 时间敏感事实符合Freshness Contract；
- 关键Claim可追溯到原始来源；
- Context Token预算可观测；
- 除Memory OS外不存在跨仓运行Adapter。
