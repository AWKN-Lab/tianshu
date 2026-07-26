# Trusted Input Gateway 工程设计

> 组件编号：C01  
> 工程动作：NEW，复用现有 DLP、Trace 脱敏和 Tool Policy 安全规则

## 一、职责

Trusted Input Gateway 是天枢所有执行入口的统一前置层。任何 Chat、CLI、API、Cron、Hook、文件、Connector 或垂直项目请求都必须先生成 `TrustedInput`，后续组件不得直接消费原始输入。

## 二、输入类型

```ts
export type InputSource =
  | 'chat'
  | 'cli'
  | 'api'
  | 'cron'
  | 'hook'
  | 'file'
  | 'connector'
  | 'domain_adapter'
  | 'replay';
```

## 三、核心流程

```text
Raw Input
→ Source Verification
→ Identity Resolution
→ Project/Tenant Binding
→ File/URL Presence Check
→ DLP & Secret Scan
→ Prompt Injection Scan
→ Content Risk Classification
→ Normalization
→ Input Receipt
→ TrustedInput
```

## 四、核心契约

```ts
export interface InputEnvelope {
  schema: 'awkn-input-envelope/v1';
  inputId: string;
  source: InputSource;
  receivedAt: string;
  actorHint?: Record<string, string>;
  projectHint?: string;
  text?: string;
  files?: InputFileRef[];
  urls?: string[];
  connectorRefs?: ConnectorRef[];
  metadata?: Record<string, unknown>;
}

export interface TrustedInput {
  schema: 'awkn-trusted-input/v1';
  inputId: string;
  actor: ActorRef;
  scope: ExecutionScope;
  normalizedText: string;
  attachmentRefs: TrustedAttachmentRef[];
  sourceHash: string;
  sanitizedHash: string;
  redactions: RedactionRecord[];
  injectionSignals: InjectionSignal[];
  risk: InputRiskDecision;
  receiptId: string;
}
```

## 五、子模块

### 5.1 SourceVerifier

负责：

- 校验输入来源是否合法；
- 校验 Connector Ref、File Ref 和 Replay Ref；
- 记录来源系统和来源时间；
- 拒绝伪造内部事件；
- 外部文件与用户陈述分开标记。

### 5.2 IdentityResolver

输入：Session、Token、Connector Identity、CLI Profile。  
输出：`ActorRef + ExecutionScope`。

约束：

- 不允许默认为高权限用户；
- 无法确认身份时进入 `IDENTITY_UNRESOLVED`；
- Replay 使用原执行身份快照，禁止继承当前管理员权限；
- Cron 使用创建任务时冻结的授权主体。

### 5.3 AttachmentVerifier

必须检查：

- 用户声明的文件是否存在；
- MIME、扩展名、大小和Hash；
- 文件是否来自可访问位置；
- 是否需要专用解析器；
- PDF、图片和二进制文件是否经过正确读取；
- 文件内容内的指令属于不可信数据。

### 5.4 DlpSanitizer

复用 `runtime/src/memory/dlp.ts` 的规则，并上移为公共能力。

处理级别：

```text
ALLOW
REDACT
TOKENIZE
QUARANTINE
BLOCK
```

敏感内容包括：

- 密钥、Token、Cookie、认证头；
- `.env` 和凭据文件；
- 个人敏感数据；
- 业务机密字段；
- 外部系统不可传播的数据。

### 5.5 InjectionGuard

检测：

- 文件或网页伪装成系统指令；
- 要求忽略上层规则；
- 要求泄露 Prompt、Secret 或 Memory；
- 要求绕过授权；
- 工具结果中嵌入下一步恶意指令；
- Memory、Skill、Policy 内容中的持久化注入。

输出只包含风险类别与处理结果，避免向下游暴露详细绕过方法。

### 5.6 InputRiskClassifier

```ts
export interface InputRiskDecision {
  level: 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  categories: string[];
  blocked: boolean;
  requiresRestrictedMode: boolean;
  requiresHumanReview: boolean;
  reasonCodes: string[];
}
```

输入风险只负责初筛，最终行动风险由 Tool & Model Broker 计算。

## 六、Input Receipt

```json
{
  "schema": "awkn-input-receipt/v1",
  "receiptId": "ir_xxx",
  "inputId": "in_xxx",
  "source": "chat",
  "actorId": "u_xxx",
  "projectId": "tianshu",
  "sourceHash": "sha256",
  "sanitizedHash": "sha256",
  "redactionCount": 2,
  "injectionRisk": "low",
  "riskLevel": "R1",
  "decision": "ALLOW",
  "createdAt": "ISO-8601"
}
```

## 七、存储与隐私

- 原始正文默认不进入 Trace；
- 原始输入可以由上层产品保存，天枢只保留引用和Hash；
- Redaction Map 需要加密并按用途授权；
- Blocked 输入保留最小审计信息；
- 文件解析产生的临时文件有TTL；
- Input Receipt 为追加写记录。

## 八、接口

```ts
export interface TrustedInputGateway {
  process(input: InputEnvelope, runtime: GatewayRuntimeContext): Promise<TrustedInput>;
  verifyReceipt(receiptId: string): Promise<boolean>;
}
```

## 九、与现有代码集成

### REUSE

- `memory/dlp.ts`
- `observability/trace.ts` 脱敏逻辑
- `tools/policy.ts` 敏感路径列表
- EventStore

### UPGRADE

- 把安全规则抽为 `security/common/`；
- AgentLoop入口接受 `TrustedInput`；
- CLI、Cron和Hook先调用Gateway；
- 文件工具返回 `TrustedAttachmentRef`。

### DEPRECATE

- `AgentLoop.runL1(userInput: string)` 长期升级为 `runL1(input: TrustedInput)`；
- 下游自行判断文件是否存在；
- 仅依赖Prompt提醒模型忽略文件内恶意指令。

## 十、错误与恢复

| 错误 | 是否重试 | 处理 |
|---|---|---|
| 文件不存在 | 条件重试 | 返回缺失Ref，允许用户补充 |
| 身份无法确认 | 否 | WAITING_USER或BLOCKED |
| DLP服务失败 | 是 | Restricted Mode，禁止外发 |
| Injection风险高 | 否 | BLOCKED或隔离解析 |
| Hash不一致 | 是 | 重新读取，仍失败则隔离 |

## 十一、测试

### 契约测试

1. 缺失文件不能生成“已读取”Receipt；
2. 用户文本和文件文本来源分离；
3. `.env`、私钥和Token被阻断或脱敏；
4. 文件内系统指令不能改变Policy；
5. Replay不能继承当前高权限；
6. 同一原始输入产生稳定sourceHash；
7. 清洗变化导致sanitizedHash变化；
8. 日志不包含原始Secret。

### 对抗测试

- 嵌套Markdown和XML注入；
- 工具输出注入；
- Memory注入；
- Skill注入；
- Unicode混淆；
- 扩展名与MIME不一致；
- 超大文件和压缩炸弹。

## 十二、验收

- 所有运行入口都通过Gateway；
- 每次执行都有Input Receipt；
- 下游无法访问未授权原始Secret；
- 文件存在性和身份边界有确定性测试；
- Gateway失败时不允许高风险降级执行。