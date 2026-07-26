# Agent OS Core Contract Golden Fixtures

这些 Fixture 是天枢 Agent OS 3.0 Core Contracts 的字节级兼容基线。

## 目录协议

每个 Golden Case 必须包含：

```text
input.json
normalized.json
canonical.json
sha256.txt
expected-validation.json
```

- `input.json`：进入迁移器或 Schema 的输入；
- `normalized.json`：Zod 或 Migration 输出的规范对象；
- `canonical.json`：无尾随换行的 AWKN Canonical JSON v1 字节；
- `sha256.txt`：`Stable Hash v1` 十六进制摘要；
- `expected-validation.json`：有效性、迁移版本或特殊语义。

## 当前权威案例

1. `canonical-json/basic`；
2. `canonical-json/numbers`；
3. `claim/v2-confirmed-to-v3-field`；
4. `execution-envelope/received`；
5. `goal-spec/core-contracts`；
6. `receipt/policy-allow`；
7. `authorization/active-single-use`。

## 强制规则

- Canonical Bytes 使用 UTF-8；
- 对象 Key 按 Unicode Code Point 排序；
- 字符串使用 Unicode NFC；
- 声明为文本的字段才执行 CRLF → LF；
- 数组顺序保持；
- `-0` 归一为 `0`；
- Number 使用 ECMAScript 最短往返表示；
- Schema ID 参与 Hash Domain；
- `input.json` 与 `normalized.json` 不得替代 `canonical.json` 的字节比较；
- Fixture 变更必须产生新评审证据；
- Windows、Linux、Node 20、Node 22 必须得到相同 Canonical Bytes 和 Hash。

## 跨语言使用

AWKN Memory OS 和其他协议实现必须消费本目录的精确版本，不能重新手写一组近似案例。Protocol Manifest 必须记录：

- Fixture 来源仓库；
- Fixture Commit SHA；
- Canonicalizer Version；
- Schema Version；
- 每组 Fixture Hash；
- 运行语言和平台。

## 原始 JSON 边界

本目录从对象级 Canonicalization 开始。原始 JSON 中的重复 Key 会在普通 `JSON.parse()` 中被覆盖，必须由 Trusted Input Gateway 的 Duplicate-Key-Aware Parser 处理，见 Issue #40。

## 合并 Gate

Core Contracts 只有在 PR Base 为 `main`，且精确 Head 在 Ubuntu Node 20、Ubuntu Node 22、Windows Node 20 上完成 Architecture、Typecheck、Unit、Contract、Dependency、SBOM 与 Audit 验证后，才允许 Squash Merge。