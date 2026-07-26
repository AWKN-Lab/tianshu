# Delivery、Evidence、Memory Write 与 Evolve 工程设计

> 组件编号：C07、C08、C09  
> 工程动作：NEW + UPGRADE

## 一、职责边界

### C07 Delivery Router

负责把执行结果交付到正确载体：

- Chat；
- File；
- Visual；
- Artifact App；
- Connected System；
- Scheduled Task。

### C08 Evidence & Outcome

负责区分：

- 执行完成；
- 交付完成；
- 用户采用；
- 业务结果；
- 学习结果。

### C09 Memory Write & Evolve

负责：

- 生成记忆候选；
- 判断是否可持久化；
- 选择Memory Backend；
- 执行事务写入；
- 生成Policy、Skill、Prompt、Router、Gate和领域规则候选；
- 回放、晋级、隔离和回滚。

## 二、Delivery Router

### 2.1 路由规则

| 用户目标 | Delivery Mode |
|---|---|
| 理解、解释、判断 | CHAT |
| 保存、下载、提交、分享 | FILE |
| 看结构、关系、流程 | VISUAL |
| 持续交互和保存应用状态 | ARTIFACT_APP |
| 修改邮件、日历、GitHub等外部系统 | CONNECTED_SYSTEM |
| 未来或周期执行 | SCHEDULED_TASK |

同一Execution可以产生多个Delivery，但必须指定Primary Delivery。

### 2.2 Delivery Contract

```ts
export interface DeliveryContract {
  schema: 'awkn-delivery-contract/v1';
  deliveryId: string;
  executionId: string;
  mode: 'CHAT' | 'FILE' | 'VISUAL' | 'ARTIFACT_APP' | 'CONNECTED_SYSTEM' | 'SCHEDULED_TASK';
  target?: ResourceRef;
  format?: string;
  primary: boolean;
  sideEffect: 'none' | 'local_write' | 'external_write' | 'scheduled';
  requiresAuthorization: boolean;
  requiredArtifacts: ArtifactRequirement[];
  successPredicate: Record<string, unknown>;
  failurePolicy: 'RETRY' | 'PARTIAL' | 'ROLLBACK' | 'WAIT_USER' | 'FAIL';
}
```

### 2.3 Delivery Bundle

```ts
export interface DeliveryBundle {
  schema: 'awkn-delivery-bundle/v1';
  executionId: string;
  contracts: DeliveryContract[];
  artifacts: ArtifactRef[];
  receipts: DeliveryReceipt[];
  primaryDeliveryId: string;
  state: 'PENDING' | 'RUNNING' | 'PARTIAL' | 'SUCCEEDED' | 'FAILED';
}
```

### 2.4 Delivery Receipt

必须包含：

- 实际交付位置；
- 产物Hash；
- 外部资源ID；
- 报告成功和验证成功；
- 是否可撤回；
- 失败原因和重试语义。

## 三、Outcome模型

```ts
export interface OutcomeRecord {
  schema: 'awkn-outcome-record/v1';
  outcomeId: string;
  executionId: string;
  runId?: string;
  executionOutcome: OutcomeState;
  deliveryOutcome: OutcomeState;
  adoptionOutcome: OutcomeState | 'UNKNOWN';
  businessOutcome: OutcomeState | 'UNKNOWN';
  learningOutcome: OutcomeState | 'UNKNOWN';
  evidenceIds: string[];
  observedAt: string;
  observer: ActorRef;
  confidence: number;
  attribution?: OutcomeAttribution;
}
```

`OutcomeState`：

```text
SUCCEEDED
FAILED
PARTIAL
CANCELLED
PENDING
UNKNOWN
```

### 3.1 禁止合并的状态

- 测试通过不代表用户采用；
- 文件创建不代表用户下载；
- 邮件工具返回成功不代表收件人收到；
- 模型建议完成不代表业务结果达成；
- 用户采用不代表建议有效；
- 执行失败仍可能产生有价值学习。

## 四、Outcome Attribution

```ts
export interface OutcomeAttribution {
  contributingClaims: WeightedRef[];
  contributingPolicies: WeightedRef[];
  contributingSkills: WeightedRef[];
  contributingModels: WeightedRef[];
  contributingTools: WeightedRef[];
  confidence: number;
  method: 'rule_based' | 'counterfactual' | 'human_review' | 'mixed';
}
```

P0采用规则型归因，后续增加反事实评测。

## 五、Memory Write Gate

### 5.1 主流程

```text
Execution + Claims + Outcome
→ Memory Candidate Extraction
→ Source Verification
→ Durability Test
→ Sensitivity Test
→ Decision Impact Test
→ Duplicate/Conflict Check
→ Consent Policy
→ Backend Selection
→ CAS Transaction
→ Memory Write Receipt
```

### 5.2 Memory Candidate

```ts
export interface MemoryCandidate {
  schema: 'awkn-memory-candidate/v1';
  candidateId: string;
  claim: Claim;
  proposedMemoryClass: 'working' | 'goal' | 'episodic' | 'semantic' | 'procedural' | 'governance';
  writeReason: string;
  durabilityScore: number;
  futureUtilityScore: number;
  sensitivityDecision: string;
  requiresConfirmation: boolean;
  targetBackend: 'local' | 'memory-os' | 'none';
}
```

### 5.3 六层记忆

| 层 | 内容 | 默认位置 |
|---|---|---|
| M0 Working State | 当前推理、临时变量 | 天枢本地 |
| M1 Goal State | Goal、Run、Checkpoint、阻塞 | 天枢Event Store |
| M2 Episodic | 执行事件、结果和证据 | Memory OS或本地轨迹 |
| M3 Semantic | 稳定用户、项目和业务Claim | Memory OS |
| M4 Procedural | Skill、流程、失败经验 | Skill Registry + Memory OS |
| M5 Governance | Policy、授权、规则和审计 | 天枢Policy Registry + Memory OS Rule |

### 5.4 写入判断

可写入：

- 用户明确陈述的耐久事实；
- 用户明确选择的方案；
- 已观察到的项目状态；
- 经过验证的执行经验；
- 经过回放批准的程序性经验。

默认不写入：

- 模型推断；
- 未确认建议；
- 外部检索结果作为用户属性；
- 临时情绪和短时状态；
- 无未来复用价值的细节；
- 无法证明来源的摘要结论。

### 5.5 事务

```ts
export interface MemoryTransaction {
  transactionId: string;
  idempotencyKey: string;
  expectedRevision?: number;
  operations: MemoryOperation[];
  dependencyUpdates: DependencyUpdate[];
  tombstones: Tombstone[];
}
```

要求：

- 字段级CAS；
- 幂等；
- 追加事件；
- 冲突重读与合并；
- 删除依赖传播；
- 回滚生成新版本，保留历史。

## 六、Memory Write Receipt

```json
{
  "schema": "awkn-memory-write-receipt/v1",
  "candidateId": "mc_xxx",
  "claimId": "claim_xxx",
  "decision": "WRITE",
  "reasonCodes": ["HUMAN_FIELD_CONFIRMED", "DURABLE", "HIGH_FUTURE_UTILITY"],
  "backend": "memory-os",
  "memoryId": "mem_xxx",
  "revision": 7,
  "idempotencyKey": "...",
  "createdAt": "ISO-8601"
}
```

## 七、Evolve扩展

### 7.1 Candidate类型

```text
POLICY
SKILL
PROMPT
MODEL_ROUTE
TOOL_ROUTE
GATE
DOMAIN_RULE
CONTEXT_RULE
DELIVERY_RULE
```

### 7.2 Candidate来源

- 失败模式聚类；
- 人工纠正；
- Outcome归因；
- 高成本重复路径；
- Context误选；
- 路由降级失败；
- Delivery失败；
- 垂直项目领域反馈。

### 7.3 生命周期

```text
DRAFT
→ VALIDATING
→ APPROVED
→ ACTIVE
→ QUARANTINED / RETIRED
```

### 7.4 回放指标

- 成功率；
- Evidence Gain Rate；
- 平均循环数；
- Token；
- 延迟；
- 错误率；
- 人工接管率；
- 安全违规率；
- 用户决定误归因率；
- Context无关注入率；
- 重复副作用率；
- Delivery成功率。

## 八、Experience到Rule的转换

```text
Observed Failure/Success
→ Experience Candidate
→ Source Verification
→ Replay Case
→ Candidate Rule/Skill
→ Baseline vs Candidate
→ Approval
→ ACTIVE
→ Outcome Monitoring
```

工程经验不能直接成为ACTIVE Policy。它先进入候选状态，并保留来源Run、Step和Evidence。

## 九、现有代码改造

### REUSE

- EventStore；
- Artifact Bundle；
- Trace；
- `memory/router.ts`；
- `memory/authority.ts`；
- Durable Outbox；
- Evolve Candidate、Replay、Promotion、Quarantine和Rollback。

### UPGRADE

- `LlmRouter.rememberResponse()`迁移到Memory Write Gate；
- Run终态生成OutcomeRecord；
- Delivery拥有独立状态；
- Candidate支持新类型；
- Replay指标增加Claim、Context、Delivery和Route指标；
- Authority Outbox提交完整Outcome和Lineage。

### NEW

- `delivery/router.ts`
- `delivery/contracts.ts`
- `outcome/recorder.ts`
- `outcome/attribution.ts`
- `memory/write-gate.ts`
- `memory/transaction.ts`
- `evolve/candidate-factory-v2.ts`

## 十、测试

1. 文件创建成功但交付失败时Delivery为FAILED；
2. 执行成功且用户未反馈时Adoption为UNKNOWN；
3. Memory Candidate缺少来源时被拒绝；
4. Assistant建议不能写成用户决定；
5. 同一消息重复消费只写一次；
6. 删除Claim后依赖项失效；
7. Memory OS不可用时Outbox保留，状态不得伪装成功；
8. Policy候选无回放不能ACTIVE；
9. Candidate回归时自动QUARANTINED；
10. Delivery失败可以形成Learning Outcome。

## 十一、验收

- Delivery和Execution状态完全分离；
- Outcome五层状态可查询；
- 每次持久写入都有Memory Write Receipt；
- 记忆写入支持幂等、CAS和依赖删除；
- Evolve覆盖Policy、Skill、Prompt、Router、Gate和领域规则；
- ACTIVE候选持续接受Outcome监控。