# AWKN Release Contract v1

`awkn-cicd`、`awkn-部署` 与 `awkn-bug修复大法` 必须共享同一个 `release_id`、完整 `commit_sha` 和证据引用。GitHub 只作代码账本，不执行验证或部署。

## ReleaseBundle v1

```yaml
schema: awkn.release/v1
release_id: rel-YYYYMMDD-HHMMSS
project: project-name
source:
  commit_sha: 40-char-sha
  dirty: false
  branch_frozen: true
  freeze_evidence: freeze-record
target:
  environment: production
  host_profile: project-prod
artifact:
  local_path: D:\artifacts\project\rel-id\artifact.zip
  sha256: lowercase-hex
  git_metadata_absent: true
pipeline:
  result: PASS
  evidence_dir: D:\artifacts\project\rel-id\evidence
migration:
  required: false
canary:
  strategy: weighted
rollback:
  previous_release_id: rel-previous
  artifact_ref: project/releases/rel-previous
approvals:
  production_mutation:
    status: approved
    approver: human-or-policy-id
    expires_at: timestamp
```

生产最低门禁：工作树干净；`pipeline.result=PASS`；完整 SHA 与本地 HEAD 一致；`artifact.git_metadata_absent=true` 且目录/归档清单不含名为 `.git` 的路径组件；Windows 与阿里云复算的产物 SHA-256 一致；上一健康版本、回滚方式、生产批准均有效。秘密只能记录引用名，不能进入发布包。

服务器契约：阿里云部署根、release 版本目录、`current` 运行目录和解包内容不得存在 `.git` 文件或目录，不执行任何 Git 拉取/切换命令。发现违规时返回 `BLOCKED`；删除既有 `.git` 不属于自动部署动作。

## DeployResult v1

```yaml
schema: awkn.deploy-result/v1
release_id: rel-YYYYMMDD-HHMMSS
result: RELEASED | ROLLED_BACK | BLOCKED
artifact_sha256_verified: true
server_git_metadata_absent: true
migration:
  result: PASS | FAIL | NOT_APPLICABLE
canary:
  result: PASS | FAIL | NOT_APPLICABLE
health:
  result: PASS | FAIL
  evidence: []
current_release_id: rel-current
previous_release_id: rel-previous
tag_allowed: true | false
failure_bundle: path-or-null
```

`git push`、workflow 状态和 GitHub 通过标签都不能代替上述两个契约。只有 `DeployResult.result=RELEASED` 才能报告部署成功；最终版本标签只能在成功后创建。
