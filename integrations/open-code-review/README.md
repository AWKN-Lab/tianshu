# AWKN 内置 OpenCodeReview 集成包

本目录是 OpenCodeReview 吸收工作的唯一落盘边界。禁止从 AWKN Runtime 直接执行、加载或修改引擎目录之外的 OCR 工作副本。

## 目录契约

- `UPSTREAM.lock.json`：固定上游地址、提交、许可证和协议版本。
- `src/`：需要维护的最小 Go 薄分支源码；不得包含 OCR 的模型、Session 或 UI 能力。
- `patches/`：上游升级时可重放的补丁和修改清单。
- `bin/`：本机构建产物；由版本和 SHA-256 双重固定，不作为源码事实。

Runtime 默认只接受本目录 `bin/ocr[.exe]`，即使通过环境变量覆盖路径，也必须仍位于本目录内；真实路径解析后逃逸同样拒绝。

## 构建与验证

最小 producer 源码位于 `src/`，只依赖 Go 标准库和系统 Git：

```text
cd integrations/open-code-review/src
go test ./...
go build -trimpath -o ../bin/ocr ./cmd/ocr
```

CI 会在 Windows 和 Linux 上构建 producer，并执行 OCR 与 Runtime Native Git Adapter 的内容指纹对照。发布时还必须将二进制版本和 SHA-256 固定到部署配置；在摘要缺失、版本不匹配或二进制不在本目录时，commit-range OCR 模式失败关闭。任何外部仓库都只能作为只读调研来源，不能成为构建或运行依赖。
