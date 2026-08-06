# PLAN — Runtime 治理闭环修复（cron 调度器 / Corrections→EXP-DRV 联动 / 数据清理）

**计划 ID**: plan-runtime-governance-loop-2026-08-06
**类型**: Implementation + Migration（代码修复 + 数据清理，含不可逆删除）
**编写时间**: 2026-08-06
**依据**: 独立运行时验证（typecheck 0 错误 / verify 24/24 / architecture blocking=0；实测 cron trigger 产出 `cron_run_log dead` 记录但 `run_count=0`）

---

## 1. 目标（Objective，可衡量）

| 编号 | 目标 | 可衡量口径 |
|---|---|---|
| O0 | CI 转绿（最高优先级） | 最新 push 的 GitHub Actions `runtime-ci` 的 check job conclusion = **success**（此前 8 连败）；`light-check`/`agents-check` 保持绿 |
| O1 | 接通 cron 调度器 | MCP server 启动即拉起 CronEngine；此后 72h 内 `cron_run_log` 出现 ≥1 条**非 dead** 的真实治理任务记录 |
| O2 | 修复任务指标语义 | 失败路径也更新 `last_attempt_at` 并累计 `failed_count`；`awkn_cron_list` 能区分"从未运行 / 失败 / 成功" |
| O3 | 建立真实治理任务集 | 50+ 条测试 cron 全清；注册 3 类治理任务（经验扫描 / 经验补全 / Corrections 清理），每条 72h 内 `run_count ≥ 1` |
| O4 | 接通 Corrections→EXP-DRV | 新 corrections 自动绑定 `experience_id` 或按指纹去重合并；状态映射（open/resolved ↔ DRAFT/ACTIVE）双向可查 |
| O5 | 清空经验草稿积压 | `scan_drafts` pending 从 **116 → 0**（LLM 补全或显式归档废弃，逐条有去向） |
| O6 | 清理脏数据与未提交资产 | `test-*` goal 全部归档；absorption-registry notes 数组修复；工作区未提交 = 0；main push github 成功（或显式记录外部阻塞） |
| O7 | 门禁全程不退 | typecheck 0 错误 / verify 24/24 / architecture `blockingViolations=0` |

## 2. 范围（Scope）

**包含**
- `runtime/src/cron/engine.ts`、`worker.ts`、`jobs-manager.ts` 的启动与指标修复
- `runtime/src/mcp/server.ts` 启动期接入 CronEngine
- `runtime/src/store/migrations.ts` 新增迁移（v22 起）
- Corrections Ledger ↔ EXP-DRV 绑定协议（schema + 去重 + 状态映射 + 激活回写）
- 治理任务注册（cron 3 类）+ 50 条测试 cron 备份后清除
- 经验草稿批量处置（116 条：补全 / 归档）
- 数据清理（test-* goal 归档、absorption-registry notes 修复）
- 未提交资产入库 + push（github 可达时）

**不包含（独立后续计划，不在本 PLAN 内）**
- 架构债务清零（42 Direct DB Import / 15 Singleton / skills/manager.ts）— 单独 Refactor 计划
- Linux 跨平台 Replay 验证（需外部 runner）
- Context Manifest / Render v13 Persistence 决策（R5）
- Agent OS R3—R6 正式验收（需统一证据框架）
- EXP-DRV-009 激活（依赖 O1 的 GitHub Actions 实测证据，本 PLAN 只做前置准备）

## 3. 阶段（Phases）

### P0 — 修复 CI 全红（第 0-1 天，前置阶段，完成后才进入 P1）

**背景（2026-08-06 实测）**：github 可达且 main 已同步（远端 = 本地 HEAD 8f682ad）；但 `gh run list` 最近 8 次运行全部 FAILURE。`runtime-ci` check job 的 "Run runtime checks" 步骤红，失败为 3 条 TRAE hook 测试（test 67/68/69）：`Cannot find module '/home/runner/work/tianshu/.trae/hooks/tianshu-hook.mjs'`。

**根因**：`.gitignore` 忽略整个 `.trae/`；`runtime/test/github-actions-guard.test.ts:8` 硬编码引用 `.trae/hooks/tianshu-hook.mjs`。本机绿 = 文件躺在本地；CI clean checkout 无此文件 = 红。

**修复（已完成方案验证）**：
- `.gitignore`：`.trae/` 改为精确例外（`.trae/*` + `!.trae/hooks.json` + `!.trae/hooks/` + 排除 `hooks/*` 后 `!.trae/hooks/tianshu-hook.mjs`）— 已验证 `git add --dry-run` 放行 hook 与 hooks.json，`state/logs/specs/rules` 保持忽略
- hook 文件经审查无密钥（纯逻辑：stdin JSON → deny/allow 决策；运行时产物写 `.trae/state`、`.trae/logs`，已被 `.trae/.gitignore` 覆盖不污染提交）
- 备选已排除：测试条件 skip（CI 永久失去覆盖）；测试内嵌 fixture（与真实 hook 行为漂移风险）

- 交付物：`git add .trae/hooks/tianshu-hook.mjs .trae/hooks.json`（tracked 化）+ `.gitignore` 例外规则
- 验证：
  1. `git status` 显示 hook 文件 staged（非 ignored）
  2. **clean-clone 模拟**：`git worktree add` 临时目录（仅含 tracked 文件）→ 在该目录跑 `npm run test:verify` 中的 guard 测试（`node --import tsx --test test/github-actions-guard.test.ts`）→ 3 条 hook 测试通过
  3. 本机全量 `npm run test:verify` 24/24 不回退
- commit 节点：`fix(ci): track trae hook assets so github-actions-guard tests run on clean checkout`
- 推送后：`gh run watch 31028326952` 同流程的下一 run，check job 必须 success；若仍红，抓 `--log-failed` 继续修，不进入 P1

### P1 — 接通调度器与指标语义（第 2-3 天）
- 交付物：`server.ts` 启动时调用 `startCronEngine()`；`worker.ts` 失败路径更新 `last_attempt_at`/`failed_count`（migration v22）；幂等/lease 保护复用
- 验证：`npm run test:verify` 24/24；新增失败路径单测（mock executor 抛错 → 断言 job 指标更新）；`awkn-engine cron start` 冒烟；typecheck 0
- commit 节点：`fix(cron): start CronEngine from MCP server + record failed attempts`

### P2 — 治理任务集落地（第 2-3 天）
- 交付物：50+ 条测试 cron 备份导出（CSV/JSON 到 `.better-harness/tasks/`）后清除；注册 scan_drafts（每日）、complete_drafts（每日，分批上限）、corrections 清理（每周）3 类真实任务
- 验证：`awkn_cron_list` 只剩 3-4 条真实任务；手动 trigger 一条 scan 任务，`cron_run_log` 出现非 dead 成功记录
- commit 节点：`chore(cron): replace test health-check jobs with real governance tasks`

### P3 — Corrections→EXP-DRV 联动协议（第 3-5 天）
- 交付物：绑定协议（correction 新增 `experience_id` 回填；指纹去重；状态映射 open↔DRAFT / resolved↔ACTIVE 或归档；激活回写 EXP-DRV 状态变更通知）
- 兼容策略：loop_monitor 现有写入格式保留，协议层做归一
- 验证：构造 2 条同指纹 + 1 条新 correction，断言去重/绑定；`evolve_list` 可见 experience_id 非空
- commit 节点：`feat(evolve): bind corrections ledger to EXP-DRV lifecycle`

### P4 — 经验草稿清账（第 4-6 天，可与 P3 并行）
- 交付物：116 条草稿分类处置 — 模板型（pendingMarker=3 且同构）批量归档废弃（移入 `archived/` + 记录）；内容型（如 EXP-DRV-20260804-011、20260805-004 等 marker=1）走 `complete_drafts` LLM 补全
- 验证：`scan_drafts` pending = 0；归档清单在报告文档可查
- commit 节点：`docs(experience): settle 116 pending drafts (archived n / completed m)`

### P5 — 数据清理、提交与外部验证（第 5-7 天）
- 交付物：`test-*` goal 批量归档（status 置 archived/achieved + 备注，不动活跃业务目标）；absorption-registry `entries[2]/[8]` notes 修复为字符串；未提交资产（EXP-DRV-20260806-001/002、复盘报告、audit 脚本）审阅后入库；push main 至 tianshu + github
- 验证：goal list active 无 test-*；registry JSON 校验通过；`git status` 干净；github push 成功或记录阻塞证据（Run ID 抓取作为 EXP-DRV-009 前置）
- commit 节点：`chore: settle data cleanup and push mainline`

## 4. 风险（Risks，≥5）

| # | 风险 | 概率 | 影响 | 等级 | 缓解 |
|---|---|---|---|---|---|
| R1 | 4+ MCP 实例同时拉起 CronEngine → 重复调度/重复执行 | 高 | 高 | **高** | 复用现有 lease + idempotency（worker.ts 已实现）；CronEngine 单例；verify-cron 门禁覆盖；若仍重复 → 升级独立 daemon（决策 D1 后备） |
| R2 | 多实例共享 sqlite 并发写损坏 | 中 | 高 | **高** | 先备份 `awkn-engine.db`（已见 .migration-backup 惯例）；WAL 模式；清理前只读查询 |
| R3 | complete_drafts 对 116 份调 LLM 成本/时长失控 | 高 | 中 | **中** | 模板型直接归档不补全（决策 D4）；内容型分批 ≤10 份/批；超预算暂停留档 |
| R4 | 删 50 条 cron 误删真实任务 | 低 | 中 | 中 | 删除前全量导出备份；删除后核对 3 类真实任务在位 |
| R5 | github 网络持续不可达，push/外部 CI 无法完成 | 中 | 中 | 中 | tianshu 先推（已验证可达）；github 重试 + 记录为外部阻塞，不阻塞 P1-P4 验收 |
| R6 | 指标语义改动引入回归（verify 24/24 变红） | 低 | 高 | 中 | 先加失败路径单测再改实现；全量 `npm run test:all` 回归 |
| R7 | corrections 协议改动与 loop_monitor 现有写入不兼容 | 中 | 中 | 中 | 协议层归一，不改 loop_monitor 写格式；双写兼容 + 迁移期验证 |
| R8 | test-* goal 归档误伤业务目标 | 低 | 低 | 低 | 按 id 前缀 `test-` + owner=test 过滤，白名单式删除，先导出再归档 |
| R9 | hook 入库后更新频繁 / 混入环境信息 | 低 | 中 | 中 | 入库前已审查无密钥；后续 hook 变更走 commit 记录（本来就是安全逻辑文件）；`state/`/`logs/` 运行时产物仍被忽略 |

## 5. 验证（Verification）

- **每阶段验证**：见各阶段"验证"行，全部必须产出确定性证据（命令输出 / DB 查询 / 文件存在）
- **门禁回归**：每阶段末尾跑 `npm run check`（typecheck + lint + test:all）+ `npm run test:verify` + `npm run check:architecture`
- **运行时证据**：cron_run_log 查询（成功/失败分布）、evolve_list（experience_id 非空率）、scan_drafts（pending 数）、git status（干净度）
- **外部证据**：github Actions Run ID + light-check 步骤耗时（P5，可达时）

## 6. 退出标准（Exit Criteria，全达标才算完成）

0. 最新 push 的 GitHub Actions `runtime-ci` check job = success（`gh run list` 最近 1 条非 failure），证据含 Run ID
1. `awkn_cron_list`：仅 3-4 条真实治理任务，且至少 1 条 72h 内 `run_count ≥ 1`（非 dead）
2. `evolve_list`：新增 corrections 的 `experience_id` 非空率 ≥ 80% 或指纹去重 100%，无重复 fingerprint 堆积
3. `scan_drafts`：pending = 0，归档清单可查
4. `goal_list`：active 中 0 条 `test-*`
5. `absorption-registry.json`：JSON Schema 校验通过，无逐字符数组
6. 门禁：typecheck 0 / verify 24/24 / blockingViolations=0
7. `git status`：未提交 = 0；github 已 push 或记录外部阻塞证据（含 Run ID 缺失原因）

## 7. 决策日志（Decision Log）

| # | 决策 | 选择 | 理由 | 备选（未选） |
|---|---|---|---|---|
| D1 | 调度器形态 | MCP 进程内拉起 CronEngine（start() 幂等单例） | lease+idempotency 已存在，改动最小；CLI `cron start` 保留为独立运行选项 | 独立 daemon 进程（需进程管理/自启，复杂度高，R1 证实重复后再升级） |
| D2 | 失败指标 | migration v22 新增 `failed_count`/`last_attempt_at` 列 | 语义清晰、向后兼容；`run_count` 保持"成功次数"不变 | 复用 run_count（语义污染，无法区分失败与未运行） |
| D3 | 测试 cron 处置 | 备份导出后物理删除 | 50 条全同质且指向不存在的服务，disable 会永久污染列表 | 仅 disable（列表长期脏） |
| D4 | 116 草稿处置 | 模板型归档废弃，内容型 LLM 补全 | marker=3 同构文件为批量生成模板，无补全价值；控制成本与时长 | 全部补全（成本失控，R3） |
| D5 | Corrections 绑定 | correction 表加 `experience_id` + 指纹去重 | 简单直接，匹配现有 schema | 独立映射表（过度设计，R5 后再议） |
| D6 | 决策时间点 | 2026-08-06，基于独立验证证据 | 防止回忆失真 | — |
| D7 | CI 红修复方式 | `.trae/hooks/*` 精确入库（gitignore 例外） | 测试引用真实 hook、CI 真实执行；文件无密钥可入档 | 测试条件 skip（CI 失去覆盖）/ 内嵌 fixture（行为漂移） |
| D8 | CI 修复提交策略 | 独立 commit，与 docs 资产提交分离 | 风险独立、可单独回滚（`git revert`） | 混合进 docs 提交（回滚会连带资产） |

## 8. 假设（Assumptions，显式标注）

- A1: 50+ 条"每小时健康检查"全部为测试/示例流程写入（`localhost:9000` 仅存在于测试文件）→ 备份后删除安全
- A2: 多个 MCP 实例共享同一 `awkn-engine.db`（已观察到 4+ 实例）→ lease/幂等机制按此假设验证
- A3: github 连接重置为环境性网络问题（tianshu 可达）→ 非认证或远端配置问题
- A4: `complete_drafts` 依赖 LLM，模板型草稿可批量跳过且不影响门禁
- A5: 现有 `verify-cron-cli.ts` 等测试期望 cron job 行为不变 → P1 改动后测试需同步核对

## 9. 质量门自检（7 个硬约束）

| 闸门 | 状态 |
|---|---|
| 1. 目标可衡量 | ✅ 每目标带数字口径（O1-O7） |
| 2. 范围清晰 | ✅ 包含/不包含/边界明确 |
| 3. 阶段 ≤ 14 天 | ✅ P1-P5 每阶段 ≤ 2 天 |
| 4. 每阶段交付物+验证 | ✅ 各阶段均有交付物/验证/commit 节点 |
| 5. 风险 ≥ 5 | ✅ 8 项，含概率×影响×等级×缓解 |
| 6. 退出标准可量化 | ✅ 7 条全量化 |
| 7. 假设显式标 | ✅ 5 条 |
| Migration 额外（数据清理） | ✅ 备份/回滚（R2/R4 缓解）、行为不变（verify 门禁）、灰度（P3 协议层兼容双写） |

---

**批准状态**: 待用户/审核批准
**执行者**: tianhuo（或用户指定的 agent）
