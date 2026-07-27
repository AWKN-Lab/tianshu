# Contracts 与 Canonical JSON 规范

> 文档编号：TS-AOS-CONTRACT-013  
> 版本：v1.0 Draft  
> 关联：PR #25、Issue #28、WP-AOS-01  
> 权威实现：`runtime/src/contracts/`

## 一、规范级别

本文使用：

- **MUST**：实现和测试必须满足；
- **MUST NOT**：明确禁止；
- **SHOULD**：无充分理由不得偏离；
- **MAY**：可选能力。

Zod Schema 是运行时校验权威；TypeScript 类型必须从 Zod 推导或由 Contract Test 保证完全一致。Markdown 示例不具有独立权威。

## 二、Schema 标识与版本

Schema ID 统一格式：

```text
awkn-<domain>-<name>/v<major>
```

示例：

```text
awkn-execution-envelope/v1
awkn-goal-spec/v3
awkn-claim/v3
awkn-receipt-envelope/v1
awkn-authorization-token/v1
```

规则：

1. `major` 改变代表不兼容；
2. 兼容字段新增通过 `schemaRevision` 或实现版本表达，不修改 major；
3. 未知 major MUST 拒绝；
4. 未知字段默认拒绝，显式声明 `passthrough` 的外部 Payload 除外；
5. 所有持久化 JSON MUST 保存 `schema`。

## 三、AWKN Canonical JSON v1

### 3.1 输入范围

Canonicalizer 接受通过对应 Zod Schema 校验后的 JSON Value：

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
```

`undefined`、Function、Symbol、BigInt、Date 实例、Map、Set、NaN、Infinity MUST 在进入 Canonicalizer 前被拒绝或显式转换。

### 3.2 字符串

- 编码：UTF-8；
- Unicode：NFC；
- 换行：字符串内容中的 CRLF 规范化为 LF，仅适用于声明为 text 的字段；
- JSON 转义使用标准 JSON 转义；
- 不允许无效代理项；
- 字段名同样执行 NFC。

### 3.3 Object

- Key 按 NFC 后的 Unicode code point 升序排列；
- `undefined` 字段禁止进入对象；
- `null` 保留；
- 空对象保留；
- 重复 Key 在解析阶段拒绝；
- 不执行业务字段默认值推断，默认值必须由 Schema Parse 产生。

### 3.4 Array

- 保留原顺序；
- 空数组保留；
- 不自动排序、不去重；
- 对“集合语义”字段，Schema 层必须先执行去重和明确排序。

### 3.5 Number

- 仅允许有限 IEEE-754 Number；
- `-0` 规范化为 `0`；
- 整数不输出小数点；
- 指数形式由统一序列化器生成；
- 金额、Token、Revision、计数 SHOULD 使用整数；
- 高精度小数 MUST 使用十进制字符串和独立格式校验。

### 3.6 时间

时间字段统一为 UTC ISO-8601 毫秒精度：

```text
2026-07-26T09:45:18.000Z
```

规则：

- 输入允许带 offset，Parse 后转 UTC；
- 持久化必须带 `Z`；
- 缺少时区拒绝；
- 纳秒信息截断到毫秒并记录原始精度时，使用独立字段；
- 业务日期使用 `YYYY-MM-DD`，不得伪装成时间戳。

### 3.7 Canonical Bytes

```text
UTF8(canonical-json-without-trailing-newline)
```

CLI 展示可以追加换行，Hash 输入不得包含该换行。

## 四、Stable Hash

### 4.1 算法

```text
sha256(
  UTF8("awkn-canonical-json/v1\n")
  + UTF8(schemaId)
  + UTF8("\n")
  + canonicalBytes
)
```

输出：小写 64 位十六进制。

### 4.2 Hash 边界

每个 Contract 明确 `hashProjection()`。默认排除：

- 数据库自增 ID；
- `createdAt`、`updatedAt` 等观测时间；
- Trace Span ID；
- 重试次数；
- 非确定性运行指标。

默认保留：

- Schema；
- 业务内容；
- Source Ref；
- 权限范围；
- 状态与 revision；
- 版本引用。

不同 Hash 用途必须使用不同前缀：

```text
contentHash
bundleHash
payloadHash
artifactHash
sourceHash
```

禁止复用一个 Hash 表达多种语义。

## 五、ID 规范

### 5.1 格式

```text
<prefix>_<32 lowercase hex>
```

初始实现使用 `crypto.randomUUID()` 去除连字符。ID 负责唯一性，不承担排序语义。

| 对象 | Prefix |
|---|---|
| Execution | `exec` |
| Trace | `tr` |
| Goal | `goal` |
| Run | `run` |
| Step | `step` |
| Claim | `clm` |
| Evidence | `ev` |
| Receipt | `rcpt` |
| Authorization | `auth` |
| Delivery | `dlv` |
| Outcome | `out` |
| Memory Transaction | `mtx` |
| Candidate | `cand` |
| Event | `evt` |

外部系统 ID 必须保留在 `externalRef`，不得伪造成天枢 ID。

## 六、unknown、null、omitted

- `omitted`：字段不适用或未提供；
- `null`：字段适用，明确为空；
- `unknown`：业务状态未知，使用枚举值或显式对象表达；
- 空字符串不能代替 unknown；
- `false`、`0`、空数组不得被 truthy/falsy 逻辑误删。

示例：

```ts
outcome.businessStatus = 'UNKNOWN';
outcome.businessValue = undefined;
outcome.observedAt = null; // 仅当 Schema 明确允许
```

## 七、ExecutionEnvelope v1

```ts
interface ExecutionEnvelope {
  schema: 'awkn-execution-envelope/v1';
  executionId: string;
  traceId: string;
  revision: number;
  actor: ActorRef;
  scope: ExecutionScope;
  inputRef: ObjectRef;
  intentRef?: ObjectRef;
  goalRef?: ObjectRef;
  contextRef?: ObjectRef;
  policyBundleRef?: ObjectRef;
  skillBundleRef?: ObjectRef;
  brokerPlanRef?: ObjectRef;
  runRefs: ObjectRef[];
  deliveryRefs: ObjectRef[];
  outcomeRef?: ObjectRef;
  memoryDecisionRefs: ObjectRef[];
  evolutionCandidateRefs: ObjectRef[];
  featureFlagsRef: ObjectRef;
  state: ExecutionState;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}
```

冻结决定：

- Envelope 保存 Ref 集合和关键状态；
- 完整对象保存到对应 Store；
- 每次修改使用 `expectedRevision`；
- Envelope Snapshot 可生成，但不是权威写模型；
- 关闭后的 Envelope 不允许原地恢复，恢复创建新 Run 并引用原 Execution。

## 八、GoalSpec v3

```ts
interface GoalSpec {
  schema: 'awkn-goal-spec/v3';
  goalId: string;
  title: string;
  desiredState: DesiredState;
  scope: { included: string[]; excluded: string[] };
  acceptanceCriteria: AcceptanceCriterion[];
  evidenceSources: EvidenceSource[];
  constraints: Constraint[];
  assumptions: Assumption[];
  budget: GoalBudget;
  stopPolicy: StopPolicy;
  judgePolicy: GoalJudgePolicy;
  deliveryExpectation: DeliveryExpectation;
  taskProfile: string;
  riskLevel: 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  createdBy: ActorRef;
  createdAt: string;
}
```

### 8.1 LoopEligibilityDecision

```ts
interface LoopEligibilityDecision {
  schema: 'awkn-loop-eligibility/v1';
  intentId: string;
  eligible: boolean;
  targetLevel: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  clarityScore: number;
  evidenceAvailability: number;
  toolCoverage: number;
  stopConditionDeterminism: number;
  unresolvedHighImpactFields: string[];
  decision: 'RUN' | 'ASK_USER' | 'FREEZE_PLAN' | 'HUMAN_LED';
  reasonCodes: string[];
}
```

进入 L2—L4 MUST 满足：目标可描述、至少一个 Required Evidence Source、停止条件可执行、预算存在、关键约束已冻结。

### 8.2 GoalJudgement

```ts
interface GoalJudgement {
  schema: 'awkn-goal-judgement/v1';
  goalId: string;
  runId: string;
  verdict: 'ACHIEVED' | 'NOT_ACHIEVED' | 'BLOCKED' | 'UNKNOWN';
  acceptanceResults: EvaluationRef[];
  constraintResults: EvaluationRef[];
  gateReceiptIds: string[];
  evidenceIds: string[];
  deliveryPreconditionResults: EvaluationRef[];
  judgeVersion: string;
  judgedAt: string;
}
```

`ACHIEVED` 只能由 Goal Judge 产生。模型文本、无 Tool Call、单个 Gate PASS、文件存在均不能单独产生成功终态。

## 九、Claim v3

为消除 `confirmed` 与确认范围冲突，Claim v3 冻结为两条正交轴：

```ts
interface Claim {
  schema: 'awkn-claim/v3';
  claimId: string;
  content: string;
  contentHash: string;
  originator: 'human' | 'assistant' | 'system' | 'external';
  speaker: 'human' | 'assistant' | 'system' | 'tool';
  claimType: ClaimType;
  epistemicStatus:
    | 'proposed'
    | 'asserted'
    | 'derived'
    | 'observed'
    | 'disputed'
    | 'superseded'
    | 'expired';
  confirmationLevel: 'none' | 'direction' | 'option' | 'field';
  sourceRefs: SourceRef[];
  derivedFrom: string[];
  authority: number;
  confidence: number;
  sensitivityClass: string;
  validFrom?: string;
  validUntil?: string;
  projectId?: string;
  userId?: string;
}
```

迁移规则：

- v2 `epistemicStatus=confirmed` 映射为 `asserted`，确认程度由 `confirmationScope` 映射；
- `DIRECTION_CONFIRMED` 等状态不再写入 `epistemicStatus`；
- 工具观测写 `observed`；
- Assistant 建议不能通过确认级别变成 Human originator；
- Summary 保持 `derived` 并保存原始 Source Span。

## 十、Evidence 与 EvidenceDelta

Evidence 必须具备 Source、Producer、时间、Hash 和 Freshness。`model_statement` 最高默认 Evidence Level 为 1，除非由独立 Evaluator 验证。

EvidenceDelta 的 `deltaScore` 不作为 Goal 成功条件，只用于循环控制。计算器必须版本化并保留各分量：

```ts
interface EvidenceDelta {
  schema: 'awkn-evidence-delta/v1';
  cycleId: string;
  components: {
    acceptanceProgress: number;
    uncertaintyReduction: number;
    newVerifiedEvidence: number;
    strategyElimination: number;
    riskReduction: number;
    regression: number;
  };
  deltaScore: number;
  gainType: 'progress' | 'root_cause' | 'constraint_discovery' | 'strategy_elimination' | 'none' | 'regression';
  calculatorVersion: string;
}
```

## 十一、Receipt Envelope

所有 Receipt 统一保存：

```ts
interface ReceiptEnvelope<T extends JsonValue> {
  schema: 'awkn-receipt-envelope/v1';
  receiptId: string;
  receiptType: ReceiptType;
  payloadSchema: string;
  executionId: string;
  traceId: string;
  runId?: string;
  stepId?: string;
  aggregateType: string;
  aggregateId: string;
  producer: ActorRef;
  status: 'SUCCESS' | 'FAILURE' | 'PARTIAL' | 'UNKNOWN';
  payload: T;
  payloadHash: string;
  artifactRefs: ObjectRef[];
  createdAt: string;
}
```

冻结决定：统一 `receipts` 表；分类 Payload 由 `payloadSchema` 校验。超出阈值的 Payload 外置 Artifact Store，Receipt 保存 Hash、摘要和 Ref。

## 十二、AuthorizationToken v1

采用服务端引用令牌，不使用自包含 JWT 作为首版权威：

```ts
interface AuthorizationRecord {
  schema: 'awkn-authorization-token/v1';
  authorizationId: string;
  tokenHash: string;
  actor: ActorRef;
  executionId: string;
  allowedToolIds: string[];
  allowedOperations: string[];
  targetConstraints: Record<string, JsonValue>;
  riskCeiling: 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  maxUses: number;
  usedCount: number;
  status: 'PENDING' | 'ACTIVE' | 'CONSUMED' | 'REVOKED' | 'EXPIRED';
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
}
```

规则：

- 客户端只持有随机 opaque token；数据库只保存 `sha256(token)`；
- Tool 执行前在事务中原子校验并预占一次使用；
- 外部调用失败可按 Policy 释放预占；副作用状态未知时不得释放；
- 撤销后所有未开始调用失败；
- 并发超出 `maxUses` 必须阻断；
- Token 不得跨 Execution、Actor 或 Target 使用；
- Token、凭据正文不得写入 Event、Receipt 或 Trace。

## 十三、Delivery、Outcome 与 Memory

- Delivery 证明“交付发生及位置”；
- Outcome 记录执行、交付、采用、业务和学习层结果；
- `UNKNOWN` 是合法 Outcome；
- MemoryWriteDecision 必须引用 Source Claim、确认级别、Sensitivity 和 Retention；
- Outcome 与 Memory 均不能修改已关闭的原始 Receipt。

## 十四、Event Envelope

```ts
interface DomainEvent<T extends JsonValue> {
  schema: 'awkn-domain-event/v1';
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateRevision: number;
  executionId: string;
  traceId: string;
  actor: ActorRef;
  idempotencyKey: string;
  receiptIds: string[];
  payloadSchema: string;
  payload: T;
  occurredAt: string;
}
```

事件按 `(aggregateId, aggregateRevision)` 唯一排序。Payload major 不兼容时 Replay MUST 停止并输出诊断。

## 十五、错误码

格式：

```text
AOS_<DOMAIN>_<REASON>
```

首批 P0：

```text
AOS_CONTRACT_SCHEMA_UNKNOWN
AOS_CONTRACT_VALIDATION_FAILED
AOS_HASH_CANONICALIZATION_FAILED
AOS_EXECUTION_REVISION_CONFLICT
AOS_EVENT_REVISION_CONFLICT
AOS_GOAL_NOT_ELIGIBLE
AOS_GOAL_EVIDENCE_INSUFFICIENT
AOS_GOAL_CONSTRAINT_FAILED
AOS_POLICY_CONFLICT
AOS_AUTH_REQUIRED
AOS_AUTH_SCOPE_MISMATCH
AOS_AUTH_REVOKED
AOS_AUTH_CONSUMED
AOS_SIDE_EFFECT_UNCERTAIN
AOS_MEMORY_REVISION_CONFLICT
AOS_PROTOCOL_INCOMPATIBLE
```

错误对象必须包含 `code`、`message`、`retryable`、`detailsRef?`、`receiptId?`，不得依赖 message 文本驱动状态机。

## 十六、兼容与扩展

- 枚举新增仅在消费者声明 `unknown` fallback 时兼容；
- 必填字段新增需要 major；
- 可选字段新增保持 major；
- 字段语义变化需要 major；
- 删除字段需要 major；
- 新 Receipt Type 可以兼容加入，但旧消费者必须保留并标记 Unknown Receipt；
- 所有协议适配器必须记录输入 Schema 与输出 Schema。

## 十七、Golden Fixtures

目录：

```text
runtime/test/fixtures/contracts/
├── canonical-json/
├── execution-envelope/
├── goal-spec/
├── claim/
├── receipt/
├── authorization/
└── memory-protocol/
```

每个 Fixture 包含：

```text
input.json
normalized.json
canonical.json
sha256.txt
expected-validation.json
```

必须覆盖：Unicode、CRLF/LF、字段顺序、`-0`、null/omitted、数组顺序、非法时间、未知 Schema、错误枚举和 Windows/Linux 一致性。

## 十八、WP-AOS-01 验收

1. Node 20、Windows 和 Linux 生成相同 Canonical Bytes 与 Hash；
2. 所有 Contract 使用 strict Zod；
3. 非法枚举和未知 major 确定性拒绝；
4. Claim v2 → v3 映射 Fixture 完整；
5. Receipt Envelope、Event Envelope 和 Authorization 原子使用规则有 Contract Test；
6. Core Contracts PR 不改造 AgentLoop 主链；
7. 所有后续 WP 只能引用本文件冻结的契约。