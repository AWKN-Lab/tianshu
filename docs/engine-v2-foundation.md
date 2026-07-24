# Engine v2 Foundation

## 目标架构

```text
Control Plane
  ↓
Agent Graph
  ↓
Durable Workflow Kernel
  ↓
Evidence & Quality
  ↓
Tool Runtime
  ↓
Model Gateway
  ↓
Memory Plane
  ↓
Data & Observability
```

## 本批次落地

### Provider 协议

统一使用 Canonical Message，Provider 必须保留 assistant `tool_calls`、tool `tool_call_id`、工具定义与工具选择策略。

### 工具策略

```text
Tool Request
→ Permission Check
→ Workspace Boundary
→ Sensitive Path Check
→ Command Policy
→ Execute
```

### 证据审查

cicd-tester 输入升级为 Artifact Bundle：Git HEAD、Git status、unified diff、diff SHA-256、typecheck/test/lint 结果与 Agent 最终产物。

### 数据模型

新增 `schema_migrations`、`runs`、`steps`、`events`、`artifacts`、`approvals`、`model_calls`。

## 后续工作包

1. 通用 L2 自动独立 Review；
2. 容器化 Tool Sandbox；
3. Cron Worker Lease、幂等键与死信队列；
4. Artifact Store 与 OpenTelemetry Trace；
5. 经验候选的回放评测、晋级与回滚。
