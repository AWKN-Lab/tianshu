# 授权确认书：Review Kernel 主线闭环落地

> 文档编号：AUTH-2026-07-29-REVIEW-KERNEL-MAINLINE
> 日期：2026-07-29 (Asia/Shanghai)
> 前置文档：
> - 用户原始指令：`# Review Kernel 主线闭环落地计划`（@天火）
> - `docs/2026-07-28-R2-Exit-Report.md`（Decision: GO）
> - `docs/2026-07-28-授权确认书-Phase6启动与capabilities收口.md`（capabilities 已决定删除）
> - `docs/2026-07-29-授权确认书-Step1收口与Step4缺口补齐.md`（Migration 缺口补齐路径）
> - `docs/audit/2026-07-28-architecture-breach-repair-plan.md`（架构断层修复）
> 状态：DRAFT_FOR_APPROVAL

---

## 一、环境前置审计结果（实查非摘要）

### 1.1 Git 状态（实查）

- 当前分支：`main`
- HEAD：`3ea2534 Merge PR #89: feat(C06-C09) Evidence-Gain Loop + Delivery/Outcome/Memory/Evolve`
- tianshu/main：`3ea2534`（与本地 main 同 SHA，已同步）
- Worktree：干净（`git status --short` 无输出）
- 三个目标分支本地与远端均不存在：
  - `codex/mainline-stability-fixes` ❌
  - `codex/review-kernel-v1` ❌
  - `codex/review-rollout` ❌

### 1.2 依赖提交实查

| Commit | message | 所在分支 | 主线是否包含 |
|---|---|---|---|
| `7cfa9c1` | `fix(review): confine OCR integration to engine` | `codex/review-kernel-mainline` | ❌ 主线无 |
| `36e220f` | `fix(phase6): verify test reliability, TypeScript errors, and add Review module` | `codex/review-kernel-mainline` | ❌ 主线无 |
| `0804075` | OpenCodeReview 仓库锁定提交（外部仓库） | `alibaba/open-code-review` | n/a（外部依赖） |

**`7cfa9c1` 实际内容**（10 文件，+102/-21）：
- `docs/review-kernel/ADR-001-review-kernel-v1.md`
- `docs/review-kernel/ocr-thin-fork-protocol.md`
- `docs/review-kernel/rollout-and-baseline.md`
- `integrations/open-code-review/{NOTICE,README,UPSTREAM.lock.json}`
- `runtime/src/review/adapters/outbound/ocr-cli-spec-provider.ts`
- `runtime/src/tools/builtin/review-repository-tool.ts`
- `runtime/test/{review-adapters,review-kernel-runner}.test.ts`

**`36e220f` 实际内容**（巨型混合 commit，包含 9 大类改动）：
- Review module 完整初始实现（`runtime/src/contracts/review.ts`、`runtime/src/review/`）
- capabilities fixture（已被 2026-07-28 授权书决定删除）
- verify-bridge-daemon `waitForDaemonReady` 修复（旧方案，本计划 PR 1 将用更彻底方案替代）
- TypeScript 修复（已在主线通过 PR #88/#89 落地）
- db.ts AWKN_DB_PATH 修复（已在主线）
- CICD loop 重构（已在主线）

### 1.3 OpenCodeReview 锁定提交实查

WebFetch 确认 `https://github.com/alibaba/open-code-review/blob/08040752143057781b40aa091b50edfa5895960b/go.mod`：
- `module github.com/alibaba/open-code-review`
- `go 1.25.5`
- 依赖包含：anthropic-sdk-go、openai-go、MCP SDK、otlp telemetry、bubbletea TUI、tiktoken
- **与计划描述完全一致** ✓
- **需要删除的依赖**：LLM（anthropic/openai）、Session/UI（bubbletea/bubbles/lipgloss）、遥测（otlp）、密钥配置

### 1.4 主线 Review 相关现状（实查）

| 检查项 | 主线状态 | 说明 |
|---|---|---|
| `runtime/src/review/` | ❌ 不存在 | PR 2 需新建 |
| `runtime/src/contracts/review.ts` | ❌ 不存在 | PR 2 需新建 |
| `runtime/src/tools/builtin/review-repository-tool.ts` | ❌ 不存在 | PR 3 需新建 |
| `integrations/open-code-review/` | ❌ 不存在 | PR 2 需新建 |
| `docs/review-kernel/` | ❌ 不存在 | PR 2 需新建 |
| `runtime/src/gates/review-verdict.ts` | ✅ 存在 | 旧文本 Verdict 路径（`parseStrictReviewVerdict` 解析 `VERDICT: PASS\|FAIL`），PR 3 需移出权威门禁 |
| `runtime/src/tools/builtin/index.ts` | ✅ 存在 | 未注册 `review_repository`，PR 3 需新增 |
| `runtime/src/shadow/` | ✅ 存在 | `shadow-diff-evaluator.ts`、`shadow-diff-receipt.ts`、`shadow-execution.ts`，PR 3 可复用 |

### 1.5 PR #89 P2 问题实查

**P2-1：重复模式诊断丢失 ACTION|ERROR 来源**

当前实现（`runtime/src/contracts/evidence-loop.ts`）：
```
405: reasons.push('repeated action fingerprint');        // 缺 [ACTION] 来源标记
417: reasons.push(`repeated failure type: ${last}`);     // 缺 [ERROR] 来源标记
```

当前 `strategy-switcher.ts` 用字符串 `includes` 匹配：
```
100: if (reasons.some((r) => r.includes('repeated action'))) return 'replace_skill';
105: if (reasons.some((r) => r.includes('repeated failure'))) return 'replace_tool';
```

**问题**：reasons 字符串无来源标识，测试无法直接断言"因 ACTION 重复而 SWITCH 到 replace_skill"，可能被其他低增益条件（如 `consecutive low delta`）顺带通过。

**P2-2：verify-bridge-daemon flaky test**

当前实现（`runtime/test/verify-bridge-daemon.ts`）：
- 第 76 行：`spawn('npx', ['tsx', 'scripts/bridge-daemon.ts'], { shell: true })` — 用 `shell:true`，不是 `process.execPath --import tsx`
- 第 94 行：`await new Promise((r) => setTimeout(r, 1000));` — **固定 sleep 1 秒**
- 第 72 行：`resolve(process.cwd(), 'data', ...)` — 用 `process.cwd()`
- 第 119 行：`daemon.kill('SIGINT')` — 没有等待 exit，没有 finally 清理临时目录
- 三个场景（正常/非法 JSON/多请求）共享进程风险

**`runtime/data/` 残留证据**：6 个 `test-bridge-daemon-*`、3 个 `test-bridge-err-*`、3 个 `test-bridge-multi-*` 目录未清理，证明测试确实有进程残留问题。

### 1.6 Migration 版本实查

- `runtime/src/store/migrations.ts` 最高 version: **7**（runtime-memory-os）
- `runtime/src/store/agent-os-migration-registry.ts` 最高 version: **13**
- **下一个版本是 v14** ✓ 与计划一致
- 主线已包含 `migration-backup.ts`（backup/restore/cleanup 闭环）

### 1.7 测试现状（来自 2026-07-29 授权书）

- typecheck: PASS
- unit: 99 pass / 0 fail
- contracts: 919 pass / 0 fail
- verify: `verify-bridge-daemon` 间歇性 1-2 fail（HEAD 状态下也存在，flaky test）

---

## 二、计划与实查的偏差澄清

### 2.1 偏差 1：`7cfa9c1` 是"修复"非"最终实现"

**计划描述**："从 `7cfa9c1` 最终实现选择性移植 Review 专属代码"

**实查结果**：`7cfa9c1` commit message 是 `fix(review): confine OCR integration to engine`，是修复 commit，不是初始实现。初始实现在 `36e220f`（`add Review module`）。

**澄清**：`7cfa9c1` 是 `codex/review-kernel-mainline` 分支上 Review 实现的**最终修复状态**。计划真实意图是"以 `7cfa9c1` 的代码状态为基线，选择性移植 Review 专属文件，跳过 `36e220f` 中的 capabilities fixture、TS 修复（已在主线）、verify-bridge-daemon 旧修复（PR 1 会重新修复）"。

**结论**：以 `7cfa9c1` 为基线挑选 Review 文件是正确的，但需明确"基线"指文件内容状态，非 cherry-pick 该 commit。

### 2.2 偏差 2：`36e220f` 已包含 verify-bridge-daemon 修复

**实查**：`36e220f` 已包含 `waitForDaemonReady` helper（监听 stdout ready 标记，替代 sleep 1s）。

**计划要求**：PR 1 用更彻底方案（`process.execPath --import tsx`、`shell:false`、独立进程、finally 清理）。

**结论**：PR 1 不从 `36e220f` 移植 verify-bridge-daemon 修复，而是基于主线当前实现重新修复。`36e220f` 的 `waitForDaemonReady` 思路可参考但方案更彻底。

### 2.3 偏差 3：capabilities fixture 已决定删除

**实查**：`36e220f` 包含 `capabilities/project/` fixture，但 `2026-07-28-授权确认书-Phase6启动` 已决定 A1 删除。

**结论**：选择性移植时跳过 `capabilities/` 目录。主线当前是否已删除需在 PR 2 启动前再核查（若未删除，PR 1 或 PR 2 启动前先删除）。

---

## 三、PR 1 决策：主线稳定性修复

**分支**：`codex/mainline-stability-fixes`（从 `main@3ea2534` 创建）

### 决策 A：重复模式诊断 ACTION|ERROR 来源标记方式

**现状**：reasons 是纯字符串，无来源标识。

**选项**：

- **A1 字符串后缀标记（推荐 ⭐）**：
  - `'repeated action fingerprint [ACTION]'`
  - `'repeated failure type: ${last} [ERROR]'`
  - `strategy-switcher.ts` 仍用 `includes` 匹配，兼容现有逻辑
  - 测试可断言 `reasons.some(r => r.includes('[ACTION]'))` 和 `recommendedOption === 'replace_skill'`
  - 改动最小，向后兼容
- **A2 结构化 reasons（对象数组）**：
  - `reasons: Array<{ source: 'ACTION' | 'ERROR' | 'DELTA' | 'HYPOTHESIS'; message: string }>`
  - 类型更安全，但需改 `assessStrategySwitch` 返回类型、`StrategySwitchResult` 类型、所有调用方
  - 改动大，违反"最小修改"原则
- **A3 reasons 前缀标记**：
  - `[ACTION] repeated action fingerprint`
  - 与 A1 类似，前缀 vs 后缀

**推荐**：**A1 字符串后缀标记**。最小改动，测试可直接断言来源，不破坏现有类型契约。

### 决策 B：测试断言方式

**现状**：需核查现有 strategy-switcher 测试是否已断言 SWITCH + nextStrategy（若已存在则只需补来源断言）。

**选项**：

- **B1 直接断言三要素（推荐 ⭐）**：
  - `assert(result.shouldSwitch === true)`
  - `assert(result.decision === 'SWITCH')`
  - `assert(result.recommendedOption === 'replace_skill')`
  - `assert(result.reasons.some(r => r.includes('[ACTION]')))`
  - `assert(result.nextStrategy === 'replace_skill')`
  - 构造仅含 ACTION 重复的 attempts，禁止其他低增益条件出现
- **B2 只断言 shouldSwitch**：
  - 风险：低增益条件顺带通过，无法捕获 P2 回归
- **B3 断言全部 reasons 数组**：
  - 太脆弱，reasons 顺序变化会误报

**推荐**：**B1 直接断言三要素**。构造最小 reproducer，确保只有目标条件触发。

### 决策 C：verify-bridge-daemon 修复方案

**现状**：`shell:true` + `sleep 1s` + 共享进程风险 + 无 finally。

**选项**：

- **C1 彻底重写（推荐 ⭐）**：
  - `spawn(process.execPath, ['--import', 'tsx', 'scripts/bridge-daemon.ts'], { shell: false })`
  - daemon 输出确定性 ready 标记（如 `BRIDGE_DAEMON_READY pid=<pid> dir=<dir>`）
  - 测试 `waitForReady(stdout, timeoutMs)`，不固定 sleep
  - 每个场景独立进程，关闭后等待 `exit` 事件（带 timeout）
  - 失败时打印 stdout/stderr
  - `finally` 块 `rmSync(bridgeDir, { recursive: true, force: true })`
  - daemon 接受 `AWKN_BRIDGE_READY_MARKER` 环境变量定制标记
- **C2 增加 timeout 到 10s**：
  - 治标不治本，仍可能 flaky
- **C3 跳过测试**：
  - 覆盖丢失，不可接受

**推荐**：**C1 彻底重写**。这是计划明确要求，且能根除 flaky。

### 决策 D：bridge 测试 20 次 + CI 矩阵

**现状**：`verify-bridge-daemon` 在批量跑时间歇性失败。

**选项**：

- **D1 本地 20 次 + Windows/Linux CI 各 1 次（推荐 ⭐）**：
  - 本地：`for i in 1..20; node --import tsx test/verify-bridge-daemon.ts`，全部通过
  - CI：`runtime-ci.yml` 在 Ubuntu Node 20/22 + Windows Node 20 各跑一次 verify-bridge-daemon
  - 20 次本地验证证明稳定性，CI 证明跨平台
- **D2 只本地 20 次**：
  - 缺跨平台证据
- **D3 只 CI 1 次**：
  - 样本不足

**推荐**：**D1**。计划明确要求。

### 决策 E：PR 1 合并门槛执行方式

**选项**：

- **E1 严格三门槛（推荐 ⭐）**：
  1. 两个 P2 有针对性回归测试（决策 B 的三要素断言 + 决策 C 的 ready 标记断言）
  2. `npm run check` 退出码 0（typecheck + unit + contracts + verify + architecture）
  3. PR 无未处理 P1/P2 Finding（自审 + 交叉审查）
- **E2 只验证 npm run check**：
  - 风险：测试通过但断言不针对性
- **E3 增加人工 code review**：
  - 计划未要求人工 review，PR 1 是稳定性修复，自审 + 测试足够

**推荐**：**E1 严格三门槛**。

---

## 四、PR 2 决策：Review Kernel + 引擎内 OCR

**分支**：`codex/review-kernel-v1`（从 PR 1 合并后的主线创建）

### 决策 F：选择性移植基线与文件清单

**现状**：`7cfa9c1` 是最终修复状态，`36e220f` 是初始实现。

**选项**：

- **F1 以 `7cfa9c1` 文件状态为基线，挑选 Review 专属文件（推荐 ⭐）**：
  - 移植文件清单（从 `7cfa9c1` 取最终内容）：
    - `docs/review-kernel/ADR-001-review-kernel-v1.md`
    - `docs/review-kernel/ocr-thin-fork-protocol.md`
    - `docs/review-kernel/rollout-and-baseline.md`
    - `integrations/open-code-review/{NOTICE,README,UPSTREAM.lock.json}`
    - `runtime/src/contracts/review.ts`（从 `36e220f` 取，`7cfa9c1` 未改）
    - `runtime/src/review/`（从 `36e220f` 取，`7cfa9c1` 只改了 adapter）
    - `runtime/src/review/adapters/outbound/ocr-cli-spec-provider.ts`（从 `7cfa9c1` 取最终版）
    - `runtime/src/tools/builtin/review-repository-tool.ts`（从 `7cfa9c1` 取最终版，但 PR 3 才注册）
    - `runtime/test/review-adapters.test.ts`、`runtime/test/review-kernel-runner.test.ts`（从 `7cfa9c1` 取）
  - 跳过文件：
    - `capabilities/`（已决定删除）
    - `36e220f` 中的 TS 修复（已在主线）
    - `36e220f` 中的 verify-bridge-daemon `waitForDaemonReady`（PR 1 用更彻底方案）
    - `36e220f` 中的 db.ts AWKN_DB_PATH 修复（已在主线）
  - 移植后基于主线当前状态调整 import 路径、类型契约
- **F2 整体 cherry-pick `36e220f` 再 revert 不需要部分**：
  - 风险：`36e220f` 是混合 commit，revert 困难，污染主线
- **F3 从 `7cfa9c1` 整体 cherry-pick**：
  - `7cfa9c1` 依赖 `36e220f` 的初始实现，单独 cherry-pick 会缺基础文件

**推荐**：**F1 选择性移植**。计划明确要求"不整体 cherry-pick `36e220f`"。

### 决策 G：Review contracts 版本化契约

**选项**：

- **G1 全部新增 schema ID（推荐 ⭐）**：
  - `ReviewTarget`、`ReviewPlan`、`ReviewUnit`、`ReviewFinding`、`ReviewCoverage`、`ReviewVerdict`、`ReviewReceipt` 各自 schema ID
  - `awkn-review-target/v1`、`awkn-review-plan/v1`、`awkn-review-finding/v1`、`awkn-review-coverage/v1`、`awkn-review-verdict/v1`、`awkn-review-receipt/v1`
  - `ocr-delegate-spec/v1`
  - 放入 `runtime/src/contracts/review.ts`，与现有 contracts 风格一致
  - 每个 schema 有 `canonicalJSON` hash 投影
- **G2 复用现有 receipts.ts**：
  - 风险：receipt 类型耦合，违反单一职责
- **G3 不版本化**：
  - 风险：未来升级无兼容性边界

**推荐**：**G1 全部新增 schema ID**。计划明确要求严格版本化契约。

### 决策 H：migration v14 `evidence_records` 表设计

**现状**：主线最高 v13，下一个 v14。

**选项**：

- **H1 新建 v14 创建 `evidence_records` 表（推荐 ⭐）**：
  - 在 `agent-os-migration-registry.ts` 新增 version 14
  - 表结构：
    ```sql
    CREATE TABLE IF NOT EXISTS evidence_records (
      id TEXT PRIMARY KEY,              -- REVIEW-<uuid>
      review_receipt_id TEXT NOT NULL,  -- 关联 ReviewReceipt
      evidence_type TEXT NOT NULL,      -- 'review' | 'shadow_diff' | 'security'
      payload_json TEXT NOT NULL,       -- CanonicalJSON
      sha256 TEXT NOT NULL,             -- payload hash
      created_at TEXT NOT NULL,
      FOREIGN KEY (review_receipt_id) REFERENCES review_receipts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_records_receipt ON evidence_records(review_receipt_id);
    ```
  - 与 Review Receipt、`review.completed` Event 在同一 SQLite 事务持久化
  - 支持幂等重放（`INSERT OR IGNORE` on id）
- **H2 复用现有 events 表**：
  - 风险：事件表不便于 evidence 查询，违反 CQRS
- **H3 复用 v13 编号**：
  - 计划明确禁止

**推荐**：**H1 新建 v14**。计划明确要求。

### 决策 I：OCR Go 构建方案

**现状**：OpenCodeReview `0804075` 用 go 1.25.5，依赖 LLM/UI/telemetry。

**选项**：

- **I1 仓内 vendor + -mod=vendor + -trimpath -buildvcs=false（推荐 ⭐）**：
  - `integrations/open-code-review/go.mod` 固定 `go 1.25.5`
  - `integrations/open-code-review/vendor/` 包含所需第三方代码
  - CI `go-version-file: integrations/open-code-review/go.mod`
  - 构建命令：`go build -mod=vendor -trimpath -buildvcs=false -o bin/ocr ./cmd/ocr`
  - 生成 Windows/Linux 二进制 + 平台级 SHA-256 manifest
  - 二进制只作为 CI/发布产物生成到 `integrations/open-code-review/bin/`，不入库
  - `.gitignore` 加 `integrations/open-code-review/bin/`
- **I2 Go modules proxy 下载**：
  - 风险：CI 无网络时失败，依赖外部仓库可用性
  - 计划明确要求"不依赖外部 checkout"
- **I3 不 vendor，运行时 go install**：
  - 风险：版本漂移，不可复现

**推荐**：**I1 仓内 vendor**。计划明确要求。

### 决策 J：OCR 代码移植范围

**现状**：OCR 包含 LLM、Session、UI、遥测、密钥配置。

**选项**：

- **J1 只移植 Diff 选择、规则匹配、分组、指纹计算（推荐 ⭐）**：
  - 移植：`internal/diff/`、`internal/rule/`、`internal/group/`、`internal/fingerprint/`、`cmd/ocr/`
  - 删除：`internal/llm/`、`internal/session/`、`internal/ui/`、`internal/telemetry/`、`internal/secret/`
  - 实现：`ocr delegate spec --format json --repo <path> --from <ref> --to <ref>`
  - 输出：`{ diffFingerprint, ruleBundleHash, planHash, findings, coverage }`
  - 规则只读取：仓库内 `.opencodereview/rule.json` + 仓内固定 system rules
  - 禁止读取 `~/.opencodereview`（环境隔离）
- **J2 完整移植再禁用不需要模块**：
  - 风险：代码膨胀，攻击面大
- **J3 重写不移植**：
  - 风险：丢失 OCR 已验证的规则匹配逻辑

**推荐**：**J1 选择性移植**。计划明确要求。

### 决策 K：OCR 规则文件位置与 first-match 行为

**选项**：

- **K1 仓库内 `.opencodereview/rule.json` + 仓内 system rules（推荐 ⭐）**：
  - project rules：`<repo>/.opencodereview/rule.json`
  - system rules：`integrations/open-code-review/rules/system.json`（仓内固定）
  - first-match 行为：project 优先，system 兜底
  - 禁止读取 `~/.opencodereview`（避免环境导致 planHash 漂移）
  - 规则格式沿用 OCR 的 project/system 分层
- **K2 只用 system rules**：
  - 风险：无法 per-repo 定制
- **K3 允许 `~/.opencodereview`**：
  - 风险：环境漂移，planHash 不确定

**推荐**：**K1 仓库内规则**。计划明确要求。

### 决策 L：OCR Runtime 调用安全

**选项**：

- **L1 execFile(shell:false) + 全套校验（推荐 ⭐）**：
  - `execFile(ocrBinPath, ['delegate', 'spec', '--format', 'json', '--repo', repoRoot, '--from', from, '--to', to], { shell: false })`
  - 校验：真实路径（`realpathSync`）、版本（`ocr --version` 匹配 `UPSTREAM.lock.json`）、摘要（SHA-256 比对 manifest）、超时（60s）、输出大小（10MB）、UTF-8、JSON Schema、仓库根（`git rev-parse --show-toplevel`）
  - 任何校验失败 → `PARTIAL/INVALID`
  - Diff 改变 → `STALE`，不回退文本 PASS
- **L2 spawn(shell:true)**：
  - 风险：命令注入
- **L3 不校验直接执行**：
  - 风险：路径篡改、版本漂移

**推荐**：**L1 全套校验**。计划明确要求。

### 决策 M：测试文件强制进入计划

**选项**：

- **M1 测试文件和删除文件强制进入计划；二进制/生成文件结构化理由排除（推荐 ⭐）**：
  - 强制进入计划的文件：所有 `*.test.ts`、被删除的源文件
  - 可排除文件：`bin/`（二进制，`.gitignore`）、`vendor/`（第三方，但需 `UPSTREAM.lock.json` 锁定）、生成文件（需结构化理由记录在 PR 描述）
  - 架构扫描确认 Runtime 不执行引擎目录外 OCR 文件
- **M2 所有文件强制进入**：
  - 二进制入库不可接受
- **M3 自由排除**：
  - 风险：覆盖丢失

**推荐**：**M1**。计划明确要求。

### 决策 N：OCR Go 测试覆盖

**选项**：

- **N1 全覆盖（推荐 ⭐）**：
  - 空 Diff、rename、delete、binary、中文/空格路径、规则优先级、Hash 确定性、密钥隔离
  - 同一输入连续执行产生一致的 Diff fingerprint、ruleBundleHash、planHash
  - Go unit + contract + race + 确定性 + 无密钥测试
- **N2 只核心路径**：
  - 风险：边界场景未覆盖
- **N3 不写 Go 测试**：
  - 风险：OCR 行为不可证

**推荐**：**N1 全覆盖**。计划明确要求。

### 决策 O：PR 2 合并门槛执行方式

**选项**：

- **O1 全部门槛（推荐 ⭐）**：
  1. Review contracts、planner、validator、coverage、verdict、receipt、SQLite、Native Git、OCR Adapter 测试全部通过
  2. OCR Go 测试覆盖空 Diff、rename、delete、binary、中文/空格路径、规则优先级、Hash 确定性、密钥隔离
  3. 同一输入连续执行产生一致的 Diff fingerprint、ruleBundleHash、planHash
  4. 架构扫描确认 Runtime 不执行引擎目录外 OCR 文件
  5. `npm run check` 退出码 0
  6. Go 测试退出码 0
- **O2 只 npm run check**：
  - 风险：Go 侧未验证
- **O3 减少门槛**：
  - 不可接受

**推荐**：**O1 全部门槛**。计划明确要求。

---

## 五、PR 3 决策：统一入口、Capability 与 Shadow

**分支**：`codex/review-rollout`（从 PR 2 合并后的主线创建）

### 决策 P：`review_repository` builtin tool 注册

**现状**：`tools/builtin/index.ts` 未注册。

**选项**：

- **P1 注册为 builtin tool（推荐 ⭐）**：
  - 在 `tools/builtin/review-repository-tool.ts`（PR 2 已移植）实现
  - 在 `tools/builtin/index.ts` 注册到 `builtinTools` 数组
  - 权限级别：`confirm`（涉及冻结目标）
  - 调用 Review Service `prepare/plan/execute/evaluate`
- **P2 注册为外部 connector**：
  - 风险：跨进程调用复杂，违反"统一入口"
- **P3 不注册，直接调用 Review Service**：
  - 风险：Agent 无法触发审核

**推荐**：**P1 注册为 builtin tool**。计划明确要求。

### 决策 Q：`implementerActorId` 来源

**现状**：需从 Runtime 可信执行上下文获取。

**选项**：

- **Q1 从 Runtime 可信执行上下文获取，fail-closed（推荐 ⭐）**：
  - `ExecutionEnvelope` 携带 `actorContext`（已签名）
  - `implementerActorId = envelope.actorContext.actorId`
  - 上下文缺失 → 抛 `MissingActorContextError`，fail-closed
  - 不信任调用参数中的 `implementerActorId`
- **Q2 从调用参数获取**：
  - 风险：可伪造，自改自审
- **Q3 从环境变量获取**：
  - 风险：跨进程继承不可控

**推荐**：**Q1 Runtime 可信上下文**。计划明确要求。

### 决策 R：Reviewer 选择与隔离

**选项**：

- **R1 Broker 选择 + Actor 隔离 + Critical/High 第二 Reviewer（推荐 ⭐）**：
  - Reviewer 由 Broker 选择（基于能力匹配）
  - `reviewerActorId !== implementerActorId`（强制隔离）
  - Critical/High Finding 需第二 Reviewer 或确定性工具证据
  - 第二 Reviewer 也由 Broker 选择，与第一 Reviewer 隔离
- **R2 单 Reviewer**：
  - 风险：单点失误，Critical 漏报
- **R3 调用方指定 Reviewer**：
  - 风险：自改自审

**推荐**：**R1 Broker 选择 + 隔离 + 第二 Reviewer**。计划明确要求。

### 决策 S：三入口统一调用 Review Service

**现状**：`@审核`、AgentLoop 独立审核、天阶 `review` 三入口。

**选项**：

- **S1 三入口统一调用同一 Review Service（推荐 ⭐）**：
  - `@审核`：通过 `review_repository` builtin tool 调用
  - AgentLoop 独立审核：在 `agent-loop.ts` runL2 完成后调用 Review Service
  - 天阶 `review`：通过天阶 reference 调用 Review Service
  - 三入口对相同冻结目标必须产生相同 target fingerprint 和 planHash
  - 冻结目标 = Git ref + 文件清单 + 内容 hash
- **S2 三入口各自实现**：
  - 风险：行为不一致，planHash 漂移
- **S3 只保留一个入口**：
  - 风险：破坏现有工作流

**推荐**：**S1 统一调用 Review Service**。计划明确要求。

### 决策 T：GateContext 改造

**现状**：`gates/review-verdict.ts` 用文本 Verdict。

**选项**：

- **T1 改为 reviewReceipt + securityEvidence（推荐 ⭐）**：
  - `GateContext.reviewReceipt`：只接受合法 `awkn-review-receipt/v1`
  - `GateContext.securityEvidence`：独立安全证据
  - 仅 `ReviewVerdict=PASS` 映射 Gate PASS
  - `FAIL/PARTIAL/STALE/INVALID` 全部映射 FAIL
  - `parseReviewVerdict()` 保留一个兼容周期，但移出权威门禁路径，打印 `deprecated` 诊断
  - 兼容周期结束后删除（Shadow 稳定一个发布周期后）
- **T2 立即删除 parseReviewVerdict**：
  - 风险：破坏现有依赖
- **T3 保留 parseReviewVerdict 在权威路径**：
  - 风险：文本可伪造，安全门禁失效

**推荐**：**T1 改为 reviewReceipt + securityEvidence**。计划明确要求。

### 决策 U：Capability manifest 接入

**选项**：

- **U1 合入并校验 Capability manifest、audit/engineer/cicd/bugfix cards 和天阶 review reference（推荐 ⭐）**：
  - `capabilities/project/manifest.yaml`（注意：2026-07-28 授权书决定删除旧 fixture，这里指新的 Capability manifest）
  - `capabilities/project/cards/{audit,engineer,cicd,bugfix}.md`
  - 天阶 `review` reference
  - 内容 Hash 必须可复算（CanonicalJSON hash）
  - 与 SkillDeck 桥接一致（记忆显示 v6.2 已桥接 SkillDeck）
- **U2 只接入 manifest**：
  - 风险：cards 缺失，能力声明不完整
- **U3 不接入**：
  - 风险：Capability 系统空转

**推荐**：**U1 全部接入**。计划明确要求。

### 决策 V：`AWKN_REVIEW_OCR_V1` 默认值与白名单

**选项**：

- **V1 默认 `0` + 白名单显式启用 shadow（推荐 ⭐）**：
  - `AWKN_REVIEW_OCR_V1=0`（默认关闭）
  - 白名单目录：`runtime/src/`、`agents/tianhuo/`、核心技能目录
  - 白名单目录显式 `AWKN_REVIEW_OCR_V1=shadow`
  - Shadow 同时保存 `REVIEW` 和 `SHADOW_DIFF` Receipt
  - Shadow 不改变旧 Gate 结果（旁路记录）
  - 达标后切换 `enforce`
- **V2 默认 `shadow`**：
  - 风险：未验证目录直接进入 shadow，可能误报
- **V3 默认 `enforce`**：
  - 风险：未验证直接阻断，破坏现有流程

**推荐**：**V1 默认 `0` + 白名单 shadow**。计划明确要求。

---

## 六、测试与验收决策

### 决策 W：36 baseline 转 Git fixture

**现状**：36 个 baseline 条目是描述清单（`DESIGNED`）。

**选项**：

- **W1 转为真实 Git fixture（推荐 ⭐）**：
  - 位置：`runtime/test/fixtures/review-baseline/`
  - 每例包含：`base/head`（Git ref）、实际文件 Diff、人工标注 Finding、期望 Verdict
  - 至少两名独立标注者确认 Critical/High
  - 覆盖：单文件、跨文件、Spec、测试作弊、权限、rename/delete/binary、路径编码、超大 Diff、模型失败、自改自审、Diff 过期
- **W2 保持描述清单**：
  - 风险：不可回放，验收无意义
- **W3 只转换部分**：
  - 风险：覆盖不足

**推荐**：**W1 转为真实 Git fixture**。计划明确要求"36 个历史样本可实际回放"。

### 决策 X：双标注者机制

**选项**：

- **X1 两名独立标注者 + Critical/High 强制确认（推荐 ⭐）**：
  - 标注者 A、B 独立标注
  - Critical/High Finding 必须双标注一致
  - 分歧时引入第三标注者 C 仲裁
  - 标注记录入 `fixture/<case>/annotations/{A,B}.json`
- **X2 单标注者**：
  - 风险：主观偏差
- **X3 三标注者全部一致**：
  - 风险：成本高，效率低

**推荐**：**X1 两名 + 仲裁**。计划明确要求"至少两名独立标注者"。

### 决策 Y：CI 矩阵

**选项**：

- **Y1 Ubuntu Node 20/22 + Windows Node 20 + OCR 仓内现场构建（推荐 ⭐）**：
  - Ubuntu Node 20：`runtime-ci.yml` 现有
  - Ubuntu Node 22：新增
  - Windows Node 20：新增（验证跨平台 Hash 一致性）
  - OCR：`go build -mod=vendor` 现场构建，不下载预编译二进制
  - 全量门禁：Node unit/contracts/verify/typecheck/architecture + Go unit/contract/race/确定性/无密钥 + 集成（三入口一致性、SQLite 重放、Receipt Hash、Gate fail-closed）
- **Y2 只 Ubuntu Node 20**：
  - 风险：跨平台未验证
- **Y3 减少门槛**：
  - 不可接受

**推荐**：**Y1 全 CI 矩阵**。计划明确要求。

### 决策 Z：Git 工作区与本地 main 同步

**选项**：

- **Z1 工作区干净 + 本地 main 与 tianshu/main 同 SHA（推荐 ⭐）**：
  - 每个 PR 合并前验证：`git status --short` 无输出
  - `git rev-parse main` === `git rev-parse tianshu/main`
  - 不提交运行数据库（`*.db`、`*.db-shm`、`*.db-wal`）
  - 不提交架构扫描产物（`architecture-scan.json`）
  - 不提交临时 Goal 脚本
  - 不提交未验证 Experience 草稿
- **Z2 允许未跟踪文件**：
  - 风险：fresh clone 不可复现
- **Z3 强制提交所有**：
  - 风险：污染仓库

**推荐**：**Z1 工作区干净 + 同步**。计划明确要求。

---

## 七、Shadow、Enforce 与完成定义

### 决策 AA：Shadow 周期与达标指标

**选项**：

- **AA1 两个完整 shadow 周期 + 全部门槛达标才 enforce（推荐 ⭐）**：
  - Shadow 范围：Runtime 和核心技能目录
  - 周期：两个完整 shadow 周期（定义：覆盖一次完整开发闭环）
  - 达标指标：
    1. 文件与 ReviewUnit 覆盖率 100%
    2. Critical/High 召回率 100%
    3. Finding 精确率 ≥ 85%
    4. Critical/High 位置有效率 ≥ 99%
    5. 不存在结构化审核 PASS、人工基准却发现阻断项的样本
  - 任一指标未达标 → 保持 shadow，状态记录为 `PARTIAL`
  - 达标后切换白名单至 `enforce`，再逐步扩到全仓库
  - 稳定一个发布周期后删除文本 Verdict 权威路径
- **AA2 一个周期**：
  - 风险：样本不足，误判风险高
- **AA3 不设指标直接 enforce**：
  - 风险：误报阻断生产

**推荐**：**AA1 两个周期 + 全部门槛**。计划明确要求。

### 决策 BB：完成定义

**选项**：

- **BB1 工程闭环 + 生产闭环双达标（推荐 ⭐）**：
  - 工程闭环：
    1. 三个 PR 均进入远端主线
    2. 当前全量测试退出码 0
    3. 没有未处理 P1/P2
    4. 实际 PR Diff 生成合法 Review Receipt，并由独立 Reviewer 签发
  - 生产闭环：
    1. Shadow 两个周期达标（决策 AA1）
    2. enforce 切换
    3. 稳定一个发布周期后删除文本 Verdict
  - 任一未达标 → 状态 `PARTIAL`，不得宣称闭环
- **BB2 只工程闭环**：
  - 风险：生产未验证
- **BB3 声称完成但留 PARTIAL**：
  - 计划明确禁止

**推荐**：**BB1 双达标**。计划明确要求。

---

## 八、回滚与默认约束

### 决策 CC：回滚策略

**选项**：

- **CC1 每个 PR 独立 merge commit + 故障切换开关 → PR3 → PR2（推荐 ⭐）**：
  - 每个 PR 使用独立 merge commit（非 squash），可分别 `git revert`
  - Review 故障优先 `AWKN_REVIEW_OCR_V1=0` 切回关闭
  - 切回 0 无效 → revert PR 3
  - revert PR 3 无效 → revert PR 2
  - 保留旧 Review 分支（`codex/review-kernel-mainline`）和 WIP salvage 分支（`codex/wip-phase6-salvage`）至 enforce 稳定一个发布周期
  - 不执行 `git reset --hard`，不覆盖用户工作区
- **CC2 squash merge**：
  - 风险：无法精确 revert
- **CC3 强制 reset**：
  - 风险：丢失工作

**推荐**：**CC1 独立 merge + 故障切换**。计划明确要求。

### 决策 DD：外部目录隔离

**选项**：

- **DD1 严格隔离（推荐 ⭐）**：
  - 不在 `D:\awkn-lab\TRAE练习` 或其他外部目录创建、修改、构建或运行 OCR 文件
  - 所有 OCR 操作限制在 `d:\awkn-lab\awkn引擎\integrations\open-code-review\`
  - OCR 二进制只在 `integrations/open-code-review/bin/` 生成
  - Runtime 调用 OCR 时 `cwd` 锁定到 `integrations/open-code-review/`
- **DD2 允许外部目录**：
  - 风险：路径混乱，难以追溯
- **DD3 临时目录**：
  - 风险：清理遗漏

**推荐**：**DD1 严格隔离**。计划明确要求。

---

## 九、需要用户授权的安全操作清单

以下操作涉及天枢安全门禁（`tianshu-dispatch.md` 第五节），需用户逐一确认：

### 安全授权 1：分支创建

- **操作**：`git checkout -b codex/mainline-stability-fixes`（从 main@3ea2534）
- **风险**：低，仅创建分支
- **推荐**：✅ 授权

### 安全授权 2：文件修改（PR 1）

- **操作**：修改 `runtime/src/contracts/evidence-loop.ts`、`runtime/src/loop/strategy-switcher.ts`、`runtime/test/verify-bridge-daemon.ts`、相关测试文件
- **风险**：中，修改核心 loop 逻辑
- **推荐**：✅ 授权（有针对性回归测试）

### 安全授权 3：文件新增（PR 2）

- **操作**：新增 `runtime/src/review/`、`runtime/src/contracts/review.ts`、`integrations/open-code-review/`、`docs/review-kernel/`、migration v14
- **风险**：中，新增模块
- **推荐**：✅ 授权（选择性移植已验证代码）

### 安全授权 4：vendor 目录与依赖

- **操作**：新增 `integrations/open-code-review/vendor/`（第三方 Go 依赖）
- **风险**：中，引入第三方代码
- **推荐**：✅ 授权（锁定 `0804075`，`UPSTREAM.lock.json` 固定，`-mod=vendor` 构建）

### 安全授权 5：Go 工具链

- **操作**：CI 安装 Go 1.25.5（`go-version-file`）
- **风险**：低，CI 环境隔离
- **推荐**：✅ 授权

### 安全授权 6：数据库 migration

- **操作**：执行 migration v14 创建 `evidence_records` 表
- **风险**：中，修改数据库 schema
- **推荐**：✅ 授权（有 backup/restore 闭环，幂等重放）

### 安全授权 7：删除文件

- **操作**：删除 `capabilities/` 目录（若主线仍存在）
- **风险**：低，已确认无 runtime 引用
- **推荐**：✅ 授权（2026-07-28 授权书已决定）

### 安全授权 8：CI 配置修改

- **操作**：修改 `.github/workflows/runtime-ci.yml`（新增 Ubuntu Node 22、Windows Node 20、OCR 现场构建）
- **风险**：中，影响 CI 行为
- **推荐**：✅ 授权

### 安全授权 9：`.gitignore` 修改

- **操作**：新增 `integrations/open-code-review/bin/`
- **风险**：低
- **推荐**：✅ 授权

### 安全授权 10：Git push 与 PR

- **操作**：push 三个分支到 `tianshu`，创建三个 PR
- **风险**：中，进入远端
- **推荐**：✅ 授权（用户规则：部署前必须先 push GIT）

### 安全授权 11：不执行的操作（明示）

- ❌ 不执行 `git reset --hard`
- ❌ 不覆盖用户工作区
- ❌ 不在 `D:\awkn-lab\TRAE练习` 或其他外部目录创建、修改、构建或运行 OCR 文件
- ❌ 不提交运行数据库（`*.db`、`*.db-shm`、`*.db-wal`）
- ❌ 不提交架构扫描产物（`architecture-scan.json`）
- ❌ 不提交临时 Goal 脚本
- ❌ 不提交未验证 Experience 草稿
- ❌ 不修改 `.env`、密钥、凭据、证书、`.git/`
- ❌ 不执行递归删除、强制推送、破坏性 SQL
- ❌ 不绕过天枢工具授权策略

---

## 十、推荐执行顺序

```
阶段 0：授权确认（本步）
  └─ 用户确认本授权确认书所有决策

阶段 1：PR 1 主线稳定性修复
  ├─ 创建分支 codex/mainline-stability-fixes
  ├─ 修复 P2-1（重复模式诊断 ACTION|ERROR 来源）
  ├─ 修复 P2-2（verify-bridge-daemon 彻底重写）
  ├─ 本地 bridge 测试 20 次
  ├─ npm run check 退出码 0
  ├─ push + 创建 PR
  └─ CI 通过（Ubuntu Node 20/22 + Windows Node 20）

阶段 2：PR 2 Review Kernel + 引擎内 OCR
  ├─ 从 PR 1 合并后的主线创建 codex/review-kernel-v1
  ├─ 选择性移植 Review 专属代码（决策 F1）
  ├─ 新增 Review contracts（决策 G1）
  ├─ migration v14（决策 H1）
  ├─ OCR Go 构建（决策 I1 + J1 + K1）
  ├─ OCR Runtime 调用安全（决策 L1）
  ├─ Go 测试全覆盖（决策 N1）
  ├─ npm run check + Go 测试退出码 0
  ├─ 架构扫描确认隔离
  ├─ push + 创建 PR
  └─ CI 全平台通过

阶段 3：PR 3 统一入口、Capability 与 Shadow
  ├─ 从 PR 2 合并后的主线创建 codex/review-rollout
  ├─ 注册 review_repository builtin tool（决策 P1）
  ├─ implementerActorId 可信上下文（决策 Q1）
  ├─ Reviewer 选择与隔离（决策 R1）
  ├─ 三入口统一调用 Review Service（决策 S1）
  ├─ GateContext 改造（决策 T1）
  ├─ Capability manifest 接入（决策 U1）
  ├─ AWKN_REVIEW_OCR_V1=0 + 白名单 shadow（决策 V1）
  ├─ 36 baseline 转 Git fixture（决策 W1 + X1）
  ├─ npm run check + 集成测试退出码 0
  ├─ push + 创建 PR
  └─ CI 全平台通过

阶段 4：Shadow 与 Enforce
  ├─ 两个完整 shadow 周期（决策 AA1）
  ├─ 达标指标验证
  ├─ 切换 enforce
  └─ 稳定一个发布周期后删除文本 Verdict 权威路径

阶段 5：完成定义验证（决策 BB1）
```

---

## 十一、待确认清单

请用户对以下 28 项决策逐一确认（或一次性确认全部推荐）：

### PR 1 决策（5 项）

| 决策 | 推荐答案 | 用户确认 |
|---|---|---|
| A. 重复模式诊断 ACTION\|ERROR 来源标记方式 | A1 字符串后缀标记 | ☐ 同意 ☐ 修正： |
| B. 测试断言方式 | B1 直接断言三要素 | ☐ 同意 ☐ 修正： |
| C. verify-bridge-daemon 修复方案 | C1 彻底重写（process.execPath --import tsx, shell:false, ready 标记, 独立进程, finally 清理） | ☐ 同意 ☐ 修正： |
| D. bridge 测试 20 次 + CI 矩阵 | D1 本地 20 次 + Windows/Linux CI 各 1 次 | ☐ 同意 ☐ 修正： |
| E. PR 1 合并门槛 | E1 严格三门槛 | ☐ 同意 ☐ 修正： |

### PR 2 决策（10 项）

| 决策 | 推荐答案 | 用户确认 |
|---|---|---|
| F. 选择性移植基线与文件清单 | F1 以 7cfa9c1 文件状态为基线挑选 Review 专属文件 | ☐ 同意 ☐ 修正： |
| G. Review contracts 版本化契约 | G1 全部新增 schema ID | ☐ 同意 ☐ 修正： |
| H. migration v14 evidence_records 表 | H1 新建 v14 | ☐ 同意 ☐ 修正： |
| I. OCR Go 构建方案 | I1 仓内 vendor + -mod=vendor + -trimpath -buildvcs=false | ☐ 同意 ☐ 修正： |
| J. OCR 代码移植范围 | J1 只移植 Diff/规则/分组/指纹 | ☐ 同意 ☐ 修正： |
| K. OCR 规则文件位置 | K1 仓库内 .opencodereview/rule.json + 仓内 system rules | ☐ 同意 ☐ 修正： |
| L. OCR Runtime 调用安全 | L1 execFile(shell:false) + 全套校验 | ☐ 同意 ☐ 修正： |
| M. 测试文件强制进入计划 | M1 测试/删除文件强制；二进制/生成文件结构化理由排除 | ☐ 同意 ☐ 修正： |
| N. OCR Go 测试覆盖 | N1 全覆盖 | ☐ 同意 ☐ 修正： |
| O. PR 2 合并门槛 | O1 全部门槛 | ☐ 同意 ☐ 修正： |

### PR 3 决策（6 项）

| 决策 | 推荐答案 | 用户确认 |
|---|---|---|
| P. review_repository builtin tool 注册 | P1 注册为 builtin tool | ☐ 同意 ☐ 修正： |
| Q. implementerActorId 来源 | Q1 Runtime 可信上下文 + fail-closed | ☐ 同意 ☐ 修正： |
| R. Reviewer 选择与隔离 | R1 Broker 选择 + Actor 隔离 + Critical/High 第二 Reviewer | ☐ 同意 ☐ 修正： |
| S. 三入口统一调用 Review Service | S1 统一调用，相同冻结目标产生相同 fingerprint/planHash | ☐ 同意 ☐ 修正： |
| T. GateContext 改造 | T1 reviewReceipt + securityEvidence，parseReviewVerdict 保留兼容周期并 deprecated | ☐ 同意 ☐ 修正： |
| U. Capability manifest 接入 | U1 全部接入，内容 Hash 可复算 | ☐ 同意 ☐ 修正： |
| V. AWKN_REVIEW_OCR_V1 默认值与白名单 | V1 默认 0 + 白名单 shadow | ☐ 同意 ☐ 修正： |

### 测试与验收决策（4 项）

| 决策 | 推荐答案 | 用户确认 |
|---|---|---|
| W. 36 baseline 转 Git fixture | W1 转为真实 Git fixture | ☐ 同意 ☐ 修正： |
| X. 双标注者机制 | X1 两名独立标注者 + Critical/High 强制确认 + 第三仲裁 | ☐ 同意 ☐ 修正： |
| Y. CI 矩阵 | Y1 Ubuntu Node 20/22 + Windows Node 20 + OCR 现场构建 | ☐ 同意 ☐ 修正： |
| Z. Git 工作区与本地 main 同步 | Z1 工作区干净 + 同步 | ☐ 同意 ☐ 修正： |

### Shadow/Enforce/完成定义（2 项）

| 决策 | 推荐答案 | 用户确认 |
|---|---|---|
| AA. Shadow 周期与达标指标 | AA1 两个完整周期 + 全部门槛达标才 enforce | ☐ 同意 ☐ 修正： |
| BB. 完成定义 | BB1 工程闭环 + 生产闭环双达标 | ☐ 同意 ☐ 修正： |

### 回滚与约束（2 项）

| 决策 | 推荐答案 | 用户确认 |
|---|---|---|
| CC. 回滚策略 | CC1 独立 merge + 故障切换开关 → PR3 → PR2 | ☐ 同意 ☐ 修正： |
| DD. 外部目录隔离 | DD1 严格隔离 | ☐ 同意 ☐ 修正： |

### 安全授权（11 项）

| 安全授权 | 推荐 | 用户确认 |
|---|---|---|
| 1. 分支创建 | ✅ 授权 | ☐ 同意 ☐ 拒绝 |
| 2. 文件修改（PR 1） | ✅ 授权 | ☐ 同意 ☐ 拒绝 |
| 3. 文件新增（PR 2） | ✅ 授权 | ☐ 同意 ☐ 拒绝 |
| 4. vendor 目录与依赖 | ✅ 授权 | ☐ 同意 ☐ 拒绝 |
| 5. Go 工具链（CI） | ✅ 授权 | ☐ 同意 ☐ 拒绝 |
| 6. 数据库 migration v14 | ✅ 授权 | ☐ 同意 ☐ 拒绝 |
| 7. 删除 capabilities/ 目录 | ✅ 授权 | ☐ 同意 ☐ 拒绝 |
| 8. CI 配置修改 | ✅ 授权 | ☐ 同意 ☐ 拒绝 |
| 9. .gitignore 修改 | ✅ 授权 | ☐ 同意 ☐ 拒绝 |
| 10. Git push 与 PR | ✅ 授权 | ☐ 同意 ☐ 拒绝 |
| 11. 不执行的操作（明示） | ✅ 确认 | ☐ 同意 ☐ 拒绝 |

---

## 十二、关键风险与缓解

### 12.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| `7cfa9c1` 移植后与主线当前 contracts 不兼容 | 中 | 中 | 移植后逐文件调整 import 路径与类型契约，运行 contracts 测试 |
| OCR Go 二进制跨平台 Hash 不一致 | 中 | 高 | `-trimpath -buildvcs=false` + vendor 锁定 + CI 双平台验证 |
| Review Receipt 与 Evidence 事务失败 | 低 | 高 | 同一 SQLite 事务 + 幂等重放 + backup/restore 闭环 |
| Shadow 指标未达标 | 高 | 中 | 保持 shadow，状态 PARTIAL，不强行 enforce |
| verify-bridge-daemon 修复后仍 flaky | 低 | 中 | 本地 20 次 + CI 双平台验证，不通过不合并 |
| 三入口 planHash 不一致 | 中 | 高 | 冻结目标 = Git ref + 文件清单 + 内容 hash，三入口共享冻结逻辑 |
| OCR 规则读取 `~/.opencodereview` 导致 planHash 漂移 | 中 | 高 | 代码层禁止读取用户级目录，测试验证隔离 |
| `implementerActorId` 伪造 | 中 | 高 | 从 Runtime 可信执行上下文获取，不信任调用参数 |
| Reviewer 与 Implementer 同 Actor | 中 | 高 | Broker 强制隔离，Critical/High 第二 Reviewer |
| 文本 Verdict 权威路径未及时删除 | 高 | 中 | Shadow 稳定一个发布周期后强制删除 |

### 12.2 阻塞条件

任一条件发生时停止推进：
1. 同一失败连续 3 次重试未解决（天枢规则第七节）
2. OCR Go 测试在双平台连续失败
3. Shadow 指标连续两个周期未达标
4. 架构扫描发现 Runtime 执行引擎目录外 OCR 文件
5. Review Receipt Hash 跨平台不一致

发生阻塞时输出阻塞包：当前目标、已完成内容、失败证据、根因假设、已排除路径、最小阻塞点、下一步建议、可回滚点。

---

## 十三、结论

本授权确认书基于实查事实（非摘要），覆盖 Review Kernel 主线闭环的三个串行 PR、测试验收、Shadow/Enforce、回滚约束和全部安全授权。

**默认推荐组合**：A1 + B1 + C1 + D1 + E1 + F1 + G1 + H1 + I1 + J1 + K1 + L1 + M1 + N1 + O1 + P1 + Q1 + R1 + S1 + T1 + U1 + V1 + W1 + X1 + Y1 + Z1 + AA1 + BB1 + CC1 + DD1 + 全部安全授权。

**最安全路径**：严格按计划三个串行 PR 顺序推进，每个 PR 独立可验收可回滚，Shadow 达标后才 enforce，任何不完整状态均不能 PASS。

确认后立即按推荐执行顺序推进阶段 1（PR 1 主线稳定性修复）。
