# 本地 CICD 卡

验证、测试和构建全部在本地 Windows 完成，GitHub Actions 不参与。

1. 从干净、明确的提交或工作树状态开始。
2. 依次执行静态检查、测试、构建；构建只执行一次作为发布产物来源。
3. 生成 ReleaseBundle、文件清单和 SHA-256 哈希。
4. 递归检查目录和归档清单，拒绝任何路径组件为 `.git` 的产物，记录 `artifact.git_metadata_absent=true`。
5. 失败时只在有界循环内修复并重新验证。

输出 `PASS/FAIL`、命令结果、产物路径和哈希；不执行生产上线。

硬规则：不得查询、触发或等待 GitHub Actions；runner、Actions 额度、Secrets、workflow 状态和 `ci-passed/*` 标签不得出现在阻塞项中。
服务器只接收产物，不接收源码仓库或 Git 工作树；不得生成依赖服务器 `git clone/pull` 的发布方案。
