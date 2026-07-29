---
name: awkn-cicd
protection: 🔴
displayName: AWKN Local CI/CD
description: Windows 本地持续集成与发布编排桥。负责冻结候选分支、验证、测试、构建一次、产物哈希和 ReleaseBundle；不使用 GitHub Actions，不执行阿里云迁移、灰度或上线，失败统一转交 awkn-bug修复大法。
aliases: [CI/CD, 流水线, 自动测试, 本地构建, pipeline, 持续集成, 持续部署, cicd]
version: 3.0.1
dspbrbse-phase: Integrate
category: 质量交付
tags: [local-ci, windows, powershell, pipeline, testing, quality-gate, immutable-artifact, alicloud-handoff]
triggers:
  - keyword: CI/CD
    description: 在 Windows 本地配置或执行流水线
  - keyword: 流水线
    description: 编排验证、测试、构建和发布交接
  - keyword: 自动测试
    description: 在本地运行项目测试门
  - keyword: 本地构建
    description: 生成一次性不可变发布产物
  - keyword: 质量门禁
    description: 生成 PASS、RISK 或 FAIL 结论
  - keyword: 持续部署
    description: 测试通过后向 awkn-部署交付发布包
capabilities:
  - local-windows-pipeline
  - powershell-orchestration
  - parallel-test-execution
  - quality-gate
  - immutable-build
  - artifact-hashing
  - release-bundle-generation
  - failure-bundle-routing
---

# AWKN Local CI/CD v3.0

## 一句话定位

本技能是 `awkn-审核 → awkn-cicd → awkn-部署` 的本地桥接层：

- **CI**：在 Windows 本地验证、测试、扫描和构建；
- **CD 编排**：生成不可变发布包并交给阿里云部署技能；
- **不做**：GitHub 云端 CI、生产迁移、灰度、上线和回滚执行。

## 执行边界

| 位置 | 允许执行 |
|---|---|
| GitHub | 代码托管、分支冻结/解冻、提交历史、成功版本标签 |
| Windows 本地 | lint、typecheck、测试、安全检查、构建、哈希、ReleaseBundle |
| 阿里云 | 远端预检、备份、迁移、灰度、健康、全量、回滚 |

明确禁止：

- GitHub Actions、GitHub-hosted runner、GitHub Environments；
- 将构建产物上传到 GitHub Packages 或 Releases；
- 由 GitHub webhook 直接改生产；
- CI/CD 技能自己 SSH 上线或执行数据库迁移；
- 部署阶段再次构建源码。
- 把源码仓库、`.git` 文件/目录或 Git worktree 指针打入发布产物；
- 生成要求服务器执行 `git clone/fetch/pull/checkout/reset` 的部署方案。

## 与其他技能的责任链

```text
awkn-审核 PASS
  → awkn-cicd（Windows：验证/测试/构建）
  → PASS + ReleaseBundle
  → awkn-部署（阿里云：迁移/灰度/上线）

任一 Windows 门失败
  → FailureBundle
  → awkn-bug修复大法
  → FixBundle
  → awkn-cicd 全量或受影响门重测
```

共享接口见 [../awkn-部署/references/release-contract-v1.md](../awkn-部署/references/release-contract-v1.md)。

## 执行器选择

默认使用 PowerShell 7 + 项目原生命令，避免为小项目先引入平台。

可选的自托管调度器：

- Jenkins 可运行在 Windows，但只作为本地调度、日志和定时器；
- 调度器使用专用非管理员账号；
- 安装新服务、插件或计划任务前必须先检查现状并获得用户授权；
- 无论使用何种调度器，所有门和发布包格式保持一致。

不因引入 Jenkins 就把 GitHub 变回 CI 平台。

## Pipeline 状态机

```text
DRAFT
  → SOURCE_CHECKED
  → FROZEN
  → FAST_GATES_PASS
  → TESTS_PASS
  → BUILT
  → ARTIFACT_VERIFIED
  → READY
```

失败进入 `FIX_REQUIRED`；修复后从 `RETEST_REQUIRED` 重新评估受影响范围。任何状态都必须有退出码、日志或报告证据。

## Windows 本地 Pipeline

### Pipeline S0/7 — 发现项目事实

读取项目而不是猜测：

- 仓库根、默认分支、当前 SHA、工作树状态；
- 包管理器和锁文件；
- 可用的 lint、typecheck、test、build、migration 命令；
- 项目 CI 配置、测试阈值、构建目录和目标环境；
- 与上一成功版本相比的变更范围。

若没有项目级配置，输出“待配置项”，不得自动套用 80% 覆盖率等通用数字。

### Pipeline S1/7 — 候选源冻结

1. 确认工作树干净；
2. 提交候选变更并记录完整 commit SHA；
3. 将候选分支推送到 GitHub；
4. 使用仓库规则或明确协作约定冻结该分支；
5. 冻结后禁止把额外提交混入同一 release ID。

GitHub 仅记录冻结和提交，不运行验证。

### Pipeline S2/7 — 快速失败门

可并行执行：

- 依赖锁一致性；
- 格式/lint；
- typecheck/compile check；
- 秘密扫描；
- 生产依赖高危漏洞检查；
- 迁移脚本静态检查。

任一阻断项失败，生成 FailureBundle 并停止。

### Pipeline S3/7 — 测试门

按风险而不是按固定模板选择：

1. 受影响单元测试；
2. 全量单元测试；
3. 集成/契约测试；
4. 关键 E2E 或桌面应用冒烟；
5. 迁移 dry-run（本地或隔离数据库，绝不直接写生产）；
6. 回滚/向前兼容测试。

并行只用于相互独立的任务；共享数据库、端口或状态的测试必须隔离或串行。

Flaky 测试最多重跑一次用于分类，不能靠无限重跑制造绿色。

### Pipeline S4/7 — 质量门判定

| 结论 | 条件 | 动作 |
|---|---|---|
| `PASS` | 项目定义的阻断门全部通过 | 允许构建 |
| `RISK` | 无阻断失败，但存在明确残余风险或缺测 | 需具名、限时豁免 |
| `FAIL` | 测试/构建/安全/迁移兼容门失败 | 路由 BUG 技能 |

生产项目“没有测试”不是自动放行；默认是 `RISK`，必须记录原因、负责人、影响范围和失效时间。

### Pipeline S5/7 — Build once

1. 在干净工作树按 `commit_sha` 构建；
2. 固定锁文件、工具链版本和生产构建参数；
3. 生成版本元数据；
4. 产物写入以 `release_id` 命名的新目录；
5. 计算 SHA-256；
6. 禁止在测试后修改产物内容。

同一产物随后上传阿里云并贯穿灰度到全量。

### Pipeline S6/7 — 产物验证

- 解包/启动冒烟；
- 必需文件、入口、source map 策略和配置占位检查；
- SPA base、静态资源 Content-Type 预期和旧路径扫描；
- 二进制/容器或依赖清单检查；
- 重新计算 SHA-256；
- 确认产物中没有 `.env`、私钥、令牌和调试秘密。
- 对目录和压缩包文件清单做路径组件级检查：任一组件精确等于 `.git` 即 `FAIL`；`.git` 既可能是目录，也可能是 worktree 指针文件。
- 检查通过后记录 `artifact.git_metadata_absent=true`；该证据缺失时不得生成 `READY`。

### Pipeline S7/7 — 生成交接包

生成 `ReleaseBundle v1`，至少包含：

- release ID、仓库、分支和完整 commit SHA；
- 本地产物绝对路径与 SHA-256；
- `artifact.git_metadata_absent=true` 及检查命令、退出码和清单证据；
- 各质量门结果和证据目录；
- 迁移需求、兼容策略和 dry-run 结果；
- 灰度步骤、观察窗和停止阈值引用；
- 上一健康版本和应用/数据库回滚策略；
- 生产变更授权状态。

输出 `READY` 后调用 `awkn-部署`，本技能不继续执行服务器变更。

## 失败路由

以下任一失败生成 `FailureBundle v1`：

- lint/typecheck/compile 失败；
- 单元、集成、E2E 或迁移 dry-run 失败；
- 安全门阻断；
- 构建失败或产物哈希漂移；
- 修复后回归测试再次失败。

FailureBundle 必须包含最小复现、期望/实际、命令 ID、退出码、日志路径、相关 SHA 和受影响文件。随后调用 `awkn-bug修复大法`。

## 修复回流

接收 `FixBundle v1` 后：

1. 确认 fix commit 是新提交；
2. 先跑明确的回归测试；
3. 基于变更面重跑受影响门；
4. 生产发布前重跑所有阻断门；
5. 重新构建并创建新的 release ID 和 artifact SHA-256；
6. 旧失败产物不得“改名复用”。

## 热修最小门

P0/P1 在生产已止损后可走最小门：

- lint/typecheck；
- 相关单测或最小复现回归；
- 构建；
- 关键业务冒烟；
- 秘密扫描；
- 新 ReleaseBundle。

最小门不等于跳过 CICD；全量门须在 24 小时内补齐。

## 可观测性

每次 Pipeline 记录：

- pipeline/release ID；
- commit SHA；
- 每阶段开始/结束/退出码；
- 缓存是否命中；
- 测试数量、失败数和 Flaky 分类；
- 产物 SHA-256；
- PASS/RISK/FAIL 及例外；
- 下游状态：READY / FIX_REQUIRED。

日志不得写秘密；路径和主机使用配置别名。

## 结果单

```markdown
# Local Pipeline Result

- Pipeline ID:
- Release ID:
- Project:
- Commit SHA:
- Windows profile:
- Trigger: manual / local-scheduler / fix-retest

| Gate | Result | Evidence |
|---|---|---|
| Source/Frozen | PASS/FAIL | |
| Lint/Typecheck | PASS/FAIL | |
| Unit | PASS/FAIL/SKIP | |
| Integration | PASS/FAIL/SKIP | |
| E2E | PASS/FAIL/SKIP | |
| Security | PASS/RISK/FAIL | |
| Migration dry-run | PASS/FAIL/N/A | |
| Build | PASS/FAIL | |
| Artifact verify | PASS/FAIL | |

- Quality gate: PASS / RISK / FAIL
- Artifact path:
- Artifact SHA-256:
- Next: awkn-部署 / awkn-bug修复大法 / approval
```

## 完成标准

- GitHub 未承担验证、构建或部署；
- Windows 本地门禁证据完整；
- 产物只构建一次且哈希固定；
- ReleaseBundle 可被部署技能独立校验；
- 产物与归档清单不含任何名为 `.git` 的路径组件，交接不依赖服务器 Git；
- 失败已进入 BUG 修复闭环；
- 本技能未执行阿里云生产变更。

## 版本历史

| 版本 | 日期 | 修改内容 |
|---|---|---|
| 3.0.1 | 2026-07-25 | 新增无 Git 元数据发布包门禁；服务器仅接收不可变产物，禁止 Git 工作树部署 |
| 3.0.0 | 2026-07-24 | 移除 GitHub Actions 与云端 CI；重构为 Windows 本地质量门、不可变构建和阿里云 ReleaseBundle 交接；连接 BUG 修复回流 |
