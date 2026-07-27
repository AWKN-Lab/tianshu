---
name: awkn-部署
protection: 🔴
description: 本地 Windows + 阿里云发布总控。接收 awkn-cicd 的不可变发布包，在阿里云执行迁移、灰度、健康验证、全量上线和回滚；GitHub 只用于代码托管、分支冻结、提交历史和成功版本标签。
version: 3.0.1
triggers:
  - keyword: 部署
    description: 将已验证的不可变产物部署到阿里云
  - keyword: 发布
    description: 执行迁移、灰度、全量发布或回滚
  - keyword: 上线
    description: 将通过质量门的版本晋级到生产
  - keyword: 回滚
    description: 将流量和服务恢复到已知健康版本
  - keyword: 灰度
    description: 在阿里云按批次或流量比例验证版本
  - keyword: 阿里云
    description: 在阿里云服务器执行部署操作
  - keyword: deploy
    description: 英文触发词
capabilities:
  - local-windows-orchestration
  - alicloud-deploy
  - immutable-artifact-promotion
  - database-migration
  - canary-release
  - health-verification
  - atomic-rollback
dspbrbse-phase: Ship
aliases: [deploy, ship, release, alicloud-deploy]
---

# AWKN 部署 v3.0

## 一句话定位

本技能只负责 **Ship**：接收 `awkn-cicd` 生成的不可变发布包，在本地 Windows 发起编排，在阿里云完成预检、备份、迁移、灰度、健康验证、全量上线和回滚。

## 执行拓扑

```text
GitHub（仅版本账本）
  代码托管 / 分支冻结 / 提交历史 / 成功版本标签
                    │ commit SHA
                    ▼
Windows 本地（awkn-cicd）
  验证 / 测试 / 构建一次 / 哈希 / 发布清单
                    │ ReleaseBundle
                    ▼
阿里云服务器（awkn-部署）
  远端预检 / 备份 / 迁移 / 灰度 / 健康 / 全量 / 回滚
```

### GitHub 允许与禁止

| GitHub 可以做 | GitHub 不做 |
|---|---|
| 代码托管 | GitHub Actions |
| 分支冻结或解冻 | 云端验证、测试和构建 |
| 保存提交历史 | Packages / Release 产物托管 |
| 发布成功后写版本标签 | Environments、部署审批、灰度、迁移和上线 |

GitHub 不保存部署密钥、阿里云凭据、构建产物或运行态状态。部署中的不可变标识使用 commit SHA；只有生产验证成功后才创建并推送最终版本标签。

## 职责边界

| 能力 | 责任技能 | 本技能动作 |
|---|---|---|
| 代码审查 | `awkn-审核` | 只消费结论 |
| 验证、测试、构建、产物哈希 | `awkn-cicd` | 校验发布包，不重复构建 |
| BUG 定位与修复 | `awkn-bug修复大法` | 失败时提交证据包 |
| 阿里云预检、迁移、灰度、上线、回滚 | `awkn-部署` | 直接负责 |
| 提交与最终标签 | GitHub | 仅在规定状态写入 |

### 强制边界

- `.git` 只能存在于 Windows 开发/构建工作区；阿里云部署目标、release 版本目录、`current` 运行目录及其解包内容中，不得存在名为 `.git` 的文件或目录（包括 worktree 指针文件）。
- 禁止在服务器执行 `git clone`、`git fetch`、`git pull`、`git checkout` 或 `git reset`；服务器版本身份由 ReleaseBundle、release ID、commit SHA 元数据和 artifact SHA-256 表示，不依赖 Git 仓库。
- 禁止在阿里云重新从源码构建；同一个产物从灰度晋级到全量。
- 禁止从 GitHub 下载“最新分支”直接部署；必须按发布包里的 commit SHA 和 artifact SHA-256。
- 禁止把 GitHub Actions、GitHub Environments 或 GitHub Releases 当作执行平台。
- 禁止部署流程自行修改业务代码；发现缺陷必须路由到 `awkn-bug修复大法`。
- 子技能与本文件冲突时，以本文件为准。

## 输入契约

唯一正式输入是 `ReleaseBundle v1`，规范见 [references/release-contract-v1.md](references/release-contract-v1.md)。

最低必需字段：

```yaml
schema: awkn.release/v1
release_id: rel-YYYYMMDD-HHMMSS
project: project-name
commit_sha: full-commit-sha
source_branch: main
branch_freeze_evidence: repository-ruleset-id-or-freeze-record
target_environment: production
artifact:
  local_path: absolute-windows-path
  sha256: lowercase-hex
  git_metadata_absent: true
pipeline:
  result: PASS
migration:
  required: false
rollback:
  previous_release_id: rel-previous
approvals:
  production_mutation: approved
```

以下任一情况拒绝部署：

- `pipeline.result` 不是 `PASS`，或 `RISK` 没有明确、限时、具名豁免；
- commit SHA、产物哈希或目标环境缺失；
- `artifact.git_metadata_absent` 不是 `true`，或产物清单包含路径组件 `.git`；
- 工作树不干净，且发布包未解释差异；
- 没有可验证的上一健康版本；
- 迁移不可回滚且没有 expand/contract、备份或 forward-fix 方案；
- 服务器实况与项目部署标准不一致且尚未复核。

## 发布状态机

```text
FROZEN
  → VALIDATED
  → BUILT
  → READY
  → REMOTE_PREFLIGHT_OK
  → BACKED_UP
  → MIGRATION_SAFE
  → CANARY_HEALTHY
  → RELEASED
  → TAGGED
```

失败分支：

```text
Windows 质量门失败
  → FIX_REQUIRED
  → awkn-bug修复大法
  → RETEST_REQUIRED
  → awkn-cicd

阿里云迁移/灰度/健康失败
  → STOP_TRAFFIC
  → ROLLBACK（若策略允许）
  → INCIDENT
  → awkn-bug修复大法
  → awkn-cicd
```

状态只能前进一格；证据不完整不得“口头跳级”。

## 标准发布流程

### Deploy S0/9 — 读取标准与发布包

1. 读取项目部署标准、ReleaseBundle 和上一健康版本记录。
2. 确认目标主机、服务、端口、Nginx 生效配置、健康 URL、迁移方式和保留策略。
3. 输出本次变更面、数据风险、回滚路径和确认点。

不得凭记忆填写 IP、端口、目录、进程名或路由。

### Deploy S1/9 — 核验 Git 与产物身份

在 Windows 核验：

- 当前 commit = `commit_sha`；
- 分支处于冻结状态；
- 发布产物存在；
- 本地重新计算的 SHA-256 = `artifact.sha256`；
- 该 `release_id` 未被使用；
- 最终版本标签尚不存在。

这里只读 GitHub 状态，不执行构建。

### Deploy S2/9 — 阿里云只读预检

先做只读检查：

- 主机指纹与预期一致；
- 磁盘、内存、端口和进程状态；
- Nginx 实际加载的配置；
- 当前版本、上一健康版本及保留产物；
- 在项目部署根、版本目录与运行目录范围内递归确认不存在名为 `.git` 的文件或目录；
- 数据库版本、备份空间和迁移锁；
- 健康端点、日志与监控可用。

发现 `.git` 时立即 `BLOCKED`，不得继续上传、迁移、灰度或上线；预检只报告路径，不擅自删除。其他预检与标准文件不一致时停止，由用户确认是修标准还是修环境。

### Deploy S3/9 — 上传不可变产物

1. 将产物上传到以 `release_id` 命名的新目录。
2. 在阿里云重新计算 SHA-256 并与发布包比对。
3. 解包前检查归档清单、解包后复查，任何路径组件为 `.git` 都立即阻断。
4. 权限采用最小权限；静态文件需验证 Nginx 运行用户可读。
5. 上传失败、哈希不一致或出现 Git 元数据立即停止，不覆盖当前版本。

优先使用版本目录 + 原子切换；不得直接覆盖当前运行目录。

### Deploy S4/9 — 备份与迁移门禁

若无迁移，记录 `migration.required=false` 后继续。

若有迁移，必须依次完成：

1. 迁移兼容性检查：新旧应用能否同时工作；
2. dry-run 或影子库验证；
3. 数据备份及恢复演练证据；
4. 获取单实例迁移锁；
5. 执行 expand 阶段或已批准的迁移；
6. 校验 schema version、行数/校验和与关键查询。

生产数据库迁移只在阿里云执行。本地 Windows 只能验证迁移脚本，不直接连接生产执行写操作。

对不可逆迁移，默认使用 expand/contract 和 forward-fix；“有 down 脚本”不等于可安全回滚。

### Deploy S5/9 — 启动灰度

按项目能力选择：

- 单机：备用端口启动新版本，Nginx 仅导入测试流量；
- 多实例：按实例或权重放量；
- 静态站：版本目录 + 灰度入口或小比例路由；
- 不支持真实流量分割：使用预生产探针，不伪称金丝雀。

默认建议 `5% → 20% → 50% → 100%`，但比例和观察窗必须来自发布包或项目标准，不得硬编码套用。

### Deploy S6/9 — 分层健康验证

顺序固定：

1. 进程与端口；
2. 数据库与依赖；
3. API 健康；
4. 静态资源状态码和 Content-Type；
5. 关键业务事务；
6. 错误率、延迟、资源和业务指标；
7. 旧入口与兼容路由。

只看到 HTTP 200 不算通过；资源返回 HTML fallback、业务断言失败或错误率回归均视为失败。

### Deploy S7/9 — 晋级或自动回滚

- 全部门禁通过：按观察窗逐级晋级。
- 任一阻断指标失败：停止晋级，按发布包策略切回上一健康版本。
- 数据迁移导致不兼容：优先切回兼容应用或 forward-fix；禁止盲目回滚数据库。
- 自动回滚仅在发布包预授权且目标明确时执行；否则停止流量变更并请求确认。

回滚完成后仍必须执行健康验证。

### Deploy S8/9 — 全量与记录

全量后记录：

- release ID、commit SHA、artifact SHA-256；
- 主机与服务版本；
- 迁移版本；
- 灰度阶段与指标证据；
- 当前/上一健康版本；
- 回滚命令引用和产物保留期。

敏感信息、密钥和令牌不得进入记录。

### Deploy S9/9 — 标签与解冻

只有 `RELEASED` 且观察窗通过后：

1. 创建带 release ID、commit SHA、artifact SHA-256 的 annotated tag；
2. 将标签推送到 GitHub；
3. 解冻分支；
4. 更新项目部署标准中的已验证实况。

部署失败或已回滚的版本不得创建最终版本标签。

## 与 awkn-cicd 的接口

`awkn-cicd` 输出：

- `ReleaseBundle v1`；
- Windows 验证、测试、构建证据；
- 不可变产物和 SHA-256；
- `PASS / RISK / FAIL` 结论。

本技能返回：

- `DeployResult v1`；
- `RELEASED / ROLLED_BACK / BLOCKED`；
- 灰度、健康、迁移和回滚证据；
- 成功后可打标签的明确许可。

不得把部署执行结果伪装成 Pipeline 测试结果，反之亦然。

## 与 awkn-bug修复大法 的接口

出现以下情况时提交 `FailureBundle v1`：

- 远端预检不一致；
- 迁移 dry-run 或 apply 失败；
- 灰度指标异常；
- 健康检查或关键业务事务失败；
- 回滚后仍未恢复。

先止损、再诊断。生产故障默认顺序：

```text
冻结晋级 → 降低/切断新版本流量 → 回滚或隔离 → 保存证据 → BUG 修复
```

BUG 修复输出必须回到 `awkn-cicd` 重跑质量门，不能直接回到部署。

## 子技能路由

| 子技能 | 用途 | 约束 |
|---|---|---|
| `deploy-workflow` | 发布编排 | 使用本状态机 |
| `awkn-alicloud-deploy` | 阿里云执行 | 不在 GitHub 执行 |

注意：现有 `guard` 是文件编辑安全边界，`freeze/unfreeze` 是本地文件编辑冻结，均不是 GitHub 分支冻结；不得把它们误当发布门。GitHub 分支冻结由仓库规则或明确的协作锁实现，ReleaseBundle 只记录其状态。

## 安全红线

- 变更 Nginx、进程、数据库、流量和当前版本前必须有明确授权。
- SSH 必须校验主机指纹；禁止默认 `StrictHostKeyChecking=no`。
- 默认使用专用部署账号和最小权限，不以 root 作为常规前提。
- 私钥、服务器 IP、账号、令牌和生产连接串不得写入 SKILL.md、ReleaseBundle、日志或 GitHub。
- 不得以清理脚本掩盖含 `.git` 的错误发布包；默认阻断并回到 Windows 重新打包。清理服务器既有 `.git` 属于独立破坏性变更，必须明确授权并先备份。
- 删除、覆盖和递归移动前必须解析并核验绝对目标；优先原子切换和保留版本目录。
- 禁止以 `rm -rf current` 作为默认回滚方案。
- 不因“紧急修复”跳过全部验证；只能使用预定义的最小热修门，并在事后补齐完整质量门。

## 完成标准

- 部署的是经 Windows 本地验证的同一不可变产物；
- ReleaseBundle 声明并证明不含 Git 元数据，服务器部署范围复检不存在 `.git`；
- 阿里云迁移、灰度、健康和全量证据完整；
- 当前版本与上一健康版本均可追溯；
- 失败时已回滚/隔离并路由 BUG 闭环；
- 成功后才创建 GitHub 最终标签并解冻分支；
- 项目部署标准已回写，且不含秘密。

## 相关文件

- [references/release-contract-v1.md](references/release-contract-v1.md)：三技能共享契约
- [references/project-deploy-standards.md](references/project-deploy-standards.md)：项目实况
- [modules/deploy-workflow.md](modules/deploy-workflow.md)：部署编排
- [modules/awkn-alicloud-deploy.md](modules/awkn-alicloud-deploy.md)：阿里云执行

## 版本历史

| 版本 | 日期 | 修改内容 |
|---|---|---|
| 3.0.1 | 2026-07-25 | 服务器全面禁止 `.git` 文件/目录与 Git 工作树；新增产物、预检、解包和结果门禁 |
| 3.0.0 | 2026-07-24 | 收缩 GitHub 为代码/冻结/历史/标签；建立 Windows→阿里云执行拓扑、不可变产物、迁移/灰度/回滚门禁及 CICD/BUG 双向契约 |
