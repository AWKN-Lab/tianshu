# Observability and OpenTelemetry

天枢运行时使用 W3C 长度的 `trace_id` 与 `span_id`，同一 L2 Run 内的模型调用、工具调用、质量 Gate 和 Run 状态共享一个 Trace。

## Span 语义

| Span | 关键属性 |
|---|---|
| `workflow.run.*` | `workflow.name`、`run.id`、`run.status` |
| `gen_ai.chat` | Provider、模型、Token、finish reason、fallback、延迟 |
| `tool.execute` | 工具名、权限级别、审批、沙箱状态、结果大小 |
| `quality.gate` | Gate 名称、通过状态、Goal、Cycle、耗时 |

Prompt、消息正文、Authorization、Cookie、API Key、Secret、Password 和请求/响应 Body 默认脱敏。Token 指标保留数值。

## 本地 JSONL

默认写入：

```text
runtime/data/traces.jsonl
```

配置：

```bash
AWKN_TRACE_FILE=/var/log/awkn/traces.jsonl
AWKN_TRACE_LOCAL=0
```

`AWKN_TRACE_LOCAL=0` 可关闭本地文件导出。

## OTLP/HTTP JSON

```bash
OTEL_SERVICE_NAME=awkn-engine-runtime
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20token
```

当 Endpoint 未包含 `/v1/traces` 时，运行时自动补齐。OTLP JSON 的 bytes 字段按 Base64 编码。
