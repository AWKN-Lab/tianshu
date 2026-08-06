# AWKN 引擎本地执行计划 v2（CI First）

**工作目录**：`D:\awkn-lab\awkn引擎`  
**版本**：v2.0  
**日期**：2026-08-06  
**执行原则**：先修远端门禁，再收口资产；只认 clean checkout 证据；不同风险拆分提交。

---

## 0. 已核实事实与关键纠偏

### 0.1 远端状态

- GitHub 已恢复可达；
- `github/main` 与本地 `HEAD 8f682ad` 一致；
- 最近 8 次 CI 全部失败；
- `light-check`、`agents-check-on-runtime-change`、`ocr-producer` 为绿；
- `check / Run runtime checks` 为红；
- 失败集中在 TRAE Hook 测试。

### 0.2 本地复核新增发现

1. `runtime/test/github-actions-guard.test.ts` 当前路径为：

   ```ts
   resolve(__dirname, '..', '..', '..', '.trae', 'hooks', 'tianshu-hook.mjs')
   ```

   `__dirname` 位于 `<repo>/runtime/test`，连续三个 `..` 最终指向仓库上一级：

   ```text
   D:\awkn-lab\.trae\hooks\tianshu-hook.mjs
   ```

   CI clean checkout 中该路径位于仓库外，必然缺失。

2. 仓库内已有另一份未跟踪 Hook：

   ```text
   D:\awkn-lab\awkn引擎\.trae\hooks\tianshu-hook.mjs
   ```

   该文件与测试实际读取的上级 Hook 不是同一个实现。

3. 上级 Hook 含真实公网 IP、绝对 Windows 路径和服务器上下文，禁止原样复制入库。

4. 仓库内 Hook 当前缺少测试要求的 GitHub Actions fail-closed 行为，单纯修改测试路径仍会断言失败。

5. `.gitignore` 已存在未提交修改，准备重新包含：

   ```text
   .trae/hooks.json
   .trae/hooks/tianshu-hook.mjs
   ```

### 0.3 最终结论

仅执行：

```powershell
git add -f .trae/hooks/tianshu-hook.mjs
```

无法修复 CI。必须同时完成：

1. 测试路径改为仓库内 Hook；
2. 仓库内 Hook 补齐 GitHub Actions Guard；
3. 清除公网 IP、绝对路径和服务器信息；
4. Hook 与配置正式入库；
5. clean checkout 重跑完整门禁。

---

## P0：修复 CI 全红

### P0.1 建立安全点

```powershell
Set-Location 'D:\awkn-lab\awkn引擎'

git status
git branch -vv
git log --oneline -10

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
git tag "checkpoint/pre-ci-hook-fix-$stamp"
```

退出条件：

- 当前分支为 `main`；
- 无 merge/rebase/cherry-pick 中间态；
- checkpoint tag 已存在。

### P0.2 修正测试目标路径

修改：

```text
runtime/test/github-actions-guard.test.ts
```

将：

```ts
resolve(__dirname, '..', '..', '..', '.trae', 'hooks', 'tianshu-hook.mjs')
```

改为：

```ts
resolve(__dirname, '..', '..', '.trae', 'hooks', 'tianshu-hook.mjs')
```

路径必须解析到：

```text
<repo>\.trae\hooks\tianshu-hook.mjs
```

禁止继续引用 `D:\awkn-lab\.trae` 或 CI checkout 上一级目录。

### P0.3 收口仓库内 Hook

正式资产：

```text
.trae/hooks.json
.trae/hooks/tianshu-hook.mjs
```

仓库内 Hook 必须满足：

1. GitHub Actions 默认 fail-closed：
   - 阻止 `gh workflow ...`；
   - 阻止 `gh run ...`；
   - 阻止 GitHub Actions API 调用；
   - 阻止写入 `.github/workflows/**`；
   - 保留普通 `git push`。
2. 兼容测试输出：
   - `block: true`；
   - `permissionDecision: 'deny'`；
   - `blockReason`；
   - `hookSpecificOutput.permissionDecision`。
3. 路径从 Hook 文件位置动态计算：

   ```js
   const projectDir = resolve(__dirname, '..', '..');
   const runtimeDir = join(projectDir, 'runtime');
   ```

4. 禁止硬编码：
   - 公网 IP；
   - SSH 用户；
   - 私钥位置；
   - `D:\awkn-lab`；
   - 具体生产项目路径。
5. 日志只写入已忽略目录：

   ```text
   .trae/logs/
   .trae/state/
   ```

6. Hook 中不得含 Token、Key、Cookie、凭据内容。

### P0.4 `.gitignore` 规则

保留精确例外：

```gitignore
.trae/*
!.trae/hooks.json
!.trae/hooks/
.trae/hooks/*
!.trae/hooks/tianshu-hook.mjs
```

继续忽略：

```text
.trae/state/
.trae/logs/
.trae/specs/
.trae/rules/
```

验证：

```powershell
git status --short -- .gitignore .trae/hooks.json .trae/hooks/tianshu-hook.mjs
```

期望三项均可被 Git 识别。

### P0.5 定向测试

```powershell
Set-Location 'D:\awkn-lab\awkn引擎\runtime'

node --import tsx --test test/github-actions-guard.test.ts
```

退出条件：3/3 pass。

额外手工冒烟：

```powershell
$hook = 'D:\awkn-lab\awkn引擎\.trae\hooks\tianshu-hook.mjs'

'{"tool_name":"RunCommand","tool_input":{"command":"gh workflow run ci.yml"}}' |
  node $hook pre-tool

'{"tool_name":"RunCommand","tool_input":{"command":"git push origin main"}}' |
  node $hook pre-tool

'{"tool_name":"Write","tool_input":{"file_path":"D:\repo\.github\workflows\ci.yml"}}' |
  node $hook pre-tool
```

验收：

- `gh workflow`：deny；
- `git push`：allow；
- 写 workflow：deny。

### P0.6 完整本地门禁

不沿用旧数字，全部重新采集：

```powershell
npm run typecheck
npm run build
npm run lint
npm test
npm run test:contracts
npm run test:verify
```

分别记录：

- 实际 tests / pass / fail / skipped；
- Contract Tests 数量；
- Verify Tests 数量；
- 每条命令退出码。

禁止在未取得完整退出码时写“全量通过”。

### P0.7 clean checkout 验证

完成 CI 修复提交后，用本地临时 clone 验证仓库只依赖受版本控制资产：

```powershell
Set-Location 'D:\awkn-lab'

$clean = 'D:\awkn-lab\_ci-clean-awkn-engine'
if (Test-Path $clean) { Remove-Item $clean -Recurse -Force }

git clone --no-hardlinks 'D:\awkn-lab\awkn引擎' $clean
Set-Location "$clean\runtime"

npm ci
npm run check
```

额外确认：

```powershell
Test-Path "$clean\.trae\hooks\tianshu-hook.mjs"
Test-Path "$clean\.trae\hooks.json"
```

退出条件：

- 两个文件均存在；
- `npm run check` exit code 0；
- clean clone 未读取 `D:\awkn-lab\.trae`。

### P0.8 CI 修复独立提交

只暂存：

```text
.gitignore
.trae/hooks.json
.trae/hooks/tianshu-hook.mjs
runtime/test/github-actions-guard.test.ts
```

提交：

```powershell
git add .gitignore .trae/hooks.json .trae/hooks/tianshu-hook.mjs runtime/test/github-actions-guard.test.ts
git diff --cached --check
git diff --cached

git commit -m 'fix(ci): track sanitized TRAE hook and use repo-local fixture'
```

该提交必须独立，可单独 revert。

### P0.9 推送并等待 CI 全绿

```powershell
git push tianshu main
git push github main

$runId = gh run list --workflow=runtime-ci.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $runId --exit-status
```

若失败：

```powershell
gh run view $runId --log-failed
```

退出条件：

- 最新 `runtime-ci` conclusion = success；
- 最新 `agents-ci` conclusion = success；
- 记录 Run ID、Commit SHA、各 job 耗时；
- 禁止带着红 CI 推进资产收口提交。

---

## P1：资产收口与脱敏

P0 全绿后执行。

### P1.1 恢复无语义时间戳

```powershell
git restore -- agents/personas/absorb-record.json agents/personas/personas.json
```

### P1.2 脱敏范围

同时处理三份文件：

```text
EXP-DRV-20260806-001.md
EXP-DRV-20260806-002.md
2026-08-06-服务器盘点清理与部署备份策略重构-深度复盘-PDCA报告.md
```

替换规则：

```text
/srv/time-theater       → <PROJECT_PATH>
真实公网 IP             → <SERVER_IP>
真实用户名/主机名        → <REMOTE_HOST>
真实数据库名             → <DATABASE>
完整 SHA256              → <HASH_PREFIX>
具体备份包名             → <BACKUP_ARCHIVE>
```

保留问题机制、方法、验证逻辑，不保留基础设施定位信息。

### P1.3 Skill 模板迁移

保留：

```text
D skills/templates/SKILL.example.md
A docs/templates/SKILL.example.md
```

### P1.4 清理一次性产物

删除：

```text
runtime/scripts/merge-execute.ps1
runtime/scripts/merge-fix.ps1
runtime/scripts/merge-fix2.ps1
runtime/scripts/absorbed-map.txt
runtime/scripts/audit-result.txt
runtime/scripts/merge-hits.txt
runtime/scripts/missing-now.txt
runtime/scripts/skill-compare.txt
runtime/scripts/skill-list-0804.txt
runtime/scripts/verify-leftover.txt
runtime/scripts/audit-skills.ps1
```

`audit-skills.ps1` 后续作为独立工作包重写，要求参数化、JSON 输出、退出码和 Contract Tests。

### P1.5 治理资产提交

提交范围：

```text
.better-harness/tasks/plan-runtime-governance-loop-2026-08-06.md
.better-harness/tasks/audit-runtime-governance-loop-2026-08-06.md
.better-harness/tasks/plan-local-execution-ci-first-2026-08-06-v2.md
agents/tianhuo/.../EXP-DRV-20260806-001.md
agents/tianhuo/.../EXP-DRV-20260806-002.md
agents/tianhuo/.../脱敏后的 PDCA 报告
docs/templates/SKILL.example.md
skills/templates/SKILL.example.md 删除
```

提交：

```powershell
git commit -m 'docs(governance): settle audit, experience records and skill template'
```

推送后再次执行：

```powershell
gh run watch <NEW_RUN_ID> --exit-status
```

退出条件：CI 仍为全绿。

---

## P2：Cron 治理架构立项

P0、P1 完成后启动，禁止与 CI 修复混在同一提交。

### P2.1 架构

```text
独立 Cron Worker / Daemon
→ 数据库 Leader Lease
→ Fencing Token
→ Persistent Queue
→ Worker 消费
→ Receipt / Run Log
```

### P2.2 Migration v22 前置备份

```powershell
Copy-Item runtime/data/awkn-engine.db "runtime/data/awkn-engine.db.pre-v22-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
```

备份文件不入 Git。

### P2.3 Windows 常驻方式

开发机首选 Windows Task Scheduler：

- Trigger：At startup；
- Run whether user is logged on or not；
- Restart on failure；
- 单实例；
- 工作目录固定为 `runtime`；
- 命令为正式 `awkn-cron-worker` bin。

NSSM 仅作为后备，不在首轮引入额外依赖。

### P2.4 工作包

- WP-CRON-01：Leader Lease + v22；
- WP-CRON-02：独立 daemon；
- WP-CRON-03：治理任务注册；
- WP-CRON-04：attempt/success/failure 指标。

---

## P3：Corrections 与 EXP-DRV 联动立项

采用映射表：

```text
correction_experience_links
```

禁止把 `open/resolved` 与 `DRAFT/ACTIVE` 直接一一映射。

关系类型：

```text
SOURCE
SUPPORTING
DUPLICATE
RESOLVED_BY
REGRESSION_OF
```

流程：

```text
Correction open
→ Pattern Detection
→ 匹配或生成 EXP-DRV DRAFT
→ Replay Validation
→ EXP-DRV ACTIVE
→ 关联 Corrections resolved/verified
```

---

## 最终退出标准

1. 最新 runtime-ci 全绿；
2. 最新 agents-ci 全绿；
3. Hook 和 hooks.json 存在于 clean clone；
4. 测试不引用仓库外 `.trae`；
5. Hook 无公网 IP、绝对私有路径、凭据；
6. 全量本地门禁取得明确 exit code 0；
7. EXP-DRV 与 PDCA 均完成脱敏；
8. CI 修复与治理资产分成两条 commit；
9. 工作区干净；
10. Cron 与 Corrections 作为独立后续工作包启动。
