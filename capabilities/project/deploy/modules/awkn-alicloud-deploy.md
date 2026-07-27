---
name: awkn-alicloud-deploy
version: 2.0.1
description: 阿里云执行层。消费 ReleaseBundle，在已核验主机上执行只读预检、不可变产物上传、迁移、灰度、健康、全量和原子回滚；不包含服务器 IP、私钥路径或 GitHub CI。
argument-hint: "[ReleaseBundle 路径] [项目部署标准]"
---

# AWKN 阿里云执行层 v2

## 前提

1. 已读取项目部署标准；
2. 已验证 ReleaseBundle；
3. SSH host profile 与已知主机指纹匹配；
4. 使用专用最小权限部署账号；
5. 生产变更授权有效；
6. 上一健康版本与数据恢复策略可用。
7. `artifact.git_metadata_absent=true`，且服务器部署范围只接收不可变产物，不是 Git 工作树。

主机、账号、端口、目录、域名和密钥只通过 profile/secret reference 解析，不写入本技能。

## Aliyun S0/7 — 只读预检

- 当前版本和进程；
- 监听端口与 Nginx 实际配置；
- 磁盘、内存和 release 保留空间；
- 数据库 schema、迁移锁与备份空间；
- 健康端点和监控；
- 当前/上一健康 release ID。
- 项目部署根、release 目录和 `current` 范围内不存在名为 `.git` 的文件或目录。

发现 `.git` 立即返回 `BLOCKED`，只报告路径，不自动删除；其他实况与标准不一致则停止。

## Aliyun S1/7 — 不可变上传

- 上传到新的 release ID 目录；
- 服务器复算 SHA-256；
- 哈希不一致立即停止；
- 权限最小化；
- 不覆盖 current；
- 不在服务器构建或安装未锁定依赖。
- 解包前检查归档清单、解包后复查；路径组件 `.git` 视为非法发布包。

## Aliyun S2/7 — 备份与迁移

有迁移时依次执行：

1. 兼容性校验；
2. dry-run 证据复核；
3. 数据备份及可恢复性证据；
4. 获取迁移锁；
5. apply；
6. schema、数据校验和关键查询验证。

不可逆迁移优先 expand/contract + forward-fix，不盲目执行 down。

## Aliyun S3/7 — 灰度启动

- 单机使用备用端口/实例；
- 多实例使用权重或实例批次；
- 静态站使用版本目录和灰度入口；
- 不支持流量分割时明确标记为“预生产探针”，不伪称金丝雀。

比例、观察窗和阈值来自 ReleaseBundle。

## Aliyun S4/7 — 健康验证

按顺序检查：

1. 进程/端口；
2. 依赖和数据库；
3. API；
4. 静态资源状态码与 Content-Type；
5. 关键业务事务；
6. 错误率、延迟、资源、业务指标；
7. 旧入口和兼容路由。

TLS 校验默认开启；不能用 `curl -k` 掩盖证书问题。

## Aliyun S5/7 — 晋级或回滚

- 指标通过后逐级晋级；
- 阻断指标失败立刻停止；
- 预授权时原子切回上一健康应用版本；
- 数据不兼容时使用预定 forward-fix/兼容策略；
- 回滚后重复完整健康验证。

## Aliyun S6/7 — 全量

全量只切换流量/`current` 指针到已经灰度过的同一产物，不重新复制或构建。

记录当前与上一 release ID、artifact SHA-256、schema version、灰度证据和观察窗。

## Aliyun S7/7 — 结果

返回 `DeployResult v1`：

- RELEASED：允许创建 GitHub 最终标签；
- ROLLED_BACK：禁止标签，生成 FailureBundle；
- BLOCKED：环境未变更或已隔离，说明阻断点。

## 安全红线

- 禁止关闭 SSH host key 校验；
- 禁止默认 root；
- 禁止上传到未解析/未核验的目标；
- 禁止直接递归删除 current；
- 禁止 Nginx 未测试就 reload；
- 禁止备份失败后继续迁移；
- 禁止把秘密输出到日志；
- 禁止 Git push/webhook/GitHub Actions 触发生产变更。
- 禁止服务器执行 `git clone/fetch/pull/checkout/reset`，也禁止任何 `.git` 文件、目录或 worktree 指针进入部署范围。

共享契约：[../../references/release-contract-v1.md](../../references/release-contract-v1.md)。
