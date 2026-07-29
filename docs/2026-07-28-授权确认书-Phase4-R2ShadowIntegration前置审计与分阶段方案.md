# 授权确认书：Phase 4 R2 Shadow Integration 前置审计与分阶段方案

**生成时间**：2026-07-28
**触发**：`/goal @天火 不间断执行[开发与修复完整闭环计划]` Phase 4 接力
**前置审计依据**：E1（跨会话接力实查优先）、E3（授权确认书前置审计）、用户规则 2（深度分析授权形成文档）

---

## 一、前置审计：实际状态实查

### 1.1 Phase 1—3 完成状态实查

| Phase | 摘要描述 | 磁盘实查 | 结论 |
|-------|----------|----------|------|
| Phase 1（门禁统一） | "已完成" | commit `c67fa3e`：删 `lint`/`test:vitest`、加 `test:verify`/`test:coverage`/`check:full`、创建 `run-verify-tests.mjs`、更新 CI | ✅ 真实 |
| Phase 2（PR #64 三项语义修复） | "已完成" | commit `a849d93`（远端）+ `6f2add2`（本地 merge）；三项修复（compareByCodePoint、verifyImmutableRender、assertCrossFieldInvariants）代码已确认 | ✅ 真实 |
| Phase 3（Migration backup/restore） | "已完成，188 tests 0 fail" | commit `705181d`；但实查发现 **EBUSY 回归**（pattern-detector.test.ts 触发时失败），摘要的"0 fail"已过时 | ⚠️ 回归已修复 |
| Phase 3 auth doc | "已提交" | commit `119b17a` | ✅ 真实 |

### 1.2 EBUSY 回归发现与修复（本次接力新发现）

**根因**：`backupBeforeMigration` 第 65 行 `copyFileSync` 后立即第 73 行 `computeFileHash` 读取，Windows 文件句柄未释放导致 EBUSY。

**影响**：`pattern-detector.test.ts` 的 `excludes resolved records from clustering` 测试失败，`npm run check` exit 1。

**修复**：`migration-backup.ts` 新增 `readFileWithTransientLockRetry`，对 EBUSY/EACCES 重试 3 次（50ms/100ms/150ms 递增 backoff），其他 errno 立即抛出（不掩盖真实错误）。

**验证**：`npm run check` 全绿，**200 tests, 0 fail**（含 12 个 migration-backup 测试 + 12 个 context-render 测试 + 4 个新增 ToolPolicy/Registry 安全加固测试）。

### 1.3 未提交修改清单（10 文件 + 2 未跟踪）

**未提交修改分类**：

| 分类 | 文件 | 性质 | 处置推荐 |
|------|------|------|----------|
| EBUSY 修复 | `runtime/src/store/migration-backup.ts` | P0 回归修复 | **立即提交**（单独 commit） |
| ToolPolicy/Registry 安全加固 | `runtime/src/cli.ts`、`agent-loop.ts`、`codex.ts`、`minimax.ts`、`router.ts`、`process-executor.ts`、`policy.ts`、`registry.ts`、`sandbox-registry.test.ts`、`tool-policy.test.ts` | 安全加固（AWKN_APPROVED_TOOLS 预批准路径 + 11 种递归删除变体拦截） | **单独 commit**（安全加固，与 EBUSY 修复分离） |
| 未跟踪 | `runtime/data/`（运行数据） | 已被 .gitignore 覆盖 | 无需处理 |
| 未跟踪 | `runtime/test/contracts/llm-runtime-env.test.ts` | 新增测试（LLM runtime environment） | **提交**（已通过测试） |

### 1.4 PR #64 状态实查

- **状态**：仍 Draft（`merged_at: null`）
- **Reviews**：**0 条**（无任何 review）
- **Comments**：**0 条**
- **Head SHA**：`a849d937b9e177c43aa8b3acd4979a9d1767b3ac`
- **Base**：`main @ b5c9c401`
- **Body 状态**：已更新（三项语义修复标记完成 + 集成验证 200 tests pass）
- **本地 merge**：commit `6f2add2` 已将 PR #64 merge 到 `feat/phase3-migration-backup-restore`
- **远程 main**：`ead634a`（docs: publish baseline），**不含 PR #64**

### 1.5 Issue #66（R2 Shadow）状态实查

- **状态**：open，**0 评论**
- **Labels**：`architecture-review`
- **验收 checklist**：全部未勾选
- **前置依赖**：
  1. PR #64 语义 Review、必要修复与合并 — **未完成**
  2. Context Manifest / Render v13 Persistence 决策 — **状态未知**
  3. Engine v2 保持默认路径 — 满足

### 1.6 WP02—05 Public Ports 代码位置实查

| 组件 | Public Surface | Application 层 | 状态 |
|------|---------------|----------------|------|
| WP02 Trusted Input | `src/input/public.ts` | `src/input/application/input-receipt.ts`、`trusted-json-parser.ts` | Mode 0 已实现 |
| WP03 Intent/Goal | `src/intent/public.ts`、`src/goal/public.ts` | `src/intent/application/intent-router.ts`、`goal-factory.ts`、`loop-eligibility.ts`；`src/goal/application/goal-judge.ts` | Mode 0 已实现 |
| WP04 Claim Ledger | `src/context/public.ts` | `src/context/claim-ledger/application/claim-resolver.ts` | Mode 0 已实现 |
| WP05 Context Planner | `src/context/public.ts` | `src/context/planner/application/context-planner.ts`、`src/context/render/application/context-render-binder.ts` | Mode 0 已实现 |

### 1.7 Shadow 接入层实查（关键发现）

**实查结果**：

| 子系统 | 搜索关键词 | 匹配 | 结论 |
|--------|-----------|------|------|
| Feature Flag 系统 | `FeatureFlag\|shadow\|FeatureFlagSnapshot` | **0 匹配** | 不存在 |
| Composition Root | `CompositionRoot\|ExecutionCoordinator` | **0 匹配** | 不存在 |
| Legacy Adapter | `LegacyL1Adapter\|LegacyL2Adapter` | **0 匹配** | 不存在 |
| Flag 环境变量 | `AWKN_INPUT_GATEWAY_V1\|AWKN_INTENT_ROUTER_V1` | **0 匹配** | 不存在 |
| ShadowDiffReceipt 合约 | `ShadowDiffReceipt\|shadow-diff` | **0 匹配** | 合约未定义 |
| Engine v2 主循环 | `AgentLoop` | `src/core/agent-loop.ts` | 存在（Engine v2 权威路径） |

**结论**：Phase 4 R2 Shadow **不是"接入"，而是"从零新建整个 Shadow 子系统"**。

---

## 二、Phase 4 R2 Shadow 真实规模评估

### 2.1 需要从零新建的子系统

根据文档 16（Adapter-Shadow-FeatureFlag 迁移手册）和 Issue #66 验收要求：

1. **Feature Flag 系统**（新建 `src/feature-flag/`）
   - `FeatureFlagSnapshot` 合约（schema `awkn-feature-flag-snapshot/v1`）
   - `FeatureFlagRegistry`（管理 flag 值、依赖校验、`AOS_FLAG_DEPENDENCY_INVALID`）
   - 4 个 R2 范围 flag：`AWKN_INPUT_GATEWAY_V1`、`AWKN_INTENT_ROUTER_V1`、`AWKN_CONTEXT_PLANNER_V1`、（Claim 无独立 flag，归属 Context）
   - Snapshot 冻结逻辑（Execution 创建时冻结，不接受热更新）
   - 配置优先级：Execution Override > 部署配置 > 环境变量 > 代码默认

2. **Composition Root**（新建 `src/composition/`）
   - `ExecutionCoordinator`（编排 WP02—05 Ports）
   - 注入逻辑（Execution 创建时注入 flag snapshot + ports）
   - Execution 生命周期管理

3. **Legacy Adapter**（新建 `src/adapter/`）
   - `LegacyInputAdapter`（字符串输入 → TrustedInput 包装）
   - `LegacyIntentRouterAdapter`（旧 LLM 路由 → 新 Intent Router 旁路）
   - `LegacyMemoryContextAdapter`（旧 compileAndRender → 新 Context Planner 旁路）
   - `LegacyGoalManagerAdapter`（旧 updateGoal → 新 GoalJudgeService 旁路）
   - 每个 Adapter：shadow 只读、enforce 切换权威、记录 diff

4. **Shadow 执行路径**（新建 `src/shadow/`）
   - `ShadowExecutor`（旁路调用 WP02—05 Ports，生成 Decision Artifacts）
   - `ShadowDiffReceipt` 合约（schema `awkn-shadow-diff-receipt/v1`）
   - 9 种差异分类（EXACT/SEMANTIC_EQUIVALENT/EXPECTED_IMPROVEMENT/.../UNKNOWN）
   - `ShadowDiffEvaluator`（MATCH/ACCEPTABLE/BLOCKING 判定）
   - Shadow 隔离：外部副作用禁止、Memory Write 禁止、Delivery Write 禁止

5. **一键关闭开关**
   - 环境变量 `AWKN_SHADOW_DISABLE=1` 全局关闭
   - Execution 级 flag snapshot 覆盖

6. **测试覆盖**
   - Feature Flag 依赖校验测试
   - Shadow 无外部副作用测试
   - Legacy/New Diff 测试
   - 跨平台 Hash 一致性测试
   - 401/403 fail-closed 测试
   - Replay 一致性测试

7. **R2 Exit Report**
   - Shadow Diff 统计
   - P0/P1 Diff 清零证据
   - Windows/Linux Replay 一致证据
   - #43 R2 Exit Decision

### 2.2 工作量评估

这是**架构级新建工作**，规模远超 Phase 1—3 的总和。完整实现需要新建 4 个目录、约 15—20 个新文件、约 2000—3000 行代码 + 测试。

**不可能在一个 session 内完成全部 R2 Shadow**。必须分阶段。

---

## 三、决策树与推荐答案

### D1：EBUSY 修复提交策略

**问题**：EBUSY 修复（P0 回归）如何提交？

**选项**：
- **A（推荐）**：立即单独提交一个 commit
  - 范围：`runtime/src/store/migration-backup.ts`（EBUSY retry 逻辑）
  - commit message：`fix(store): retry computeFileHash on Windows EBUSY/EACCES transient locks`
  - 理由：P0 回归修复应独立可追溯，不与功能开发混在一起
- B：与 ToolPolicy 加固合并提交
  - 风险：回归修复与功能加固混淆，回滚困难

**推荐**：**A**。

---

### D2：ToolPolicy/Registry 安全加固提交策略

**问题**：10 个文件的 ToolPolicy/Registry 安全加固如何提交？

**选项**：
- **A（推荐）**：单独提交一个 commit
  - 范围：cli.ts、agent-loop.ts、codex.ts、minimax.ts、router.ts、process-executor.ts、policy.ts、registry.ts、sandbox-registry.test.ts、tool-policy.test.ts、llm-runtime-env.test.ts
  - commit message：`feat(tools): harden AWKN_APPROVED_TOOLS pre-approval and block 11 recursive deletion variants`
  - 理由：安全加固是独立功能，应独立可追溯
- B：拆分多个 commit
  - 风险：功能内聚，拆分无意义

**推荐**：**A**。

---

### D3：PR #64 Review 请求方式

**问题**：PR #64 仍 Draft、0 reviews，如何推进 review？

**选项**：
- **A（推荐）**：通过 `add_issue_comment` 在 PR #64 留言，正式请求人工架构与语义 Review
  - 理由：PR #64 body 已更新（三项修复完成 + 200 tests），证据充分，应主动请求 review
  - 不推送分支（符合安全边界）
- B：保持 Draft，先做 Phase 4，最后一起 review
  - 风险：PR #64 拖延过久，违背"不间断执行"的闭环原则
- C：push 当前分支到远程
  - 风险：违背授权确认书安全边界"不推送任何分支到远程"

**推荐**：**A**。请求 review 但不 push。

---

### D4：Phase 4 在哪个分支进行

**问题**：R2 Shadow 在当前 `feat/phase3-migration-backup-restore` 分支继续，还是新建分支？

**选项**：
- **A（推荐）**：新建 `feat/r2-shadow-integration` 分支，基于当前 HEAD（`119b17a` + EBUSY 修复 + ToolPolicy 加固 commit）
  - 理由：Phase 4 是独立工作单元，独立分支便于追溯和回滚
  - 符合"一个有界模块一个 PR"规则
- B：在当前分支继续
  - 风险：分支职责模糊，Phase 3 与 Phase 4 混在一起

**推荐**：**A**。

---

### D5：Phase 4 分阶段实现方案

**问题**：R2 Shadow 工作量巨大，如何分阶段？

**选项**：
- **A（推荐）**：分 6 个子阶段，每个独立 commit + 独立验证
  - **4a**：Feature Flag 系统（合约 + Registry + Snapshot 冻结 + 依赖校验测试）
  - **4b**：Composition Root（ExecutionCoordinator + Port 注入 + Execution 生命周期）
  - **4c**：Legacy Adapter（4 个 R2 范围 adapter + shadow 只读模式）
  - **4d**：Shadow Diff Receipt + Evaluator（9 种差异分类 + MATCH/ACCEPTABLE/BLOCKING 判定）
  - **4e**：Shadow 执行路径（旁路调用 + diff 生成 + 一键关闭开关 + 测试）
  - **4f**：R2 Exit Report（Shadow Diff 统计 + 跨平台 Hash 一致 + #43 R2 Exit Decision 证据）
- B：一次性实现全部
  - 风险：工作量大，无法在单次 session 完成；中途失败难以定位

**推荐**：**A**。每个子阶段完成后 `npm run check` 验证，确保不引入回归。

---

### D6：Phase 4 子阶段的 PR 策略

**问题**：6 个子阶段如何组织 PR？

**选项**：
- **A（推荐）**：6 个子阶段在同一个 `feat/r2-shadow-integration` 分支累积，最后拆分或整体提 PR
  - 理由：Shadow 子系统是内聚的，拆分 6 个 PR 增加 review 负担
  - 但每个子阶段独立 commit，便于 bisect 和回滚
- B：每个子阶段独立分支 + PR
  - 风险：6 个 PR 互相依赖，review 顺序复杂

**推荐**：**A**。单分支累积，独立 commit。

---

### D7：R2 Shadow MVP 范围（最小可行实现）

**问题**：如果时间/预算不足，R2 Shadow 的 MVP 是什么？

**选项**：
- **A（推荐）**：MVP = 4a + 4b + 4e（最小化）
  - Feature Flag 系统（4a）
  - Composition Root（4b）
  - Shadow 执行路径（4e，但 diff 用简化版：只记录 EXACT/MISMATCH 二分类）
  - 跳过 4c（Legacy Adapter 用直接调用替代）、4d（完整 Diff Evaluator 用简化版）、4f（Exit Report 用最小证据）
  - 理由：先跑通 Shadow 旁路，再迭代 diff 精度
- B：完整实现 4a—4f 才算 MVP
  - 风险：周期长，阻塞 R3 启动

**推荐**：**A**。但优先按 D5 的 6 阶段顺序推进，MVP 是后备方案。

---

### D8：Context Manifest / Render v13 Persistence 决策

**问题**：Issue #66 前置依赖之一"Context Manifest / Render v13 Persistence 决策"状态未知，如何处理？

**选项**：
- **A（推荐）**：Phase 4 范围内**不实现 v13 Persistence**，只做 Mode 0 旁路 Shadow
  - 理由：v13 Persistence 是独立的 Migration 工作，与 Shadow 接入解耦
  - Shadow 只读 Context Manifest/Render 的内存表示，不触发持久化
  - v13 Persistence 决策留给独立 WP（可能归属 WP05 后续或 WP19）
- B：先做 v13 Persistence 再做 Shadow
  - 风险：扩大范围，阻塞 Shadow

**推荐**：**A**。Shadow 与 Persistence 解耦。

---

### D9：是否 push 当前分支到远程

**问题**：本地分支领先远程 main 多个 commit，是否 push？

**选项**：
- **A（推荐）**：**不 push**，直到 PR #64 review 通过且 Phase 4 至少完成 4a—4b
  - 理由：避免半成品分支污染远程；PR #64 review 期间本地继续推进 Phase 4
  - 符合授权确认书安全边界"不推送任何分支到远程，直到用户明确授权"
- B：立即 push 当前分支
  - 风险：半成品分支，且包含未 review 的 PR #64 merge

**推荐**：**A**。

---

## 四、推荐执行顺序

```
Step 1: 本授权确认书 → 用户确认
Step 2: 提交 EBUSY 修复（D1）
  - commit: fix(store): retry computeFileHash on Windows EBUSY/EACCES
  - 验证: npm run check 全绿
Step 3: 提交 ToolPolicy/Registry 安全加固（D2）
  - commit: feat(tools): harden AWKN_APPROVED_TOOLS and block recursive deletion variants
  - 验证: npm run check 全绿
Step 4: 请求 PR #64 review（D3）
  - add_issue_comment: 正式请求人工架构与语义 Review
Step 5: 新建 feat/r2-shadow-integration 分支（D4）
Step 6: Phase 4a — Feature Flag 系统（D5）
  - 新建 src/feature-flag/
  - FeatureFlagSnapshot 合约 + Registry + 依赖校验
  - 测试: 未知 flag、依赖非法、Snapshot 冻结
  - 验证: npm run check 全绿
Step 7: Phase 4b — Composition Root
  - 新建 src/composition/
  - ExecutionCoordinator + Port 注入
  - 测试: Execution 创建时 flag snapshot 冻结
  - 验证: npm run check 全绿
Step 8: Phase 4c — Legacy Adapter
  - 新建 src/adapter/
  - 4 个 R2 adapter
  - 测试: shadow 只读、enforce 切换
  - 验证: npm run check 全绿
Step 9: Phase 4d — Shadow Diff Receipt + Evaluator
  - 新建 src/shadow/
  - ShadowDiffReceipt 合约 + 9 种差异分类 + Evaluator
  - 测试: EXACT/SEMANTIC_EQUIVALENT/SAFETY_REGRESSION/...
  - 验证: npm run check 全绿
Step 10: Phase 4e — Shadow 执行路径
  - ShadowExecutor + 旁路调用 + 一键关闭开关
  - 测试: 无外部副作用、fail-closed、Replay 一致
  - 验证: npm run check:full 全绿
Step 11: Phase 4f — R2 Exit Report
  - Shadow Diff 统计 + 跨平台 Hash 证据
  - 更新 Issue #66 checklist
  - 生成 R2 Exit Report 文档
```

---

## 五、需要用户确认的授权清单

请逐项确认（√ 同意 / × 不同意 / ? 需要讨论）：

### 提交授权
- [ ] **D1**：立即单独提交 EBUSY 修复 commit（`fix(store): retry computeFileHash on Windows EBUSY/EACCES`）
- [ ] **D2**：单独提交 ToolPolicy/Registry 安全加固 commit（`feat(tools): harden AWKN_APPROVED_TOOLS and block recursive deletion variants`）

### PR 授权
- [ ] **D3**：通过 `add_issue_comment` 在 PR #64 留言请求人工 Review（不 push 分支）
- [ ] **D9**：不 push 当前分支到远程，直到 PR #64 review 通过且 Phase 4 至少完成 4a—4b

### Phase 4 范围授权
- [ ] **D4**：新建 `feat/r2-shadow-integration` 分支基于当前 HEAD
- [ ] **D5**：分 6 个子阶段（4a—4f）实现 R2 Shadow，每个独立 commit + 验证
- [ ] **D6**：6 个子阶段在同一个 `feat/r2-shadow-integration` 分支累积，单 PR
- [ ] **D7**：MVP 范围 = 4a + 4b + 4e（简化版 diff），作为时间不足时的后备方案
- [ ] **D8**：Phase 4 不实现 Context Manifest/Render v13 Persistence，与 Shadow 解耦

### 安全边界声明
- 本次工作**不修改 PR #64 远端分支**（`feat/aos-05b-context-render`）
- 本次工作**不执行 destructive git 命令**（force push、reset --hard 等）
- 每个 Phase 4 子阶段 commit 前必须验证：`npm run check` 全绿
- Phase 4 完成后生成 R2 Exit Report，更新 Issue #66 checklist
- R2 Shadow 期间 Engine v2 保持默认权威路径，Shadow 只读不产生外部副作用

---

## 六、关键风险提示

1. **PR #64 未合并到 main**：Issue #66 严格前置依赖"PR #64 合并"。D3 推荐 review 但不阻塞 Phase 4 实现（Shadow 代码可在 feature 分支独立开发，不依赖 main）。
2. **Shadow 子系统规模大**：完整实现需 4 个新目录、15—20 个新文件。D5 的分阶段方案确保每个子阶段可独立验证。
3. **Legacy Adapter 设计复杂**：文档 16 定义了 8 个 adapter，R2 范围只需 4 个。D5 的 4c 阶段聚焦 R2 必需的 4 个。
4. **跨平台 Hash 一致性**：Phase 3 已修复 `localeCompare` 跨平台问题（PR #64 的 `compareByCodePoint`），Shadow Diff 需复用此 comparator 确保跨平台一致。
5. **EBUSY 回归教训**：Phase 3 引入的 EBUSY 回归说明 Windows 文件系统竞态需要在测试中覆盖。Phase 4 的 Shadow 测试应包含 Windows 特定的文件锁定场景。
