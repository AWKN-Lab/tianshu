# 授权确认书：Phase 6 启动与 capabilities/ 收口

> 文档编号：AUTH-2026-07-28-PHASE6-START
> 日期：2026-07-28
> 前置文档：
> - `21-Agent-OS-3.0总开发计划.md` v1.4（R2 SHADOW_PASSED_GO）
> - `2026-07-28-授权确认书-Phase5接力与Phase6启动决策.md`（上一轮接力）
> - `开发与修复完整闭环计划-2026-07-28.md`（用户原始指令）
> 状态：DRAFT_FOR_APPROVAL

---

## 一、环境前置审计结果（实查非摘要）

### 1.1 Git 状态

- 当前分支：`feat/r2-shadow-integration`
- Worktree 修改：仅 `.gitignore`（已清理）
- **未跟踪文件：仅 `capabilities/` 目录**（含 3 个文件）
- 本地领先 main：24 个 commit（Phase 1-5 全部工作）

### 1.2 capabilities/ 目录实查

**实际路径**：`capabilities/project/`（不是顶层 `capabilities/`）

**3 个文件内容**：

1. `capabilities/project/manifest.yaml` —— GUNDAM D16 创建的极简占位符
   ```yaml
   version: 1
   capabilities:
     - id: minimal
       version: "1.0.0"
       canonical_skill: minimal
       allowed_tools: []   # 空
   ```

2. `capabilities/project/agent-loop-policy.yaml` —— 全 deny 配置
   ```yaml
   global:
     service_enabled: false
     default_policy: deny
   capabilities:
     minimal:
       mode: deny
   ```

3. `capabilities/project/cards/minimal.md` —— 文档明确写明占位符来源
   > "Placeholder capability for environments where the full capability system is not deployed.
   > This is a workaround fixture created by GUNDAM D16 to allow the awkn-engine MCP server to start when the full capabilities project is not present."

**引用情况实查**：

| 引用方 | 实际引用内容 | 是否真正依赖 capabilities/ 目录 |
|---|---|---|
| `runtime/src/**` | **0 处引用** | ❌ 不依赖 |
| `runtime/baseline/agent-os-3.0-baseline.json` | `"capabilities": { "primaryCliCommandGroups": [...] }` | ❌ 是 CLI 命令组字段，与目录无关 |
| `runtime/src/memory/awkn-memory-os-backend.ts` | `capabilities: MemoryBackendCapabilities` 类型字段 | ❌ 是 MemoryBackend 类型字段，与目录无关 |
| `docs/**` | 仅在文档中提到 capabilities 概念 | ❌ 概念引用，无路径依赖 |

**结论**：`capabilities/` 是孤立的 GUNDAM D16 临时 fixture，**没有任何运行时代码引用**，删除安全。

### 1.3 R2 Exit Report 实际状态

**最新 commit**：`dd5039e feat(shadow): use real ExecutionCoordinator with R2 Port implementations - Decision: GO (10/10 ACCEPTABLE, 0 BLOCKING, 0 SAFETY_REGRESSION)`

**实际证据**：
- 执行脚本：`runtime/scripts/run-real-shadow-integration.ts`
- 10 场景全部 ACCEPTABLE
- 0 BLOCKING, 0 SAFETY_REGRESSION
- Decision: **GO**

**R2 Exit Report 决策规则**（`r2-exit-report.ts` 第 12-18 行）：
```text
- 任何 SAFETY_REGRESSION 或 CORRECTNESS_REGRESSION → NO_GO
- BLOCKING verdict 占比 > 20% → NO_GO
- 总执行数 < 10 → CONDITIONAL_GO（样本不足）
- 跨平台 Hash 不一致 → NO_GO
- 否则 → GO
```

**未完成的 R2 Exit 条件（v1.4 文档第 165-178 行）**：
- [ ] Context Manifest / Render v13 Persistence 决策
- [ ] Windows/Linux Replay 一致（当前仅 win32-x64 单平台）

**`verifyCrossPlatformHash` 实际行为**（`r2-exit-report.ts` 第 156-159 行）：
```ts
// 只有当同一 (executionId, traceId) 在 >= 2 个不同平台上有记录时，才做跨平台比较
const uniquePlatforms = new Set(group.map((r) => r.platform));
if (uniquePlatforms.size < 2) continue;  // ← 单平台自动跳过
```

**严格性分析**：
- 当前 GO 判定实际是"单平台 GO"
- `verifyCrossPlatformHash` 单平台自动跳过检查，`consistent=YES`，未真正验证跨平台一致性
- 这不违反 R2 Exit Report 决策规则（规则只要求"跨平台不一致时 NO_GO"，单平台无比较对象）
- 但违反 R2 Exit 条件第 7 项"Windows/Linux Replay 一致"

### 1.4 Phase 6 现有基础设施（UPGRADE 目标）

| 设计文档 | 现有实现 | UPGRADE 目标 |
|---|---|---|
| `05-Policy-Skill-Compiler.md` (C04) | `runtime/src/tools/policy.ts`（路径/正则规则）<br>`runtime/src/skills/manager.ts`（frontmatter 解析） | CompiledPolicyBundle + CompiledSkillBundle<br>（Registry + Conflict Resolver + Bundle Hash + Freeze） |
| `06-Tool-Model-Broker.md` (C05) | `runtime/src/tools/registry.ts`（Map<name, handler>）<br>`runtime/src/llm/router.ts`（callSource 路由） | BrokerPlan + ModelRouteReceipt + ToolCapability<br>（Provider Port + Routing + Fallback + Receipt） |
| `07-Evidence-Gain-Loop.md` (C06) | `runtime/src/core/agent-loop.ts`<br>`runtime/src/core/loop-monitor.ts`<br>`runtime/src/goal/goal-manager.ts` | EvidenceCyclePlan + ExpectedEvidence + EvidenceDelta<br>（Hypothesis + Delta + No-Gain Stop + Strategy Switch） |

### 1.5 Phase 6 设计文档冻结状态

- ✅ `05-Policy-Skill-Compiler.md` v0.2 Draft（含 Schema、优先级 P1000-P200、冲突解析、编译产物 TS 接口）
- ✅ `06-Tool-Model-Broker.md`（含 BrokerPlan、ModelRouteReceipt、ToolCapability、可见降级规则）
- ✅ `07-Evidence-Gain-Loop.md`（含 Cycle Plan、Expected Evidence、Evidence Delta、DeltaScore 公式）

---

## 二、需要授权的决策

### 决策 A：capabilities/ 目录处理

**现状**：3 个孤立 GUNDAM D16 fixture 文件，runtime/src 零引用，唯一阻塞 worktree 干净度。

**选项**：

- **A1 删除（推荐 ⭐）**：`trash capabilities/` 目录，worktree 立即干净。理由：
  - GUNDAM D16 fixture 文档自己说明是"workaround for environments where the full capability system is not deployed"
  - Phase 6 Policy/Skill Compiler 会重新设计 capability 系统，旧 fixture 无意义
  - runtime/src 零引用，删除无任何运行时影响
  - 与 R5/R6 目标一致（清零 Legacy 聚合类）

- **A2 加入版本化**：`git add capabilities/`。理由不推荐：
  - 增加 future clone 的 fixture 噪声
  - GUNDAM 后续会再生 fixture，造成持续维护负担
  - 不符合"fresh clone 可复现"原则（fixture 应该自动生成，不应入库）

- **A3 .gitignore**：加 `capabilities/` 到 .gitignore。理由折中：
  - fresh clone 仍无 fixture（与用户原诉求"不可复现"相同问题）
  - 但避免误提交，比 A2 安全

**推荐答案**：**A1 删除**。如果未来 GUNDAM 需要 fixture，应由 GUNDAM 自动生成而非入库。

---

### 决策 B：R2 Exit 单平台状态澄清

**现状**：v1.4 文档标 GO，但实际是单平台 GO（win32-x64），Linux 平台未验证。

**选项**：

- **B1 标记为 `SHADOW_PASSED_GO_SINGLE_PLATFORM`（推荐 ⭐）**：
  - 在 v1.5 文档中明确标注"单平台 GO"
  - 在 Issue #66 评论中说明"待 Linux 验证补做"
  - 不阻塞 Phase 6 启动
  - 理由：R2 Exit Report 决策规则未违反（单平台无比较对象，不算不一致），仅未满足"Windows/Linux Replay 一致"项
  - 工程务实：CI 或后续 Linux 机器补做即可

- **B2 推迟 Phase 6 直到 Linux 验证通过**：
  - 严格但拖延 timeline
  - 需要找 Linux 机器执行 `run-real-shadow-integration.ts`
  - 不推荐：过度保守

- **B3 接受单平台 GO，不澄清**：
  - 与 R2 Exit Report 严格性冲突
  - 不推荐：未来 reviewer 无法判断证据强度

**推荐答案**：**B1 标记为单平台 GO**。在文档与 Issue #66 中明确状态，Phase 6 可启动，Linux 验证作为 R5 Shadow Beta 前置条件补做。

---

### 决策 C：Phase 6 实施顺序与并行度

**现状**：C04/C05/C06 三个组件，依赖关系明确（C06 依赖 C04+C05 编译产物）。

**选项**：

- **C1 串行 C04 → C05 → C06（推荐 ⭐）**：
  - 与设计文档依赖图一致：`WP06+WP07+WP08+WP09 → WP10`
  - 每个组件独立 PR，符合 WIP 规则"一个有界模块一个 PR"
  - 每个组件 Mode 0 → Shadow → Enforce 渐进
  - 预计：C04 完成 → C05 完成 → C06 完成

- **C2 并行三组件启动**：
  - 违反 C06 依赖（必须等 C04+C05 编译产物）
  - 不推荐

- **C3 仅启动 C04，等稳定再启动 C05、C06**：
  - 更保守但拉长 timeline
  - 可作为备选方案

**推荐答案**：**C1 串行 C04 → C05 → C06**。

---

### 决策 D：每个组件的初始 Mode

**现状**：R2 已用 Mode 0 → Shadow 模式验证，Phase 6 应遵循相同渐进原则。

**选项**：

- **D1 全部 Mode 0（推荐 ⭐）**：
  - 与 R2 模式一致
  - 先实现 Contract + 静态测试，不破坏现有 runtime
  - Mode 0 合并不构成发布里程碑退出，但是 Shadow 的前置
  - 现有 ToolPolicy/ToolRegistry/LlmRouter/SkillsManager 保持不动，新组件旁路

- **D2 部分组件直接 Shadow**：
  - 违反"先 Mode 0 再 Shadow"原则
  - 不推荐

- **D3 部分组件直接 Enforce**：
  - 违反安全原则，跳过 Shadow 验证
  - 严禁

**推荐答案**：**D1 全部 Mode 0**。

---

### 决策 E：PR 策略

**现状**：WIP 规则"一个有界模块一个 PR"，最多 2 个开放代码 PR。

**选项**：

- **E1 一个组件一个 PR（推荐 ⭐）**：
  - 与 WIP 规则一致
  - review 友好
  - C04 PR → C05 PR → C06 PR（串行合并）
  - 最多堆叠 PR 深度 2（C05 依赖 C04 时）

- **E2 三个组件合并一个 PR**：
  - 违反 WIP 规则
  - review 困难（diff 过大）
  - 不推荐

**推荐答案**：**E1 一个组件一个 PR**。

---

### 决策 F：v13 Persistence 决策（R2 遗留项）

**现状**：R2 Exit 条件第 6 项"Context Manifest / Render v13 Persistence 决策"未完成。

**选项**：

- **F1 推迟到 R5 Shadow Beta（推荐 ⭐）**：
  - v13 Persistence 是 R3 范畴的存储决策
  - 实际使用发生在 R5 Shadow Beta
  - 推迟到 R5 时基于实际 Shadow 数据决策更明智
  - 在 v1.5 文档中明确"v13 Persistence 决策推迟到 R5"

- **F2 现在做决策**：
  - 基于不完整信息做决策
  - 不推荐

- **F3 不做决策**：
  - 违反 R2 Exit 条件
  - 不推荐

**推荐答案**：**F1 推迟到 R5 Shadow Beta**。在文档中明确记录推迟决策。

---

## 三、推荐路径汇总

**默认推荐组合**：**A1 + B1 + C1 + D1 + E1 + F1**

执行顺序：

1. **立即（capabilities 收口）**：
   - `trash capabilities/`（A1）
   - worktree 立即干净

2. **立即（文档更新）**：
   - 更新 `21-Agent-OS-3.0总开发计划.md` 至 v1.5（B1 + F1）
   - 在 Issue #66 评论单平台 GO 状态（B1）

3. **Phase 6 Step 1（C04 Policy/Skill Compiler）**：
   - 创建 `feat/phase6-policy-skill-compiler` 分支
   - 实现 Policy Registry + Skill Registry（Mode 0）
   - 实现 Conflict Resolver + Compiled Bundle
   - 添加 Contract 测试
   - PR #? 待分配

4. **Phase 6 Step 2（C05 Tool/Model Broker）**：
   - 基于 C04 编译产物
   - 实现 BrokerPlan + Model/Tool Route Receipt
   - 添加 Contract 测试
   - PR #? 待分配

5. **Phase 6 Step 3（C06 Evidence-Gain Loop）**：
   - 基于 C04+C05 编译产物
   - 实现 EvidenceCyclePlan + EvidenceDelta + No-Gain Stop
   - 添加 Contract 测试
   - PR #? 待分配

6. **R5 Shadow Beta 前置**：
   - Linux 平台 R2 验证（B1 遗留）
   - v13 Persistence 决策（F1 遗留）

---

## 四、风险与回滚

### 4.1 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| C04 Policy/Skill Compiler 与现有 ToolPolicy/SkillsManager 边界冲突 | 中 | 中 | Mode 0 不替换现有，旁路实现，Shadow 验证后再切换 |
| C05 Broker 与现有 LlmRouter 路由逻辑冲突 | 中 | 中 | 同上，Mode 0 旁路 |
| C06 Evidence Delta 计算公式与实际 Loop 行为不匹配 | 低 | 低 | Contract 测试覆盖 DeltaScore 公式 |
| Phase 6 三个组件 timeline 拉长 | 高 | 中 | 串行启动，每组件独立 PR，不阻塞其他工作 |

### 4.2 回滚策略

- **Mode 0 阶段回滚**：删除新代码，无 runtime 影响（旁路实现）
- **Shadow 阶段回滚**：Feature Flag 切回 '0'，立即恢复 Engine v2 接管
- **Enforce 阶段回滚**：Feature Flag 切回 'shadow' 或 '0'，需验证回滚后状态一致

---

## 五、待确认清单

请用户对以下 6 项决策逐一确认：

- [ ] **A**: capabilities/ 处理方式（A1/A2/A3，推荐 **A1 删除**）
- [ ] **B**: R2 Exit 单平台状态澄清（B1/B2/B3，推荐 **B1 标记单平台 GO**）
- [ ] **C**: Phase 6 实施顺序（C1/C2/C3，推荐 **C1 串行 C04→C05→C06**）
- [ ] **D**: 每个组件初始 Mode（D1/D2/D3，推荐 **D1 全部 Mode 0**）
- [ ] **E**: PR 策略（E1/E2，推荐 **E1 一组件一 PR**）
- [ ] **F**: v13 Persistence 决策时机（F1/F2/F3，推荐 **F1 推迟到 R5**）

**默认推荐组合**：**A1 + B1 + C1 + D1 + E1 + F1**（最安全路径）

确认后立即执行：
1. trash capabilities/
2. 更新开发计划至 v1.5
3. 在 Issue #66 评论单平台 GO 状态
4. 启动 C04 Policy/Skill Compiler 实施（创建分支 + Contract 冻结）
