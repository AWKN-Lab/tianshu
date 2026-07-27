---
name: deploy-workflow
version: 2.0.1
description: AWKN 本地 Windows → 阿里云发布编排。验证 ReleaseBundle 后执行远端预检、不可变上传、迁移门、灰度、健康、全量和回滚；GitHub 只保存源码、冻结状态、提交和成功标签。
category: deployment
tags: [windows, alicloud, release-bundle, canary, rollback]
---

# Deploy Workflow v2

## 输入

只接受 [../references/release-contract-v1.md](../references/release-contract-v1.md) 定义的 `ReleaseBundle v1`。

必须满足：

- 分支已冻结；
- commit SHA 完整且工作树干净；
- Windows Pipeline 为 PASS，或 RISK 例外有效；
- 产物路径与 SHA-256 存在；
- 上一健康版本可用；
- 迁移、灰度、回滚和授权字段完整。

## 编排

```text
Validate bundle
  → Read project standard
  → Aliyun read-only preflight
  → Upload to new release directory
  → Verify remote SHA-256
  → Backup / migration gate
  → Canary
  → Layered health checks
  → Full promotion
  → DeployResult
  → Successful Git tag / branch unfreeze
```

## 强制规则

- 不在阿里云重新构建。
- 服务器部署范围不得存在 `.git` 文件或目录；不执行 `git clone/fetch/pull/checkout/reset`。
- ReleaseBundle 必须证明 `artifact.git_metadata_absent=true`；远端预检和解包后必须再次检查，发现 `.git` 即 `BLOCKED`，不得自动删除。
- 不从 GitHub 拉取“最新分支”部署。
- 不要求 GitHub CI 标签，不调用 GitHub Actions。
- GitHub 最终标签只在 RELEASED 后创建。
- 上传到新版本目录；不覆盖当前目录。
- 数据迁移只在阿里云执行，Windows 只做 dry-run。
- 灰度与全量使用同一个 artifact SHA-256。
- 任一阻断门失败先停止晋级；按授权回滚/隔离后生成 FailureBundle。
- BUG 修复必须回到 awkn-cicd，不能直接重部署。

## 失败路由

| 失败阶段 | 先做 | 下游 |
|---|---|---|
| ReleaseBundle 校验 | 阻断 | awkn-cicd |
| 远端预检 | 不变更环境 | awkn-bug修复大法 或修标准 |
| 迁移 | 停止应用晋级，按数据策略处理 | awkn-bug修复大法 |
| 灰度/健康 | 停流/切回上一健康版本 | awkn-bug修复大法 |
| 回滚 | 隔离并升级事件 | awkn-bug修复大法 |

## 输出

`DeployResult v1`：

- RELEASED / ROLLED_BACK / BLOCKED；
- 远端 artifact SHA-256；
- 迁移、灰度和健康证据；
- 当前/上一 release ID；
- `tag_allowed`；
- FailureBundle 路径（如失败）。

## 禁止选项

不存在 `--force`、`--skip-tests`、`git-push-deploy` 或 webhook 部署。热修也必须生成新 ReleaseBundle。
