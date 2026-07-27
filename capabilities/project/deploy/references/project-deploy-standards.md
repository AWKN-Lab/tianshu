# Project Deploy Standards

每个项目部署前复制并填写本模板；只记录 profile 或配置引用，不写服务器 IP、账号、私钥和令牌。

```yaml
schema: awkn.deploy-standard/v1
project: project-name
target_profile: project-prod
deploy_root: configured-absolute-path
release_root: configured-absolute-path
current_pointer: configured-path
health_endpoint: configured-url
artifact_only: true
server_git_policy:
  git_metadata_allowed: false
  forbidden_path_component: .git
  git_commands_allowed: false
  preflight_scope: [deploy_root, release_root, current_pointer]
rollback:
  previous_release_required: true
  command_ref: configured-command
```

强制规则：服务器只接收 ReleaseBundle，不接收源码仓库或 Git 工作树。只读预检在上述范围发现名为 `.git` 的文件或目录时必须 `BLOCKED`；部署流程不得自动删除，清理需独立授权和备份。
