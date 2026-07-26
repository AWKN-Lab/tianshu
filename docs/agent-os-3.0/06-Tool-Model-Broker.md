# Tool & Model Broker 工程设计

> 组件编号：C05  
> 工程动作：UPGRADE  
> 复用：LlmRouter、ToolRegistry、ToolPolicy、Approval、Trace

## 一、职责

Tool & Model Broker统一处理模型、工具和外部服务的选择与授权。它负责：

- 根据任务能力选择模型、工具和供应商；
- 评估成本、时延、数据边界和风险；
- 区分请求路由与实际路由；
- 绑定用户授权范围；
- 计算多步操作的累计风险；
- 校验工具调用后的真实副作用；
- 生成可审计Route和Execution Receipt。

## 二、主流程

```text
Compiled Policy/Skill Bundle
→ Capability Requirements
→ Available Models/Tools/Providers
→ Cost/Latency/Privacy/Risk Scoring
→ Provider Choice
→ Authorization Check
→ Broker Plan Freeze
→ Execute
→ Verify Side Effect
→ Receipts
```

## 三、Broker Plan

```ts
export interface BrokerPlan {
  schema: 'awkn-broker-plan/v1';
  brokerPlanId: string;
  executionId: string;
  modelRoutes: ModelRoutePlan[];
  toolRoutes: ToolRoutePlan[];
  providerChoices: ProviderChoice[];
  authorizationRequirements: AuthorizationRequirement[];
  cumulativeRisk: RiskSnapshot;
  costBudget: CostBudget;
  planHash: string;
  frozenAt: string;
}
```

## 四、模型路由

### 4.1 输入维度

- 能力：推理、编码、视觉、长文本、结构化输出、工具调用；
- 任务角色：执行、审核、分类、压缩、总结；
- 成本；
- 时延；
- 上下文容量；
- 数据位置和保留要求；
- 可用性；
- 领域评测表现；
- fallback兼容性。

### 4.2 Model Route Receipt

```ts
export interface ModelRouteReceipt {
  schema: 'awkn-model-route-receipt/v1';
  routeId: string;
  traceId: string;
  callSource: string;
  requestedProvider?: string;
  requestedModel?: string;
  executedProvider: string;
  executedModel: string;
  routeReasonCodes: string[];
  fallbackOccurred: boolean;
  fallbackChain: string[];
  capabilityDelta: string[];
  promptVersion: string;
  policyBundleHash: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  createdAt: string;
}
```

### 4.3 可见降级

当fallback可能影响结果质量或工具能力时：

- Run标记`DEGRADED`；
- Delivery附带能力影响摘要；
- 高影响任务可以要求重新确认；
- 独立Reviewer禁止回退到执行模型；
- 结构化输出能力缺失时停止执行。

## 五、工具路由

### 5.1 工具能力声明

```yaml
schema: awkn-tool-capability/v1
toolId: gmail.send
providerId: google
sideEffect: external_write
reversible: false
riskBase: R3
dataScopes:
  read: []
  write: [email_body, recipients]
requiresAuthorization: true
supportsIdempotency: true
supportsVerification: true
```

### 5.2 工具风险等级

| 等级 | 类型 | 控制 |
|---|---|---|
| R0 | 纯本地计算、无数据访问 | 默认允许 |
| R1 | 受限读取、临时文件 | Policy允许后执行 |
| R2 | 本地可逆写入 | 会话授权或项目授权 |
| R3 | 外部写入、发送、创建资源 | 单次明确授权 |
| R4 | 金钱、交易、生产发布 | 二次确认和范围冻结 |
| R5 | 高影响不可逆或跨域传播 | 人工审批、补偿方案和审计 |

## 六、Authorization Token

```ts
export interface AuthorizationToken {
  schema: 'awkn-authorization-token/v1';
  authorizationId: string;
  actorId: string;
  executionId: string;
  toolId: string;
  providerId?: string;
  allowedActions: string[];
  resourceScope: ResourceScope[];
  dataScope: string[];
  maxExecutions: number;
  expiresAt: string;
  confirmationSourceRef: string;
  tokenHash: string;
  state: 'ACTIVE' | 'CONSUMED' | 'REVOKED' | 'EXPIRED';
}
```

规则：

- Token绑定执行、工具、供应商和资源；
- 不能跨用户、跨项目、跨目标复用；
- 参数变化超出范围时重新授权；
- 使用后更新次数和状态；
- 用户撤销立即生效；
- 环境变量长期授权逐步降级为开发兼容模式。

## 七、供应商选择

当用户点名供应商时，Broker验证可用性和权限后使用。用户未点名且多个第三方供应商都可完成任务时：

- 返回可选供应商；
- 标注数据范围、价格和能力差异；
- 由用户选择；
- 已存在持久偏好且仍有效时可以直接选择；
- 内部基础设施可以按组织Policy自动路由。

## 八、累计风险

单次动作风险与会话组合风险分开计算。

```text
CumulativeRisk =
BaseActionRisk
+ DataAggregationRisk
+ Irreversibility
+ CrossSystemPropagation
+ FinancialImpact
+ IdentityRepresentation
+ RepetitionFactor
- VerifiedCompensation
```

示例：

```text
读取联系人 R1
+ 读取日历 R1
+ 生成外发内容 R1
+ 发送邮件 R3
→ 累计风险可能提升到R4
```

达到阈值后触发：

- 更高授权；
- 参数摘要；
- 二次确认；
- 人工审核；
- 限制批量数量；
- 禁止自动重试。

## 九、Side-effect Verification

工具返回成功不等于外部状态已完成。

Broker需要：

1. 读取工具原始结果；
2. 提取资源ID或状态；
3. 必要时调用只读验证；
4. 生成Tool Execution Receipt；
5. 失败时执行补偿或标记PARTIAL；
6. 避免在不确定状态下自动重试不可逆动作。

## 十、Tool Execution Receipt

```json
{
  "schema": "awkn-tool-execution-receipt/v1",
  "toolCallId": "tc_xxx",
  "toolId": "github.create_file",
  "authorizationId": "auth_xxx",
  "requestHash": "sha256",
  "resultHash": "sha256",
  "sideEffect": "external_write",
  "resourceRefs": ["repo:path"],
  "reportedSuccess": true,
  "verifiedSuccess": true,
  "reversible": true,
  "compensationRef": null,
  "createdAt": "ISO-8601"
}
```

## 十一、现有代码改造

### REUSE

- `runtime/src/llm/router.ts`
- `runtime/src/tools/registry.ts`
- `runtime/src/tools/policy.ts`
- `runtime/src/approval-*`
- `runtime/src/observability/trace.ts`

### UPGRADE

- LlmRouter成为Model Adapter，不再独立拥有最终路由权；
- ToolRegistry通过ToolBroker执行；
- ToolPolicy输出风险、授权要求和数据范围；
- Trace持久化Model Route Receipt；
- fallback返回能力差异；
- Tool调用加入幂等键和验证接口。

### NEW

- `broker/broker.ts`
- `broker/model-broker.ts`
- `broker/tool-broker.ts`
- `broker/authorization.ts`
- `broker/cumulative-risk.ts`
- `broker/provider-choice.ts`
- `broker/receipts.ts`

## 十二、测试

1. 请求模型和实际模型都被记录；
2. fallback链完整记录；
3. Reviewer不允许回退到Executor；
4. R3以上动作没有Token时被拒绝；
5. Token不能跨项目使用；
6. 参数变化超出授权范围时被拒绝；
7. 多步动作累计风险能够升级；
8. 外部工具报告成功但验证失败时进入PARTIAL；
9. 不可逆动作不自动重复；
10. 用户未选择第三方供应商时系统不擅自决定。

## 十三、验收

- 所有模型调用生成Model Route Receipt；
- 所有有副作用工具生成Authorization和Execution Receipt；
- 累计风险可查询；
- fallback和降级对Outcome可见；
- 现有Trae、Codex、MiniMax Provider继续兼容；
- 现有read/write/exec/skill工具通过Adapter接入。