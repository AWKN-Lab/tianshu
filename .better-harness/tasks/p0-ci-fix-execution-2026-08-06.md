# P0 CI 修复执行记录 — 2026-08-06

## 1. 真实根因

CI 全红由两个条件共同造成：

1. `.trae/` 原先整体忽略，仓库内 Hook 未进入 clean checkout；
2. `runtime/test/github-actions-guard.test.ts` 从 `runtime/test` 连续回退三层，实际解析到仓库上一级 `.trae/hooks/tianshu-hook.mjs`。

因此，只调整 `.gitignore` 仍不足以修复 clean checkout。测试必须显式绑定仓库内 Hook。

## 2. 已执行修改

### 2.1 `.gitignore`

精确跟踪：

- `.trae/hooks.json`
- `.trae/hooks/tianshu-hook.mjs`

继续忽略：

- `.trae/state/`
- `.trae/logs/`
- 其他 IDE 私有资产

### 2.2 仓库内 Hook

文件：`.trae/hooks/tianshu-hook.mjs`

完成：

- GitHub Actions 命令 fail-closed；
- `.github/workflows` 写入 fail-closed；
- `git push` 作为代码托管动作保持允许；
- 保留 SessionStart、Prompt Route、PreTool、PostTool、Stop Gate；
- 不包含公网 IP、SSH 用户、密钥、生产服务器路径或本机固定项目路径；
- 运行状态写入 `.trae/state` 和 `.trae/logs`。

### 2.3 测试路径

文件：`runtime/test/github-actions-guard.test.ts`

修改：

```ts
resolve(__dirname, '..', '..', '.trae', 'hooks', 'tianshu-hook.mjs')
```

该路径从 `<repo>/runtime/test` 回到 `<repo>`，再读取仓库内 Hook。

## 3. 已取得验证证据

### Build

```text
npm run build
exit_code = 0
```

### Architecture/Lint

```text
npm run lint
exit_code = 0
blockingViolations = 0
migrationContinuity = OK
migrationLatest = 21
```

### Unit Test

实际输出：

```text
tests 730
suites 176
pass 728
fail 0
cancelled 0
skipped 2
todo 0
duration_ms 53593.7425
```

三条原 CI 失败用例全部通过：

```text
TRAE hook denies GitHub Actions commands — PASS
TRAE hook keeps git push available for code hosting — PASS
TRAE hook denies edits that recreate workflow execution — PASS
```

ENO 单次命令上限为 60 秒。Unit 汇总完成后进入 standalone MCP 验证阶段时工具超时，因此不能将整条 `npm test` 的最终进程退出码记录为成功；Unit 阶段和目标三条用例已有明确成功证据。

## 4. Git 状态

当前已 staged：

- `.gitignore`
- `.trae/hooks.json`
- `.trae/hooks/tianshu-hook.mjs`

当前未 staged：

- `runtime/test/github-actions-guard.test.ts`

P0 提交必须同时包含测试路径修正。缺少该文件时，CI clean checkout 仍会读取仓库外路径。

## 5. 剩余闭环

本地具备 Git 写权限的 Agent 执行：

```powershell
git add runtime/test/github-actions-guard.test.ts
git diff --cached --check
git diff --cached --stat
```

随后用 tracked-only 环境验证：

```powershell
git worktree add ..\awkn-ci-clean HEAD
Copy-Item .trae\hooks.json ..\awkn-ci-clean\.trae\hooks.json -Force
Copy-Item .trae\hooks\tianshu-hook.mjs ..\awkn-ci-clean\.trae\hooks\tianshu-hook.mjs -Force
Copy-Item runtime\test\github-actions-guard.test.ts ..\awkn-ci-clean\runtime\test\github-actions-guard.test.ts -Force
Set-Location ..\awkn-ci-clean\runtime
node --import tsx --test test/github-actions-guard.test.ts
```

更优做法：先生成本地 commit，再从该 commit 建 worktree，避免手工复制。

提交：

```text
fix(ci): track sanitized repo-local TRAE hook and fix guard test path
```

推送后：

```powershell
gh run list --workflow runtime-ci --limit 3
gh run watch <NEW_RUN_ID> --exit-status
```

只有新 Run 的 `check` job 为 success，P0 才完成。

## 6. 后续计划纠偏

现有治理计划中的两个旧决策仍需修订：

- Cron：采用独立 Worker/Daemon + 数据库 Leader Lease，不由每个 MCP Server 启动 CronEngine；
- Corrections 与 EXP-DRV：采用关联表表达多对多关系，不直接将两套状态一一映射。

P0 CI 修复完成后再进入这两个独立工作包。
