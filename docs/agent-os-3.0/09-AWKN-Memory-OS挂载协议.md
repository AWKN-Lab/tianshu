# AWKN Memory OS 挂载协议

> 文档编号：TS-AOS-MEM-009  
> 版本：v0.1 Draft  
> 关系：独立项目 + 天枢可插拔组件

## 一、定位

AWKN Memory OS保持独立仓库、独立发布和独立服务能力。天枢通过Memory Backend协议挂载Memory OS，并保留本地工作记忆、检查点和故障降级能力。

目标关系：

```text
Tianshu Runtime
├── Local Working Memory
├── Goal/Run/Checkpoint Store
├── Context Planner
├── Memory Write Gate
└── Memory Backend Router
      ├── LocalMemoryBackend
      └── AwknMemoryOsBackend
             ↓
       AWKN Memory OS
```

## 二、权威边界

### 2.1 天枢权威

- 当前Execution、Goal、Run、Step和Checkpoint；
- Context选择决策；
- Policy和Skill运行版本；
- 工具与模型路由；
- Memory Write Decision；
- Evolve回放与本地候选状态；
- Memory OS不可用时的降级决策。

### 2.2 Memory OS权威

- 跨会话长期Claim；
- Experience与Rule；
- Context Ledger；
- Immutable Render；
- Consumption、Citation和Outcome Attribution；
- 持久化事务与版本；
- 跨项目授权；
- Rule治理状态。

### 2.3 双方共享

- 协议版本；
- Project Identity；
- Actor Identity；
- Source Ref；
- Idempotency Key；
- Trace ID；
- Context Receipt和Render ID；
- Outcome和Authority Projection。

## 三、运行模式

```text
local
memory-os
auto
```

### local

- 只使用天枢本地MemoryService；
- 适合离线、开发和故障恢复；
- 长期跨项目能力受限。

### memory-os

- Memory OS是持久化权威；
- 协议或服务不可用时按Policy决定失败或等待；
- 适合正式环境。

### auto

- 优先Memory OS；
- Transport或Core 5xx时允许本地降级；
- 降级上下文必须标记`stale=true`；
- 4xx、权限错误和协议不兼容不能静默降级。

## 四、协议协商

天枢启动或首次调用时执行：

```text
GET /api/v1/protocol
→ Protocol Version
→ Feature Set
→ Schema Versions
→ Project Grant
→ SDK/Core Compatibility
```

最低要求：

- `awkn-core-sdk/1.x`；
- `context-ledger-v1`；
- `observed-usage-v1`；
- Context Assemble；
- Immutable Render；
- Consumption；
- Durable Capture或Outbox；
- Rule Governance。

Agent OS 3.0建议新增：

- `claim-lineage-v2`；
- `context-manifest-v1`；
- `memory-transaction-v2`；
- `outcome-attribution-v2`；
- `policy-skill-authority-v1`。

## 五、Context读取主链

```text
Context Planner
→ MemoryBackendRouter.compileAndRender()
→ Memory OS Assemble
→ Context Receipt
→ Empty Context判断
→ 非空：Immutable Render
→ Context Manifest绑定Receipt/Render
→ 模型调用
→ Citation/Usage/Consumption
```

### 5.1 空上下文

当Receipt有效且`item_count=0`：

- 保留Receipt ID；
- 不创建虚假Render；
- 不进入stale fallback；
- Context Manifest记录健康空结果；
- 后续模型正常执行。

### 5.2 非空上下文

必须：

- 绑定Render ID；
- Render内容Hash固定；
- Claim和Source Ref可追溯；
- Consumption绑定本次Execution；
- Citation只引用实际使用项。

## 六、写入主链

```text
Memory Write Gate
→ Memory Candidate
→ DLP/Persistence Guard
→ Source/Confirmation验证
→ Backend Selection
→ Memory Transaction
→ Memory OS Capture/Claim API
→ Write Receipt
→ Authority Projection
```

Memory OS不能替代天枢的Write Gate。Memory OS负责持久化验证和治理，天枢负责当前任务语义、用户确认范围和写入理由。

## 七、Memory Transaction v2

建议协议：

```json
{
  "schema": "awkn-memory-transaction/v2",
  "transaction_id": "mt_xxx",
  "idempotency_key": "...",
  "project_id": "tianshu",
  "actor_id": "u_xxx",
  "expected_revision": 6,
  "operations": [
    {
      "op": "upsert_claim",
      "claim": {}
    }
  ],
  "dependency_updates": [],
  "tombstones": [],
  "trace_id": "..."
}
```

返回：

```json
{
  "status": "COMMITTED",
  "revision": 7,
  "memory_ids": ["mem_xxx"],
  "conflicts": [],
  "receipt_id": "mwr_xxx"
}
```

## 八、并发与冲突

- 所有更新带Expected Revision；
- 冲突返回当前版本和冲突字段；
- 天枢重新读取并执行Merge Policy；
- 不同字段可以采用字段级CAS；
- 同一消息通过Idempotency Key去重；
- 冲突是正常协作状态，禁止覆盖式重试。

## 九、删除与依赖

删除流程：

```text
User Delete Request
→ Scope确认
→ Claim Tombstone
→ Dependency Graph查找
→ 派生Claim失效或重算
→ Context Index更新
→ Delete Receipt
```

要求：

- 审计事件保留最小Hash和时间；
- 有效上下文不再返回已删除内容；
- 完全依赖删除事实的派生项同步失效；
- Policy和Rule删除需要独立治理流程；
- 删除失败进入Outbox或人工处理。

## 十、Authority Outbox

天枢将以下事件写入Authority Outbox：

- Run终态；
- Step关键证据；
- Outcome Record；
- Memory Write Decision；
- Evolve Candidate与评测；
- Policy/Skill激活、隔离和回滚。

Outbox要求：

- 确定性幂等键；
- attempts和last_error；
- 校验和；
- 损坏记录进入Quarantine；
- 4xx不无限重试；
- 5xx和Transport错误按退避重试；
- 本地成功和远端权威未同步分开显示。

## 十一、Rule治理

建议继续保持单活：

```text
PROPOSED
→ REVIEWED
→ APPROVED
→ ACTIVE
→ PAUSED / RETIRED
```

天枢本地Candidate进入ACTIVE前，远端Rule必须ACTIVE。切换顺序：

```text
pause old remote
→ activate new remote
→ activate new local
→ retire old local
```

任一步失败执行反向补偿。

## 十二、降级语义

| 场景 | 行为 |
|---|---|
| Memory OS健康且空结果 | backend=memory-os, stale=false, no render |
| Memory OS健康且有结果 | Receipt + Render主链 |
| Transport/Core 5xx | auto模式可本地降级，stale=true |
| 401/403 | 停止，禁止降级规避权限 |
| 协议不兼容 | 停止，输出诊断 |
| Project Grant缺失 | 停止，等待配置 |
| Outbox积压 | 允许本地执行，明确权威同步状态 |

## 十三、独立运行能力

Memory OS独立项目需要保留：

- Core API；
- Python SDK；
- CLI；
- SQLite Migration；
- Wheel发布；
- Clean Install Gate；
- Protocol Smoke；
- Project Grant；
- DLP与Persistence Guard；
- Durable Outbox；
- Diagnose和Truth命令。

天枢不复制这些实现，只通过协议消费。

## 十四、配置

```text
AWKN_MEMORY_BACKEND=local|memory-os|auto
AWKN_MEMORY_OS_URL=http://127.0.0.1:8765
AWKN_MEMORY_OS_TOKEN=...
AWKN_MEMORY_OS_TOKEN_PATH=...
AWKN_PROJECT_ID=...
AWKN_MEMORY_SESSION_ID=...
AWKN_MEMORY_OS_OUTBOX=...
AWKN_MEMORY_OS_AUTO_GOVERNANCE=0|1
```

Agent OS 3.0建议增加：

```text
AWKN_MEMORY_PROTOCOL_MIN=awkn-core-sdk/1.0
AWKN_MEMORY_CLAIM_SCHEMA=awkn-claim/v2
AWKN_MEMORY_TRANSACTION_SCHEMA=awkn-memory-transaction/v2
AWKN_MEMORY_REQUIRE_AUTHORITY=0|1
```

## 十五、测试

1. 本地、远端、auto三模式；
2. 协议协商成功和失败；
3. 空Receipt不创建Render；
4. 非空Receipt强制Render；
5. 401/403不进入本地降级；
6. 5xx进入stale fallback；
7. Transaction CAS冲突；
8. Idempotency去重；
9. Tombstone和依赖失效；
10. Outbox重试和Quarantine；
11. 远端Rule单活；
12. 激活失败反向补偿；
13. Context Consumption和Outcome Attribution；
14. Clean Install环境真实握手。

## 十六、验收

- Memory OS可以独立发布和运行；
- 天枢可以通过统一协议挂载；
- 天枢本地模式不依赖Memory OS；
- auto降级语义准确；
- 每次远端上下文和写入都有Receipt；
- 权威规则单活、可回滚、可诊断。