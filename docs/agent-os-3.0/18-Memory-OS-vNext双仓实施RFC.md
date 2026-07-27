# Memory OS vNext 双仓实施 RFC

> 文档编号：TS-AOS-MEMRFC-018  
> 版本：v1.0 Draft  
> 关联：PR #25、Issue #33、WP-AOS-17  
> 仓库：`AWKN-Lab/tianshu` ↔ `AWKN-Lab/AWKN-Memory-OS`

## 一、状态与范围

本 RFC 冻结天枢与 AWKN Memory OS 的协议边界、兼容规则、双仓开发顺序、发布顺序和故障补偿。

协议只覆盖：

```text
Tianshu Runtime
↕ MemoryBackend Protocol
AWKN Memory OS Core / SDK
```

不覆盖其他 AWKN 业务仓库，也不形成其他项目到天枢的传递依赖。

## 二、实施拆分

### WP17A：Protocol Contracts

随 WP01、Claim、Context 同步推进：

- Protocol Descriptor；
- Project Grant；
- Claim Lineage v2；
- Context Manifest v1；
- Context Receipt / Immutable Render；
- Memory Transaction v2；
- Outcome Attribution v2；
- Golden Protocol Fixtures；
- 错误码与兼容矩阵。

WP17A 只冻结协议和 Fixture，不要求主链 enforce。

### WP17B：Adapter & Governance

依赖 Memory Write Gate、Outcome、Evolve：

- Tianshu Memory Backend Adapter；
- Authority Outbox；
- Rule 单活治理；
- Tombstone 与依赖传播；
- local/memory-os/auto；
- Diagnose 与 Protocol Smoke；
- 双仓 Release Manifest。

## 三、权威边界

### 3.1 天枢权威

- 当前 Execution、Goal、Run、Step、Checkpoint；
- Input、Intent、Context 选择决策；
- Policy/Skill Bundle；
- Model/Tool/Authorization；
- GoalJudgement；
- Delivery 与当前 Outcome Record；
- MemoryWriteDecision；
- 本地 Evolve Candidate；
- Feature Flag Snapshot；
- 降级决策。

### 3.2 Memory OS 权威

- 跨会话长期 Claim；
- Experience、Rule；
- Context Ledger；
- Immutable Render；
- Consumption、Citation、长期 Outcome Attribution；
- 持久化 Transaction Revision；
- Project Grant；
- Rule Authority 状态；
- Tombstone 和依赖传播结果。

### 3.3 共享协议对象

- Protocol Descriptor；
- Project/Client/Actor Identity；
- SourceRef；
- Claim v3 兼容投影；
- Context Receipt；
- Render Ref；
- Idempotency Key；
- Trace/Execution Ref；
- Outcome Attribution；
- Authority Projection。

## 四、协议版本

### 4.1 Protocol Descriptor

```json
{
  "schema": "awkn-memory-protocol-descriptor/v1",
  "protocolVersion": "memory-backend/2.0",
  "coreVersion": "...",
  "sdkVersion": "...",
  "featureSet": [
    "claim-lineage-v2",
    "context-manifest-v1",
    "memory-transaction-v2",
    "outcome-attribution-v2",
    "policy-skill-authority-v1"
  ],
  "schemaVersions": {},
  "minClientVersions": { "tianshu": "..." },
  "serverTime": "ISO-8601",
  "instanceId": "..."
}
```

### 4.2 协商

天枢在启动或首次使用远端 Backend 时：

```text
GET /api/v1/protocol
→ 校验 Transport/TLS
→ 校验 Protocol Major
→ 校验 Required Feature
→ 校验 Schema Major
→ 获取 Project Grant
→ 生成 ProtocolNegotiationReceipt
→ 缓存有时效的 Protocol Session
```

未知 major、缺少 Required Feature、SDK/Core 不兼容必须停止远端调用。

## 五、运行模式

```text
local
memory-os
auto
```

### local

- 只使用天枢 Local Memory；
- 不进行远端协议协商；
- 适用于离线、开发、恢复；
- 不伪装成 Memory OS 权威。

### memory-os

- Memory OS 是长期持久化权威；
- 服务不可用时按 Policy 等待或失败；
- 禁止静默降级。

### auto

- 优先 Memory OS；
- Transport/Core 5xx 可使用 Local stale fallback；
- 401/403、Grant、协议不兼容、Schema 不兼容禁止降级；
- 降级结果必须 `backend=local`、`stale=true` 并绑定 DegradationReceipt。

## 六、Project Grant

```ts
interface MemoryProjectGrant {
  schema: 'awkn-memory-project-grant/v1';
  projectId: string;
  clientId: 'tianshu';
  allowedOperations: string[];
  allowedMemoryClasses: string[];
  actorScopes: string[];
  allowedSourceScopes: string[];
  expiresAt?: string;
  revision: number;
  grantHash: string;
}
```

规则：

- 天枢使用独立 `projectId` 和 `clientId=tianshu`；
- Grant 不能复用其他项目；
- 检索、写入、删除、Rule 治理均校验 Grant；
- Grant 变化触发重新协商；
- 401/403 不允许 local fallback 规避；
- 返回越界 Claim 时天枢拒绝整批响应并记录 ScopeViolationReceipt。

## 七、建议 Endpoint

以下为 vNext 协议目标，不声明现有服务已经实现：

| Method | Endpoint | 作用 |
|---|---|---|
| GET | `/api/v1/protocol` | 协议、Feature、Schema、版本 |
| GET | `/api/v1/projects/{projectId}/grant` | Project Grant |
| POST | `/api/v2/context/assemble` | Context 候选、Receipt、Render |
| POST | `/api/v2/context/consume` | 实际使用、Citation、Consumption |
| POST | `/api/v2/memory/transactions` | CAS 持久化事务 |
| GET | `/api/v2/memory/transactions/{id}` | 事务状态查询 |
| POST | `/api/v2/outcomes/attributions` | Outcome Attribution |
| POST | `/api/v1/authority/rules/transitions` | Rule pause/activate/retire |
| GET | `/api/v1/authority/rules/{id}` | Rule 权威状态 |
| POST | `/api/v2/tombstones` | 删除和依赖传播 |
| GET | `/api/v1/diagnostics/truth` | 协议和权威诊断摘要 |

所有写 Endpoint 必须支持 `Idempotency-Key`。

## 八、Context Assemble

### 8.1 请求

```json
{
  "schema": "awkn-context-assemble-request/v2",
  "projectId": "tianshu",
  "clientId": "tianshu",
  "actor": {},
  "executionId": "exec_xxx",
  "traceId": "tr_xxx",
  "query": "...",
  "queryHash": "...",
  "tokenBudget": 4000,
  "maxItems": 100,
  "requiredMemoryClasses": [],
  "freshnessPolicy": {},
  "sensitivityPolicy": {},
  "grantHash": "..."
}
```

### 8.2 响应

```json
{
  "schema": "awkn-context-assemble-response/v2",
  "receipt": {
    "receiptId": "...",
    "itemCount": 0,
    "candidateCount": 0,
    "selectionPolicyVersion": "...",
    "grantHash": "...",
    "createdAt": "..."
  },
  "render": null,
  "items": [],
  "backendRevision": 12
}
```

### 8.3 健康空结果

当 Receipt 有效且 `itemCount=0`：

- `render` MUST 为 null；
- `stale=false`；
- 不触发 local fallback；
- 天枢 Context Manifest 保存 Receipt Ref；
- 模型调用继续执行。

### 8.4 非空结果

- Render 必须存在；
- Render Hash 固定；
- Item、Claim、SourceRef 可追溯；
- 所有 Item 处于 Grant Scope；
- Consumption 只记录实际使用项；
- Citation 不得引用未使用项。

## 九、Context Consume

```json
{
  "schema": "awkn-context-consumption/v2",
  "receiptId": "...",
  "renderId": "...",
  "executionId": "...",
  "traceId": "...",
  "usedItemIds": [],
  "citationRefs": [],
  "responseHash": "...",
  "outcome": "SUCCESS|FAILURE|PARTIAL|UNKNOWN",
  "idempotencyKey": "..."
}
```

Consume 失败不得修改本地模型响应；失败进入 Outbox，并明确 `consumptionSyncStatus`。

## 十、Claim Lineage v2

协议层不强制 Memory OS 内部采用天枢表结构，但语义必须兼容：

- originator 与 speaker 分离；
- epistemicStatus 与 confirmationLevel 分离；
- SourceRef 和 Source Span；
- derivedFrom；
- Project/Actor Scope；
- Sensitivity；
- validFrom/validUntil；
- Tombstone；
- Revision/CAS。

天枢发送 `awkn-claim/v3`。Memory OS 可以保存内部版本，但返回时必须声明映射版本和 Loss Report。发生不可接受语义丢失时拒绝写入。

## 十一、Memory Transaction v2

### 11.1 请求

```json
{
  "schema": "awkn-memory-transaction/v2",
  "transactionId": "mtx_xxx",
  "idempotencyKey": "...",
  "projectId": "tianshu",
  "clientId": "tianshu",
  "actor": {},
  "executionId": "exec_xxx",
  "traceId": "tr_xxx",
  "expectedRevision": 6,
  "operations": [
    {
      "ordinal": 0,
      "operation": "upsert_claim",
      "payloadSchema": "awkn-claim/v3",
      "payload": {},
      "payloadHash": "..."
    }
  ],
  "dependencyUpdates": [],
  "tombstones": [],
  "grantHash": "..."
}
```

### 11.2 成功

```json
{
  "schema": "awkn-memory-transaction-result/v2",
  "transactionId": "mtx_xxx",
  "status": "COMMITTED",
  "revision": 7,
  "memoryRefs": [],
  "conflicts": [],
  "receiptId": "..."
}
```

### 11.3 冲突

```json
{
  "status": "CONFLICT",
  "currentRevision": 8,
  "conflicts": [
    {
      "path": "/operations/0/payload/content",
      "currentHash": "...",
      "submittedHash": "...",
      "currentValueRef": {}
    }
  ]
}
```

规则：

- 天枢重新读取并执行 Merge Policy；
- 禁止覆盖式自动重试；
- 同一 Idempotency Key 返回同一结果；
- 跨 Project 操作拒绝；
- 部分提交禁止，事务全成或全败；
- 事务响应 Receipt 必须可查询。

## 十二、Outcome Attribution v2

天枢当前 Outcome 是执行会话权威；Memory OS 保存长期归因观察。

```json
{
  "schema": "awkn-outcome-attribution/v2",
  "outcomeId": "out_xxx",
  "executionId": "exec_xxx",
  "projectId": "tianshu",
  "dimensions": {
    "execution": "POSITIVE",
    "delivery": "POSITIVE",
    "adoption": "UNKNOWN",
    "business": "UNKNOWN",
    "learning": "PENDING"
  },
  "contributors": [],
  "evidenceRefs": [],
  "method": "...",
  "observedAt": "...",
  "idempotencyKey": "..."
}
```

Memory OS 返回长期 Observation 时，天枢以新 Outcome Observation 更新 revision，不改写历史 Receipt。

## 十三、Policy/Skill Authority v1

Memory OS 保存 Rule 权威状态，天枢保存运行 Bundle 和本地 Candidate。

### 13.1 Authority Key

```text
clientId + projectId + assetType + scope + assetId
```

同一 Authority Key 只允许一个 ACTIVE revision。

### 13.2 Transition 请求

```json
{
  "schema": "awkn-authority-transition/v1",
  "transitionId": "...",
  "assetType": "POLICY|SKILL|PROMPT|MODEL_ROUTE|TOOL_ROUTE|GATE|CONTEXT_RULE|DELIVERY_RULE",
  "assetId": "...",
  "fromStatus": "ACTIVE",
  "toStatus": "PAUSED",
  "expectedRevision": 3,
  "artifactHash": "...",
  "evaluationReceiptRefs": [],
  "idempotencyKey": "..."
}
```

## 十四、错误分类与 HTTP 语义

| 类别 | HTTP | 天枢行为 |
|---|---:|---|
| Validation | 400 | BLOCK，修正请求 |
| Authentication | 401 | BLOCK，禁止降级 |
| Authorization/Grant | 403 | BLOCK，禁止降级 |
| Not Found | 404 | 按对象语义处理，不自动创建 |
| Revision Conflict | 409 | 重新读取，Merge Policy |
| Schema/Protocol Incompatible | 412/426 | BLOCK，诊断 |
| Rate Limit | 429 | 按 Retry-After，允许等待 |
| Core Error | 500/503 | memory-os 模式失败；auto 可 stale fallback |
| Timeout/Transport | 无 HTTP | 查询状态；读可 fallback，写进入 Outbox/UNKNOWN |

协议错误对象：

```json
{
  "schema": "awkn-protocol-error/v1",
  "code": "MEMORY_REVISION_CONFLICT",
  "message": "...",
  "retryable": false,
  "details": {},
  "receiptId": "...",
  "serverTraceId": "..."
}
```

P0 错误码：

```text
MEMORY_PROTOCOL_INCOMPATIBLE
MEMORY_SCHEMA_INCOMPATIBLE
MEMORY_GRANT_MISSING
MEMORY_GRANT_SCOPE_VIOLATION
MEMORY_AUTHENTICATION_FAILED
MEMORY_AUTHORIZATION_FAILED
MEMORY_REVISION_CONFLICT
MEMORY_IDEMPOTENCY_CONFLICT
MEMORY_TRANSACTION_UNKNOWN
MEMORY_RENDER_REQUIRED
MEMORY_RENDER_UNEXPECTED
MEMORY_OUTBOX_QUARANTINED
MEMORY_RULE_SINGLE_ACTIVE_CONFLICT
```

## 十五、Authority Outbox

### 15.1 本地提交

以下在天枢本地事务中与业务状态同时写 Outbox：

- Run 终态；
- Step 关键 Evidence；
- Outcome Record/Observation；
- MemoryWriteDecision；
- Memory Transaction；
- Evolve Candidate 评测；
- Rule Authority Transition。

### 15.2 状态

```text
PENDING
→ SENDING
→ SUCCEEDED

SENDING → PENDING       # lease 过期且允许重试
SENDING → FAILED
FAILED → PENDING        # retryable
FAILED → QUARANTINED    # 非重试或损坏
```

### 15.3 重试

- 5xx/Transport：指数退避 + jitter；
- 429：尊重 Retry-After；
- 400/401/403/412/426：不无限重试；
- 409：进入 Merge/Conflict 流程；
- Payload Hash 不一致：Quarantine；
- 每次尝试记录 Attempt Receipt。

## 十六、Rule 单活与补偿

发布顺序：

```text
1. pause old remote
2. activate new remote
3. activate new local
4. retire old local
```

失败补偿：

| 失败点 | 补偿 |
|---|---|
| 1 失败 | 保持旧版本，停止 |
| 2 失败 | resume old remote |
| 3 失败 | pause new remote，resume old remote |
| 4 失败 | 新版本保持 ACTIVE，旧本地标记 RETIRE_PENDING 并重试 |

任何补偿失败进入 `AUTHORITY_INCONSISTENT`，天枢阻断相关资产的新 Execution。

## 十七、删除与 Tombstone

```text
User Delete Request
→ 天枢确认 Scope
→ MemoryWriteDecision=DELETE
→ Tombstone Transaction
→ Memory OS Dependency Graph
→ 派生 Claim 失效/重算
→ Context Index 更新
→ Delete Receipt
→ 天枢本地 Projection 更新
```

要求：

- 删除范围不能越过 Project Grant；
- 已删除正文不再进入 Context；
- 审计只保留最小 Hash、时间、Scope 和 Receipt；
- 删除失败进入 Outbox；
- Policy/Rule 删除走 Authority 流程；
- 本地删除不能代替远端 Tombstone。

## 十八、双仓 Golden Fixtures

两个仓库必须使用同一 Fixture 包：

```text
protocol-fixtures/
├── descriptor/
├── project-grant/
├── context-empty/
├── context-render/
├── context-consume/
├── claim-lineage/
├── transaction-commit/
├── transaction-conflict/
├── tombstone/
├── outcome-attribution/
├── rule-authority/
└── protocol-errors/
```

Fixture 包含请求、响应、Canonical JSON、Hash、预期 HTTP/错误码和兼容版本。

Fixture 发布为版本化 Artifact，不通过复制粘贴维护两份独立内容。

## 十九、兼容矩阵

| Tianshu | Protocol | Memory OS Core | SDK | 状态 |
|---|---|---|---|---|
| Engine v2 | 1.x | 当前稳定版 | 当前稳定版 | Legacy Supported |
| AOS 3.0 Shadow | 2.0 + 1.x fallback | vNext RC | vNext RC | Dual Test |
| AOS 3.0 RC | 2.0 | vNext RC/Stable | vNext Stable | Required |
| AOS 3.0 Stable | 2.x | vNext Stable | vNext Stable | Supported |

精确版本号在双方 Release Manifest 中维护。禁止仅写“latest”。

## 二十、双仓开发顺序

```text
Tianshu Contract Draft
+ Memory OS Contract Draft
→ Golden Fixture PR
→ Memory OS Core 实现
→ Memory OS SDK 实现
→ Memory OS Protocol Smoke
→ Tianshu Adapter Shadow
→ 双仓 Integration
→ Authority/Outbox
→ Canary
→ RC
```

分支建议：

```text
Tianshu: feat/memory-protocol-vnext-adapter
Memory OS: feat/protocol-vnext-core
Memory OS SDK: feat/protocol-vnext-sdk
```

每个仓库独立 PR、独立 CI、独立 Release Manifest。

## 二十一、发布顺序

1. 合并共同 Fixture 与协议文档；
2. 发布 Memory OS Core RC；
3. 发布 Memory OS SDK RC；
4. 运行 Wheel Clean Install、Linux/Windows、Protocol Smoke；
5. 合并天枢 Adapter，默认 Flag `0`；
6. 开启 Shadow；
7. 修复协议差异；
8. 发布 Memory OS Stable；
9. 天枢 enforce 小流量；
10. 天枢 Agent OS RC。

Memory OS 未发布兼容 Stable 前，天枢不得将 vNext 设为默认 enforce。

## 二十二、Release Manifest

### Tianshu

```json
{
  "repository": "AWKN-Lab/tianshu",
  "commitSha": "...",
  "adapterVersion": "...",
  "requiredProtocol": "memory-backend/2.0",
  "requiredFeatures": [],
  "fixtureBundleHash": "...",
  "schemaVersion": 19,
  "artifactHashes": []
}
```

### Memory OS

```json
{
  "repository": "AWKN-Lab/AWKN-Memory-OS",
  "commitSha": "...",
  "coreVersion": "...",
  "sdkVersion": "...",
  "protocolVersion": "memory-backend/2.0",
  "featureSet": [],
  "fixtureBundleHash": "...",
  "migrationVersion": "...",
  "artifactHashes": []
}
```

## 二十三、Protocol Smoke

Smoke 必须覆盖：

1. Descriptor；
2. Grant；
3. 健康空 Context，无 Render；
4. 非空 Context，强制 Render；
5. Consume；
6. Transaction Commit；
7. Idempotency；
8. CAS Conflict；
9. Tombstone；
10. Outcome Attribution；
11. Rule Transition；
12. 401/403；
13. 5xx/Transport；
14. Schema/Protocol incompatible；
15. Outbox 重放；
16. Windows/Linux；
17. SDK Clean Install。

## 二十四、降级与故障

| 场景 | local | memory-os | auto |
|---|---|---|---|
| 健康空结果 | 本地空 | 远端空 | 远端空 |
| 健康非空 | 本地结果 | Receipt+Render | Receipt+Render |
| Transport/5xx 读 | 本地 | 失败/等待 | local stale fallback |
| Transport/5xx 写 | 本地提交 | Outbox/失败 | Outbox/Deferred |
| 401/403 | 不适用 | BLOCK | BLOCK |
| Protocol incompatible | 不适用 | BLOCK | BLOCK |
| Grant 缺失 | 不适用 | BLOCK | BLOCK |
| CAS Conflict | 本地 CAS | Merge | Merge |
| Outbox 积压 | 不适用 | 显示待同步 | 显示待同步 |
| 返回越界 Claim | 拒绝 | 拒绝 | 拒绝，不 fallback |

## 二十五、诊断

天枢：

```text
awkn memory protocol
awkn memory grant
awkn memory context --execution <id>
awkn memory transaction --id <id>
awkn memory outbox
awkn memory authority
```

Memory OS：

```text
memory-os diagnose
memory-os truth
memory-os protocol
memory-os grant --project tianshu
memory-os outbox
memory-os rule authority
```

诊断输出不得包含 Token、Secret 或未脱敏正文。

## 二十六、安全

- Token 通过安全配置或 Token Path 提供；
- Trace、Event、Receipt 只保存 Token Hash/Ref；
- TLS 和证书策略由部署环境冻结；
- Project Grant 是服务端最终权威；
- 天枢 DLP 不替代 Memory OS Persistence Guard；
- Memory OS 返回内容仍经过天枢 Context 权限和敏感度检查；
- 外部文档指令不能改变协议配置；
- 其他项目不能借 Memory OS Grant 访问天枢数据。

## 二十七、验收

1. 双仓共享同一 Golden Fixture Hash；
2. 协议不兼容在启动或首次调用时识别；
3. 401/403 不允许 local 降级；
4. 5xx/Transport 降级状态准确；
5. 健康空 Context 保留 Receipt 且无 Render；
6. Transaction CAS 不覆盖式重试；
7. Tombstone 与依赖传播可验证；
8. Rule 切换失败可补偿；
9. 两仓分别具备 Commit、Manifest、Artifact Hash、Linux/Windows 和 Smoke 证据；
10. 当前 RFC 完成协议设计，不声明 Memory OS vNext 已开发或发布。