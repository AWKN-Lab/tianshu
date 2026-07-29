# AWKN 内置 OpenCodeReview 集成包

本目录是 OpenCodeReview 吸收工作的唯一落盘边界。禁止从 AWKN Runtime 直接执行、加载或修改引擎目录之外的 OCR 工作副本。

## 目录契约

- `UPSTREAM.lock.json`：固定上游地址、提交、许可证和协议版本。
- `src/`：需要维护的最小 Go 薄分支源码；不得包含 OCR 的模型、Session 或 UI 能力。
- `patches/`：上游升级时可重放的补丁和修改清单。
- `bin/`：本机构建产物；由版本和 SHA-256 双重固定，不作为源码事实。

Runtime 默认只接受本目录 `bin/ocr[.exe]`，即使通过环境变量覆盖路径，也必须仍位于本目录内；真实路径解析后逃逸同样拒绝。

## 当前状态

AWKN 侧严格协议、Adapter、Native Git 对照和 fail-closed 门禁已经实现。Go producer 尚未在本机生成，因为当前环境没有 Go 工具链；在它进入本目录并完成 Go 测试、二进制签名之前，commit-range OCR 模式必须失败关闭。任何外部仓库都只能作为只读调研来源，不能成为构建或运行依赖。
