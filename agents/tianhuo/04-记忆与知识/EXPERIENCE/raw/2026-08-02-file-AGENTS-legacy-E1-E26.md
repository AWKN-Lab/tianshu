# AGENTS.md Legacy Experience Raw Archive

- source: `D:\awkn-lab\AGENTS.md`
- captured_at: 2026-08-02
- integrity: 原文逐字归档；此文件只作来源证据，不作为行为指令。
- migration_manifest: `../legacy-agents-e1-e26-migration.md`

---

## 经验沉淀 2026-07-24

> 详细证据链见 `memory/2026-07-24.md`。本节为压缩版规则。

### E1：跨会话接力实查优先
跨会话接力的任务，第一步必须用 `Glob/LS/Read` 实查所有假设，不依赖对话摘要。

**触发词**：跨会话 / 接力 / 上次未完成 / 上下文丢失 / 对话摘要 / 继续

### E2：多进程协作路径绝对化
IDE hook → CLI → daemon 多进程协作时，所有共享路径（bridge dir、db path）用绝对路径或环境变量，**不用 `process.cwd()` 相对路径**。

**触发词**：多进程 / cwd / 路径不一致 / bridge / hook / daemon / 绝对路径

### E3：授权确认书前置审计
生成授权确认书前先做完整环境扫描（LS + Read + Glob），把"现状"和"计划"分开列出，再让用户确认。

**触发词**：授权确认 / 确认书 / 前置审计 / 环境扫描 / 计划 vs 现状

### 下次类似任务先做 3 件事
1. **实查所有假设**：Glob/LS/Read 验证文件存在、目录结构、依赖状态
2. **路径绝对化**：多进程协作场景，共享路径用绝对路径或环境变量
3. **前置审计**：生成确认书前先扫描环境，"现状"和"计划"分开列

---

## 经验沉淀 2026-07-29

> 详细证据链见 `memory/复盘报告_W6灰度发布_2026-07-29.md`。本节为压缩版规则。

### E4：部署脚本同步范围检查
部署脚本同步范围必须显式包含根目录配置文件（ecosystem.config.js、.env.example 等），不能默认只同步 `backend/` / `src/` 等代码目录。否则生产环境会持续运行旧配置，即使代码已更新。

**触发词**：deploy / 同步 / ecosystem.config.js / PM2 reload / 配置不生效

### E5：schema-gate 切换前先验证 DB 角色分离
任何 `start.js` 类 schema-gate 入口，切换前必须确认 `SCHEMA_CHECK_DB_*` 与 `APP_DB_*` 已按最小权限原则分离。未分离时直接切换会导致启动失败，需先创建只读的审计用户（或按架构要求的最小权限用户）。

**触发词**：schema-gate / SCHEMA_CHECK_DB / start.js / 入口切换 / migration gate

### E6：PowerShell SSH heredoc 不可直接写复杂命令
Windows PowerShell 通过 `ssh host "..."` 执行 heredoc 或多层引号命令时，会因转义语义差异失败。复杂命令应写入 `.sh` 文件，scp 上传后用 `bash file.sh` 执行。

**触发词**：PowerShell / ssh heredoc / 转义 / EPIPE / Windows 到 Linux

### E7：*.bak 文件被 pre-deploy-guard 硬拦截
`pre-deploy-guard.ps1` 会在 `/opt`、`/www/wwwroot` 等目录搜索 `*.bak*` / `*.bak-*`。多项目共用服务器时，其他项目的备份文件会阻塞 annie 部署。处理方案：
- 属于自己的备份迁移到项目外独立目录（如 `/root/<project>-env-backups/`）
- 不属于自己项目的备份，先移到安全位置再部署

**触发词**：*.bak / pre-deploy-guard / no-violation / 部署被拦截

### E8：pm2 reload <name> 不重新读取 ecosystem.config.js
要让 PM2 重新读取 `ecosystem.config.js` 必须用完整路径：`pm2 reload /opt/tut/ecosystem.config.js --only tut-backend`。仅 `pm2 reload tut-backend` 会更新进程但不重读配置文件。

**触发词**：pm2 reload / ecosystem.config.js / env 不生效 / 配置未更新

### E9：部署后必须立即写入 .deployed-sha
服务器如果非 git 仓库，部署后必须立即写入 `.deployed-sha` 文件作为版本真值。该文件是后续 pre-deploy-guard fingerprint 检查的基线，缺失会导致下一次部署闸门跳过版本校验。

**触发词**：.deployed-sha / fingerprint / 版本真值 / 非 git 服务器

### 下次类似任务先做 3 件事
1. **审查部署脚本同步范围**：确认所有根目录配置文件在 scp/tar 范围内
2. **检查 schema-gate 入口前提**：未配置 DB 角色分离时不切换 start.js
3. **扫描 *.bak 文件**：`find /opt /www/wwwroot -name '*.bak*'` 并提前处理

---

## 经验沉淀 2026-07-29（GUNDAM 发布闭环）

> 详细证据链见 GUNDAM git log（REL-001..REL-005）和 release-readiness-codex-pet.json。本节为压缩版规则。

### E10：SHA256SUMS 必须从 Git blobs 生成，不能从工作区字节生成
完整性校验清单（SHA256SUMS.txt）必须从 `git cat-file blob HEAD:<path>` 生成，而非直接读取工作区文件字节。Windows 上 `core.autocrlf=true` 会导致工作区文件含 CRLF，而 Git blob 存储的是规范化后的内容（LF），两者哈希不一致。跨机器验证时工作区字节哈希无法稳定复现。

**触发词**：SHA256 / checksum / 完整性 / CRLF / 跨机器 / 哈希不一致 / autocrlf

### E11：跨 repo 外部依赖必须有可重现的 setup 脚本
项目依赖 repo 外的文件（如 capabilities manifest、外部配置）时，必须创建可重现的 setup 脚本（如 PowerShell `.ps1`），而非手动创建。脚本应支持 `-DryRun` 参数验证、路径自动发现、SHA256 校验和幂等执行。否则 repo 外文件容易丢失且无法追溯。

**触发词**：跨 repo / 外部依赖 / fixture 丢失 / capabilities / repo 外文件 / 不可重现

### E12：PowerShell .ps1 文件必须强制 CRLF 行尾
`.gitattributes` 必须包含 `*.ps1 text eol=crlf`。PowerShell 解析器对 LF 行尾的 `.ps1` 文件行为异常：`Test-Path` 参数绑定失败（"Cannot bind argument to parameter 'Path' because it is null"）、行号报告错误。LF 行尾的脚本在 Windows 上可能静默失败或产生难以定位的错误。

**触发词**：.ps1 / CRLF / Test-Path / 参数绑定失败 / LF / PowerShell 行尾 / .gitattributes

### E13：RC prerelease 是发布闭环的有效中间态
当自动化门禁全绿但人工验收项未完成时，应使用 GitHub prerelease（`isPrerelease: true`）作为中间态发布。这让代码可追溯、可分享、可回滚，同时通过 "RC" 标记明确告知用户这不是正式版。人工验收通过后再创建正式 tag（如 `v0.7.0-codex.2`）。避免"全有或全无"的发布思维。

**触发词**：prerelease / RC / 发布闭环 / 人工验收阻塞 / 中间态发布 / isPrerelease

### 下次发布闭环先做 3 件事
1. **先建 .gitattributes**：在任何 SHA256 操作前，先强制所有文件类型的行尾规范（`*.ps1 text eol=crlf`、`*.json text eol=lf` 等）
2. **先查跨 repo 依赖**：识别所有 repo 外文件，为每个创建可重现 setup 脚本并纳入 `-DryRun` 验证
3. **先设 SHA256 自动化**：将 SHA256SUMS 生成集成到 pre-commit hook 或 CI，避免每次修改后手动重新生成（本次因遗漏导致 7 次 chore(integrity) 提交）

---

## 经验沉淀 2026-08-02（PR #157 Schema 违规修复）

> 详细证据链见 PR #157 提交 328fad5 和本次复盘报告。本节为压缩版规则。

### E14：测试枚举必须从 schema 派生，禁止双源维护
测试文件中涉及 schema 枚举值的集合（如 `allowed` 状态集合）必须从 schema 定义派生（如 zod 的 `new Set(Schema.options)`），禁止硬编码第二份列表。双源维护必然漂移：schema 演进时测试不会同步，导致偶发失败。

证据：PR #157 `tests/platform/project-status-config.test.js` 硬编码 `allowed = new Set(['PLANNED','READY',...])`，但 `WorkPackageStatusSchema` 用的是 `DRAFT`（非 `PLANNED`）且后来加了 `DEPLOYED`，双源漂移导致 2 用例失败。修复改为 `new Set(WorkPackageStatusSchema.options)` 后 4/4 PASS。

**触发词**：双源维护 / 枚举漂移 / allowed 集合 / schema.options / 测试枚举 / PLANNED vs DRAFT

### E15：strict schema 与业务证据冲突时优先扩展 schema
当 strict 模式 schema（如 zod `.strict()`）拒绝承载真实业务证据的字段时，优先在 schema 中显式定义该字段（通常为 `.optional()`），而非删除业务证据回退状态。前提是该字段代表合法业务事实（如真实生产部署证据：SHA、URL、健康状态、备份路径），不是错误数据。删除真实证据会导致可追溯性丧失。

证据：PR #157 `project-status.json` 的 `production_deployment` 字段记录真实生产部署（/api/health 200, migrations 7/7 PASS），但 `ProjectStatusSchema` 是 strict 模式未定义该字段。master 上 6f0c5bb 用"删除字段 + RT1 状态回退 MERGED"方案，丢失证据；feat/v21 上 328fad5 改用"新增 `ProductionDeploymentSchema` 作为 optional 字段"方案，保留证据 + 通过验证。RT1 已实际部署，状态应为 DEPLOYED 而非 MERGED。

**触发词**：strict schema / 额外字段 / production_deployment / schema 演进 / 删除证据 / DEPLOYED / schema 反映现实

### 下次类似任务先做 3 件事
1. **先查跨分支修复**：`git log --all --oneline -- <目标文件>` 检查其他分支是否已有类似修复，避免重复工作或方案冲突（本次差点在 master 上重复 6f0c5bb 的工作）
2. **先确认当前分支**：`git branch --show-current` 确认在 PR 关联分支，避免在错误分支修改后需 stash 转移（RunCommand 是独立 shell，checkout 不持久化）
3. **先派生测试集合**：修复枚举相关测试时，先看能否从 schema 派生（`new Set(Schema.options)`），根除双源维护漂移

---

## 经验沉淀 2026-08-02（CI/CD 闭环修复）

> 详细证据链见本次复盘报告和 `reports/2026-08-01-win-cicd-e1d7a940.md`。本节为压缩版规则。

### E16：CI/CD 工具文件必须 git tracked
pipeline 定义（cicd.json）、guard 脚本（cicd-guards.js）等 CI/CD 基础设施文件必须 `git add` + `git commit`，不能只作为本地文件存在。`git clean` 会删除未跟踪文件，导致 hook 静默失败、所有后续提交绕过 CI 验证。

证据：`.awkn/actions/cicd.json` 和 `scripts/cicd-guards.js` 从未被 git 跟踪，v21 工作期间 `git clean` 删除后 post-commit hook 对 253 个提交静默失败。

**触发词**：cicd.json / git clean / 未跟踪 / hook 失败 / 工具文件 / Pipeline definition not found

### E17：异步 hook 必须有失败可见性
post-commit hook 用 `nohup ... > log 2>&1 &` 后台运行时，必须增加 pre-check（验证关键文件存在）+ 失败时 stderr 告警。否则 hook 静默失败，提交者完全无感知，形成运维盲区。

证据：hook 失败 253 次无人发现，因为 `nohup &` 的输出只写入日志文件，不输出到终端。修复后增加 `if [ ! -f "$PIPELINE_DEF" ]; then echo "⚠️ PIPELINE_HOOK_FAILED" >&2; fi`。

**触发词**：nohup / 静默失败 / post-commit / stderr / hook 可见性 / 异步任务

### E18：EventStore stale lock 需手动清除
awkn-action-runner 用 SQLite EventStore 跟踪 active runs。如果 run 进程崩溃未过渡到终止状态（stuck in 'running'），会永久阻塞同 workflow 的所有后续 run。清除方法：直接更新 SQLite 数据库 `UPDATE runs SET status='failed' WHERE id='<stale_run_id>'`。

数据库路径：`d:\awkn-lab\awkn引擎\runtime\data\awkn-engine.db`（或 `$AWKN_DB_PATH`）。

证据：run cae518f2 stuck in 'running' 状态，阻塞了 31f0286 的 pipeline 触发。手动 UPDATE 后 pipeline 立即成功启动。

**触发词**：another active run / rejected / stale lock / EventStore / awkn-engine.db / pipeline blocked

### 下次类似任务先做 3 件事
1. **先 `git ls-files` 审计工具文件**：确认所有 CI/CD 配置、hook 脚本、guard 逻辑都被 git 跟踪，`git ls-files <path>` 非空
2. **先验证 hook 失败可见性**：故意删除一个配置文件，提交一次，确认 stderr 有告警输出
3. **先检查 EventStore stale lock**：pipeline 被 "another active run" 拒绝时，检查 `awkn-engine.db` 中是否有 stuck 'running' 状态的 run

---

## 经验沉淀 2026-08-01（服务器盘点+清理闭环）

> 详细证据链见本次复盘报告。本节为压缩版规则。

### E19：服务器清理三步备份法（tar + scp + SHA256）
服务器删除 >10M 目录前必须执行三步备份：① 服务端 `tar -czf` 打包（排除 `.git/`、`node_modules/`、`vendor/`）→ ② `scp` 下载到本地 → ③ 双端 `sha256sum` 校验一致。校验通过后才 `rm -rf`，服务端 tar 包在本地校验后立即删除避免二次占用。

**触发词**：服务器清理 / rm -rf / 删除目录 / 备份 / 磁盘空间 / tar scp

### E20：构建工作区不应放 /opt/
构建工作区（如 mrmont-v2-build）应放在 `/tmp/` 或带自动清理的 workspace 目录，不能放 `/opt/`。`/opt/` 被当作永久目录，临时构建产物堆积在此不会被 cron 清理。`/tmp/` 有定时清理（`find /tmp -name "*.bundle" -mtime +1 -delete`），但 `/opt/` 没有。

**触发词**：构建工作区 / mrmont / /opt 清理 / 构建产物 / 临时目录

### E21：PowerShell SSH 复杂命令必须走 .sh 脚本
Windows PowerShell 通过 `ssh host "命令"` 执行含 `$`、引号嵌套、`<`、heredoc 的命令会失败（CLIXML 解析错误、参数绑定失败）。复杂命令一律写 `.sh` 文件 → `scp` 上传 → `bash file.sh` 执行。简单命令（无引号嵌套）可直接 SSH。

**触发词**：PowerShell / ssh / CLIXML / ParserError / 引号转义 / heredoc / .sh 脚本

### E22：项目退役六项检查清单
服务器项目删除前必须验证六项全部 ✅：① `ps -ef | grep` 无进程 → ② `ss -tlnp | grep` 无端口监听 → ③ `pm2 list` 无注册 → ④ `systemctl list-units` 无 unit → ⑤ nginx 配置无反代指向 → ⑥ cron 无引用。缺一项则标【待确认】不删。

**触发词**：项目退役 / 孤儿项目 / 删除检查 / pm2 stopped / 无监听 / 退役检查清单

### E23：inode 访问法处理异常文件名
服务器上因误操作产生的异常文件名（如 `\`、`\ `、`你再试试之前没成功的工具`）无法用常规引号路径访问时，用 `find /root -maxdepth 1 -inum <inode> -exec <command> {} \;` 通过 inode 号操作。`find -inum` + `-exec` 或 `-delete` 是处理任意文件名的万能方法。

**触发词**：异常文件名 / 反斜杠 / inode / find -inum / 文件名删除 / cat -v

### E24：日志归档用 cp + truncate 而非 restart
在线服务日志过大但不允许中断时，用 `cp logfile archive/logfile-$(date)` 备份 + `truncate -s 0 logfile` 清空原文件，而非重启服务。truncate 不改变文件 inode，持有文件句柄的进程（PM2/systemd）继续写入，零中断。

**触发词**：日志归档 / truncate / 零中断 / cp + truncate / 日志过大 / 不重启

### 下次服务器清理先做 3 件事
1. **先跑 `du -sh /opt/* | sort -hr | head -10`**：30 秒锁定最大占用者，不盲目逐目录 ls
2. **先查 git remote + git status**：含 `.git` 的目录删除前确认 origin 可达 + 改动已推送，避免丢失未推送代码
3. **先写 .sh 脚本再 scp 执行**：PowerShell → SSH 引号转义不可靠，复杂命令一律走脚本文件

---

## 经验沉淀 2026-08-02（v21 时区一致性 Bug）

> 详细证据链见 win repo commit 000c146 和 v21-project-retention-trigger.test.js。本节为压缩版规则。

### E25：SQLite datetime 时区必须与解析端一致
SQLite 触发器中 `datetime('now','localtime')` 返回本地时间字符串（无时区后缀），`datetime('now')` 返回 UTC 字符串（无时区后缀）。当代码用 `Date.parse(str.replace(' ','T') + 'Z')` 或 `Date.toISOString()` 解析/生成该字段时，**字段必须用 UTC**（`datetime('now')`）。混用 localtime 写入 + UTC 解析会在 UTC+8 时区产生 8 小时偏移。

**判断规则**：
- 字段被 `parseSqlDate()` / `+ 'Z'` / `toISOString()` / `datetime('now')` SQL 比较处理 → **必须 UTC**
- 字段仅用于显示（`created_at`、`updated_at`、`retention_updated_at`）→ 可用 localtime（与 `document-store.js` 一致）

**全代码库约定**（win repo v21 模块）：
- `expires_at` → UTC（`expiryForPolicy()` 用 `toISOString()`，`parseSqlDate()` 用 `+ 'Z'`，`document-retention.js` 用 `datetime('now')` 比较）
- `created_at` / `updated_at` / `retention_updated_at` → localtime（显示字段，`document-store.js` 用 `datetime('now','localtime')`）

证据：`trg_project_lifetime_documents_due_on_close` 触发器用 `datetime('now','localtime')` 写 `expires_at`，但 `parseSqlDate()` 按 UTC 解析。上海时区下 project_lifetime 文档归档后 8 小时才被判定到期，`v21-project-retention-trigger.test.js` 断言 `dueAt <= Date.now() + 1000` 失败。修复：触发器中 `expires_at` 改用 `datetime('now')`，其余显示字段保持 localtime。

**触发词**：datetime / localtime / 时区 / expires_at / parseSqlDate / toISOString / UTC+8 / 8 小时偏移 / 触发器时区 / project_lifetime

### E26：时间相关测试失败先算偏移量
时间相关断言失败时（`expected X to be less than or equal to Y`），第一步计算 `X - Y` 的偏移量：
- 偏移 = 8h（28800000ms）→ 时区 bug（UTC vs localtime 混用）
- 偏移 = 1h（3600000ms）→ DST 或时区边界
- 偏移 = 数小时且不稳定 → `Date.now()` 在不同代码路径的调用时差
- 偏移 = 固定常量 → 硬编码的 grace period 或 buffer

不要急于改测试断言，先定位偏移来源。

**触发词**：时间断言失败 / toBeLessThanOrEqual / 偏移量 / 28800000 / 时区 bug 定位 / 时间相关测试

### 下次写 SQLite 触发器先做 3 件事
1. **先查字段解析端**：`Grep` 搜索字段名，确认是用 `+ 'Z'`（UTC）还是 `new Date(str)`（localtime）解析
2. **先统一时区约定**：同一字段在所有写入点（触发器、ORM、手写 SQL）用相同的时区，不能混用
3. **先写时区边界测试**：在 UTC+8 环境跑测试（`TZ=Asia/Shanghai`），验证时间字段不产生偏移
