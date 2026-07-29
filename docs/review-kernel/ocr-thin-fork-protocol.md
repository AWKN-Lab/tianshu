# OpenCodeReview 薄分支协议与维护策略

## 引擎内固定来源

- 唯一集成根：`integrations/open-code-review/`
- 上游只读来源：`https://github.com/alibaba/open-code-review`
- 审计时提交：`08040752143057781b40aa091b50edfa5895960b`
- 许可证：Apache-2.0；薄分支必须保留 LICENSE/NOTICE 和修改声明。

AWKN 不维护第二个外部工作仓库，也不复制 OCR 全量产品。只把机器协议所需的最小源码、补丁、来源锁和构建说明放入上述引擎目录。发布时固定 OCR 语义版本与二进制 SHA-256；路径、版本或摘要任一不符都拒绝执行。

## 命令

```text
ocr delegate spec --format json --repo <absolute-path> --from <base-ref> --to <head-ref>
```

stdout 只能包含一个 UTF-8 JSON 文档，诊断写 stderr。命令不得初始化 agent/session、调用 LLM、读取模型密钥、发送遥测或写 OCR Session。

## `ocr-delegate-spec/v1`

外部 wire 使用 snake_case，Hash 必须为 `sha256:<64 lowercase hex>`，Git OID 必须解析为 40 位小写十六进制。路径必须是仓库相对 POSIX 路径，禁止绝对路径、反斜杠、`.`/`..` 段和 NUL。

必需字段：

- `schema`, `ocr_version`, `repository.root`
- `target.mode/from_ref/from_oid/to_ref/to_oid/merge_base_oid`
- `diff_fingerprint`, `rule_bundle_hash`, `summary`
- `files[]`: path、old_path、status、增删行、will_review、exclude_reason、rule_group_id、diff_fingerprint
- `rule_groups[]`: id、source、pattern、content_hash、rule、files

Schema strict；未知字段、未知版本、重复 JSON key、非法 UTF-8、尾随内容、缺失 Hash、汇总不一致均拒绝。相同仓库状态和参数必须字节级语义等价。

## 适配器安全边界

Runtime 使用 `execFile` 且 `shell=false`，限制超时和 stdout/stderr 大小，只传递 Git/locale/系统必需环境变量，不继承 API key。可执行文件必须位于 `integrations/open-code-review/`，并同时通过词法路径和真实路径包含校验。退出码、stderr、超时、进程中断、版本和二进制摘要全部映射为结构化 Provider 失败；enforce 下不得回退文本 PASS。

## 更新流程

1. 在临时只读位置检查上游，记录旧/新提交和许可证变化；不得把该位置作为项目依赖。
2. 把需要维护的最小源码和补丁导入 `integrations/open-code-review/`，不改模型与会话功能。
3. 运行 Go 契约测试、确定性测试、密钥环境隔离测试和 AWKN Adapter 测试。
4. 更新兼容版本与二进制摘要，执行 shadow 两个周期。
5. 人工批准后升级；失败时回退固定二进制，不改变 Receipt 协议。

当前环境没有 Go toolchain，因此本变更只交付并验证了 AWKN 侧严格 Adapter 和引擎内路径门禁；Go producer 必须在具备 Go 的环境生成后回填到本引擎集成目录并签名发布，不允许落入或依赖外部项目目录。
