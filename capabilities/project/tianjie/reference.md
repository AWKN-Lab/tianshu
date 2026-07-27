---
name: awkn-程序员天阶功法
protection: 🔴
displayName: "AWKN 工程大脑"
description_zh: "AWKN工程大脑 — 从想法到上线的AI驱动工程全流程。DSPBRSE七阶段规范驱动：发现→规格化→计划→构建→审查→交付→进化。融合Constitution宪法、Delta Specs增量规范、工程铁律、质量保障、认知框架五大方法论，并通过标准 handoff 契约串联各阶段。触发词：@程序员、开始项目、继续项目、工程大脑、天阶功法"
aliases: ["@程序员", "@天阶", "天阶", "程序员天阶功法", "AWKN功法", "工程大脑", "开始项目", "继续项目", "项目开发流程", "立项", "技术方案", "开发任务", "发布上线", "项目复盘", "经验沉淀", "经验检索"]
version: v3.2.0
description: AWKN 工程大脑 v3.2 — AI驱动的中国开发者工程全流程。DSPBRSE七阶段规范驱动 + 自治模式三层治理（Compaction续接 + 阶段守卫 + 节奏编排断路器）。融合 Constitution宪法、Delta Specs增量规范、工程铁律、质量保障与认知框架，并用标准 handoff 契约、阶段退出标准和宿主适配层衔接 PRD、工程文档、实现、审核与部署。触发词：@程序员、开始项目、继续项目、工程大脑、天阶功法、自治模式
category: 工程大脑
tags: ["engineering", "spec-driven", "dsp-brse", "constitution", "delta-specs", "self-evolution", "best-practices", "decision-making", "project-management"]
triggers:
  - keyword: "@程序员"
    description: "用户直接调用程序员天阶功法"
  - keyword: "@天阶"
    description: "用户直接调用天阶调度入口"
  - keyword: 开始项目
    description: "用户要启动一个新项目"
  - keyword: 继续项目
    description: "用户要继续一个已有项目"
  - keyword: 工程大脑
    description: "用户需要工程全流程管理"
  - keyword: 天阶功法
    description: "用户需要DSPBRSE七阶段流程"
  - keyword: 程序员天阶功法
    description: "用户需要完整的工程方法论"
  - keyword: 项目开发流程
    description: "用户需要规范的开发流程"
  - keyword: 立项
    description: "用户需要项目立项"
  - keyword: 技术方案
    description: "用户需要做技术方案"
  - keyword: 发布上线
    description: "用户需要发布上线"
  - keyword: 项目复盘
    description: "用户需要做项目复盘"
  - keyword: 经验沉淀
    description: "用户需要沉淀项目经验"
  - keyword: 部署
    description: "用户需要部署"
  - keyword: deploy
    description: "英文触发词"
author: AWKN Lab (基于500+小时实战 + AWKN五大方法论融合)
license: MIT
owns:
  - DSPBRSE 七阶段流程调度
  - Constitution 宪法系统
  - Clarity Gate 清晰门禁
  - Card Deck 节奏编排
  - 自进化闭环系统
  - 技能间调度与阶段检测
do-not-touch:
  - 具体代码实现（awkn-工程师）
  - PRD生成（awkn-prd）
  - 工程文档生成（awkn-工程文档）
  - 代码审查（awkn-审核）
  - 部署执行（awkn-部署）
---

# AWKN 工程大脑 v3.2.0

> AI 驱动的中国开发者工程大脑 — 从想法到上线的全流程规范驱动工程体系
> 融合 Constitution宪法 + Delta Specs增量规范 + 工程铁律 + 质量保障 + 认知框架 五大方法论

---

## 核心价值

| 价值 | 说明 |
|------|------|
| **一入口** | 用户只需说"开始项目"，AI 自动判断阶段并流转 |
| **一方法** | 统一 DSPBRSE 方法论，消除三套规范打架 |
| **一宪法** | 每个项目有 Constitution，原则约束自动注入 |
| **自进化** | 每次错误自动学习，规则自动晋升 |

## 瘦身原则：只做调度，不做执行

天阶功法的目标不是成为最大技能，而是成为最稳定的跨阶段调度器。具体能力必须下沉给对应工作流技能，本技能只保留：

- 阶段识别：判断当前处于 D/S/P/B/R/S/E 哪个阶段。
- 技能路由：决定调用 awkn-prd、awkn-工程文档、awkn-工程师、awkn-审核、awkn-cicd、awkn-部署中的哪一个。
- Handoff 契约：检查上游产物是否足够让下游执行。
- 门禁判断：根据退出标准决定推进、回退、暂停或补文档。
- 流程恢复：长任务中断后读取 handoff、计划和验证证据恢复上下文。

不得继续向本技能塞具体执行能力：

| 能力类型 | 归属技能 |
|---|---|
| PRD、用户故事、需求拆解 | awkn-prd |
| 工程交接包、接口/数据库/测试/部署文档 | awkn-工程文档 |
| 技术方案、代码实现、排错、测试执行 | awkn-工程师 |
| Bug 复现→定位→修复→验证 四阶段闭环 | awkn-bug修复大法 |
| 代码审查、QA、安全扫描、发布前质量门禁 | awkn-审核 |
| 变更影响分析、五步门禁（R→L→P→P→V） | awkn-执行检查 |
| 自动测试、质量门禁、发布触发 | awkn-cicd |
| 部署、回滚、健康检查、生产发布 | awkn-部署 |
| NestJS/Prisma/BullMQ 技术栈代码模板 | 本技能 02_05_appendix-F |
| UI/UX、前端视觉与交互设计 | awkn-ui |

新增能力的处理规则：

1. 如果是某阶段的执行方法，优先合入对应阶段技能。
2. 如果是跨阶段协议，只在本技能保留索引、契约或路由规则。
3. 如果只是参考资料，放入对应技能 `references/`，本技能只保留一句入口。
4. 本技能 SKILL.md 不再承载大段执行教程。

---

## 方法论索引

| 方法论 | 核心文件 | SKILL.md 章节 |
|--------|---------|--------------|
| Constitution 宪法 | `00_总控与宪法/constitution/` | Constitution 章节 |
| Delta Specs 增量规范 | `00_总控与宪法/delta-specs/` | Delta Specs 章节 |
| 质量保障 | `00_总控与宪法/core/quality-rules.md` | 质量保障章节 |
| 认知框架 | `00_总控与宪法/core/behavior-rules.md` | Clarity Gate + Card Deck 章节 |
| 自进化闭环 | `03_证据与进化主链/evolution/` | 自进化闭环章节 |

---

## DSPBRSE 七阶段

> 权威定义：`00_总控与宪法/00_00_作战地图与阶段切换.md`

各阶段详细进入/退出条件、阶段状态卡模板，见上方权威文件。本 SKILL.md 只保留快速索引。

| 阶段 | 调用技能 |
|------|---------|
| **D** Discover | awkn-prd/user-insight |
| **S** Specify | awkn-prd |
| **P** Plan | awkn-prd/prd-flow |
| **B** Build | awkn-工程文档 + awkn-工程师（排错/Bug修复优先路由 awkn-bug修复大法） |
| **R** Review | awkn-审核 + awkn-执行检查 |
| **S** Ship | awkn-cicd → awkn-部署 |
| **E** Evolve | 本技能 + awkn-工程文档（复盘文档） |

阶段切换规则见 `00_总控与宪法/00_00_作战地图与阶段切换.md#动作3-禁止跨阶段规则`。

---

## Clarity Gate（清晰门禁）

> 来源：AWKN 认知框架 — 四维度模糊检测

执行任何阶段前，先通过 Clarity Gate 检测：

| 维度 | 检测内容 | 模糊时行为 |
|------|---------|-----------|
| **Scope** | 范围是否明确？ | ≥2维度模糊 → **必须提问** |
| **Goal** | 目标是否可衡量？ | 1维度模糊 → **声明假设后继续** |
| **Constraints** | 约束是否列出？ | 0维度模糊 → **直接执行** |
| **Architecture Type** | 架构类型是否确定？ | |

**复杂度判定**（Clarity Gate 附加输出）：
- complexity: simple / medium / complex（按文件数和依赖判定，默认 medium）
- fileCount: number（预估影响文件数）
- crossModule: boolean（是否跨模块）
- securityRelated: boolean（是否安全相关）
- routingReason: string（为什么选这个复杂度）

> 复杂度路由详细定义：`02_技术与交付主链/phases/complexity-routing.md`

---

## Card Deck（节奏编排）

> 来源：AWKN 认知框架 — 注意力成本模型

**三条注意力法则**：
1. 每次出牌都有注意力成本 — 不说废话
2. 时机改变价值 — 在正确时刻说正确的话
3. 沉默也是设计 — 有时不做是最优选择

| Card 类型 | 说明 | 使用时机 |
|----------|------|---------|
| clarify | 澄清 | Scope/Goal 不清晰时 |
| shrink-scope | 缩小范围 | 需求过大时 |
| options | 给选项 | 存在多种方案时 |
| execute | 执行 | Clarity Gate 通过后 |
| verify | 验证 | 实现完成后 |
| fix | 修复（四阶段调试法） | 发现错误时，遵循 `02_技术与交付主链/phases/debug.md` |
| rollback | 回滚 | 部署失败时 |
| risk | 风险提示 | 发现潜在风险时 |
| nudge | 轻推 | 用户可能遗忘时 |
| pause | 暂停 | 需要用户确认时 |

> **认知框架 = Clarity Gate + Card Deck + 行为规则**。行为规则详见 `00_总控与宪法/core/behavior-rules.md`（19 条交互行为规则）。

### Intent Amplification（意图放大）

**文件**：`02_技术与交付主链/phases/intent-amplification.md`
**触发**：summary / rollback / risk / pause 牌出牌时
**核心**：同一 intent core 按 4 维（Audience×Touchpoint×Context×Attention）切壳输出

默认 Shell：
- 老板 → 结论先行 + 关键数字 + 下一步
- 开发 → 技术细节 + 代码路径 + 片段
- 用户 → 功能说明 + 使用步骤
- 审计 → 断言 + 证据 + 结论

---

## 质量保障 → awkn-审核

> 已下沉：4维度15条质量规则 + 审查三件套 → [awkn-审核/SKILL.md](../awkn-审核/SKILL.md)

---

## Constitution（宪法）系统 → awkn-prd

> 已下沉：宪法模板 + 自动生成规则 → [awkn-prd/SKILL.md](../awkn-prd/SKILL.md)

---

## Delta Specs（增量变更） → awkn-工程文档

> 已下沉：增量变更流程命令 → [awkn-工程文档/SKILL.md](../awkn-工程文档/SKILL.md)

---

## Workflow Handoff（交接契约）

> 新增：让阶段流转不再只靠自然语言上下文

每个阶段结束时，应产出标准交接包，供下游阶段直接消费：

- JSON Schema：`hooks/handoff-schema.json`（机器可读校验）
- 示例交接包：`hooks/handoff-example.json`
- 校验脚本：`hooks/scripts/handoff-validator.js`

最小必含字段（8个）：

1. `stage` — 当前阶段（D/S/P/B/R/S/E）
2. `goal` — 本阶段目标
3. `constraints` — 约束条件
4. `artifacts` — 产出物（含 name/path/type）
5. `decisions` — 关键决策（含 topic/choice/rationale）
6. `definition_of_done` — 完成标准
7. `status` — 状态（complete/partial/blocked）
8. `next_stage` — 下一阶段

可选字段：
- `parallel_stages` — 可并行阶段（如 Build+Doc）
- `context_file` — 对应 context 模板路径
- `review_verdict` — Review 专用（pass/reject/escalate）
- `blocked_reason` — blocked 状态原因

---

## Host Adapter（宿主适配层）

> 新增：面向 `Trae`、`Claude Code`、`Codex` 的跨宿主兼容设计

本技能不应绑定单一宿主，而应分成两层：

1. **Core Protocol**：DSPBRSE、Clarity Gate、Card Deck、Workflow Handoff
2. **Host Adapters**：针对不同宿主映射触发方式、上下文读取和执行约束

适配文档：

- `00_总控与宪法/adapters/README.md`
- `00_总控与宪法/adapters/claude-code.md`
- `00_总控与宪法/adapters/codex.md`
- `00_总控与宪法/adapters/trae.md`

---

## Hooks 自动化系统

> 新增 v2.7.0：基于 ECC hooks 架构 + AWKN 工程铁律的自动化门禁系统
> 配置文件：`hooks/hooks.json`

### 生命周期 Hook 映射

| 生命周期 | Hook ID | 对应铁律 | 功能 |
|----------|---------|---------|------|
| **PreToolUse** | `pre:edit:fact-force-gate` | 铁律11 先读后判 | 首次编辑文件时要求先读取 |
| **PreToolUse** | `pre:edit:config-protection` | — | 阻止修改规则/宪法文件 |
| **PreToolUse** | `pre:bash:deploy-guard` | 铁律5 部署3确认 | 部署操作前确认实际路径 |
| **PostToolUse** | `post:edit:accumulator` | — | 记录编辑文件，Stop时批量检查 |
| **PostToolUse** | `post:edit:skill-change-warning` | — | 修改技能后提醒测评 |
| **Stop** | `stop:quality-gate` | 完成标准5项 | 批量 typecheck + lint |
| **Stop** | `stop:memory-persist` | 记忆协议 | 会话结束保存记忆 |
| **Stop** | `stop:experience-extract` | 自进化闭环 | 评估可提取经验 |
| **SessionStart** | `session:load-context` | 启动协议 | 加载 SHARED_CONTEXT |
| **PreCompact** | `precompact:memory-promotion` | 记忆晋升 | 压缩前 L0→L1 检查 |

### Profile 分级

| Profile | 启用范围 | 适用场景 |
|---------|---------|---------|
| `minimal` | 会话加载 + 质量门禁 | 快速修复、紧急任务 |
| `standard` | 全部 hooks | 日常开发（默认） |
| `strict` | 全部 + 配置保护强制阻断 | 正式发布前 |

### 环境变量

```bash
AWKN_HOOK_PROFILE=standard          # minimal/standard/strict
AWKN_DISABLED_HOOKS="pre:edit:config-protection"  # 按ID禁用
AWKN_ALLOW_CONFIG_EDIT=1            # 允许修改规则/宪法（需用户授权）
```

---

## Autonomous Mode（自治模式）

> 新增 v3.0.0：从 Meta_Kim 治理架构移植的三大自治组件
> 触发词：`@程序员 自治模式`、`启动自治`、`autonomous mode`、`7天自治`

### 架构概览

自治模式在 DSPBRSE 七阶段之上叠加三层治理机制，使系统从「被调用时工作」升级为「自主决策何时工作」。

```
┌─────────────────────────────────────────────┐
│           Autonomous Engine（目标引擎）        │  ← Phase 2 ✓
│  读取 Tolaria 00-goals → 分解任务 → 排期     │ → awkn-自治引擎
├─────────────────────────────────────────────┤
│           Rhythm Conductor（节奏编排）         │  ← Phase 1 ✓
│  8 卡发牌 → 断路器 → 自动暂停/验证/回滚      │
├─────────────────────────────────────────────┤
│           DSPBRSE Stage Guard（阶段守卫）      │  ← Phase 1 ✓
│  PreToolUse 拦截 → 阶段合规检查 → 阻断/警告   │
├─────────────────────────────────────────────┤
│           Compaction Packet（续接协议）        │  ← Phase 1 ✓
│  Stop 写压缩 → SessionStart 读续接 → 断点恢复 │
├─────────────────────────────────────────────┤
│           DSPBRSE 七阶段（天阶功法核心）        │
│  D → S → P → B → R → S → E                  │
└─────────────────────────────────────────────┘
```

### 组件 1：Compaction Packet（续接协议）

**文件**：`C:\Users\10919\.claude\hooks\tolaria-memory-hook.mjs`（已扩展）
**存储**：`Tolaria/03-sessions/_compaction/latest.json`

每次会话 Stop 时自动生成结构化续接包，包含：

| 字段 | 说明 |
|------|------|
| `dspbrse.stage` | 当前 DSPBRSE 阶段（从 transcript 关键词推断） |
| `dspbrse.stageHistory` | 本次会话经过的所有阶段轨迹 |
| `taskQueue` | 待办任务（从 TODO/FIXME/下一步 提取） |
| `handoff.artifacts` | 本轮产出物 + 下游所需产物 |
| `circuitBreaker` | 断路器状态（连续失败/重试次数） |
| `rhythm` | 节奏编排状态（连续执行次数、上次发牌） |
| `resume` | 续接指令（断点 + 下一步行动 + 前置条件） |

下次 SessionStart 时自动读取 latest.json，注入续接上下文。

### 组件 2：DSPBRSE Stage Guard（阶段守卫）

**文件**：`C:\Users\10919\.claude\hooks\enforce-dspbrse-stage.mjs`
**注册**：PreToolUse（matcher: "*"）

| DSPBRSE 阶段 | 允许 Write | 允许 Bash | 特殊规则 |
|-------------|-----------|----------|---------|
| Discover | ✗ | 只读 | 禁止写代码 |
| Specify | ✓ (文档) | 只读 | 只允许 .md/.json |
| Plan | ✓ (文档) | 只读 | 只允许计划文档 |
| Build | ✓ (全) | 全 | 允许所有开发操作 |
| Review | ✓ (报告) | 只读 | 禁止修改源代码 |
| Ship | ✓ (配置) | 全 | 必须先通过 Review 门禁 |
| Evolve | ✓ (全) | 只读 | 允许写经验文档 |

两种运行模式：
- **普通模式**（默认）：不合规操作输出 ⚠️ 警告，不阻断
- **自治模式**（`_autonomous-mode.json` 启用后）：不合规操作直接 deny 阻断

### 组件 3：Rhythm Conductor（节奏编排引擎）

**文件**：`C:\Users\10919\.claude\hooks\rhythm-conductor.mjs`
**注册**：PostToolUse（追踪） + PreToolUse（检查） + SessionStart（重置）
**状态**：`Tolaria/03-sessions/_compaction/_rhythm-state.json`

8 张事件卡（从 Card Deck 升级，新增自动化发牌逻辑）：

| 卡牌 | 成本 | 自动触发条件 |
|------|------|------------|
| ▶ EXECUTE | 1 | 默认：一切正常 |
| 🔍 VERIFY | 2 | 连续 >5 次写操作无验证 |
| 🔧 FIX | 3 | 检测到任何工具调用失败 |
| ↩️ ROLLBACK | 4 | 同类失败重复 ≥2 次 |
| ❓ CLARIFY | 2 | 信息不足时（保留给天阶功法） |
| 📏 SHRINK | 2 | 复杂度超限时（保留给天阶功法） |
| ⚠️ RISK | 3 | 检测到危险操作（rm -rf / DROP TABLE 等） |
| ⛔ PAUSE | 5 | 连续 ≥3 次失败 / 3 张高成本卡连发 |

**断路器规则**（三条铁律）：
1. 连续 3 次失败 → 自动 PAUSE（硬停止，需用户输入 "继续" 解除）
2. 连续 5 次执行无验证 → 自动 VERIFY（建议先跑测试）
3. 连续 3 张高成本卡（PAUSE/ROLLBACK/FIX）→ 强制 PAUSE

### 组件 4：Autonomous Engine（自治引擎）

**技能**：[awkn-自治引擎](../awkn-自治引擎/SKILL.md)
**状态文件**：`记忆系统/03-sessions/_autonomous-mode.json`

| 子组件 | 文件 | 功能 |
|--------|------|------|
| 目标分解器 | engine/goal-decomposer.mjs | 读取 00-goals → 按 DSPBRSE 拆解为 Sprint 任务 |
| 任务队列 | engine/task-queue.mjs | 优先级排序 + 依赖检查 + 自动解除阻塞 |
| 决策权限矩阵 | engine/decision-matrix.mjs | L1自主/L2通知/L3审批 + 递归进化防御 |
| 进度追踪器 | engine/progress-tracker.mjs | 每日完成度百分比 + 日报生成 |
| 伤疤协议 | engine/scar-protocol.mjs | 失败模式记录 + 严重度分级防御 |
| 进化扫描器 | engine/evolution-scanner.mjs | 5维进化扫描（模式复用/边界漂移/节奏瓶颈/能力缺口/伤疤检测） |
| 报告生成器 | engine/report-generator.mjs | 7天进化报告自动生成 |

**自触发器**：`.claude/hooks/awkn-autonomous-trigger.mjs`（Windows Task Scheduler 每6小时触发）

### 自治模式开关

创建/删除以下文件切换模式：

```bash
# 启用自治模式（强制阻断）
echo '{"enabled":true,"startedAt":"2026-06-12T00:00:00+08:00"}' > "C:/Users/10919/Desktop/AWKN-Lab/记忆系统/_autonomous-mode.json"

# 关闭自治模式（仅警告）
# 删除上述文件或将 enabled 改为 false
```

---

## Contexts 动态注入

> 新增 v2.7.0：按 DSPBRSE 阶段自动注入上下文，节省 token
> 模板目录：`contexts/`

### 阶段-Context 映射

| DSPBRSE 阶段 | Context 文件 | 核心约束 |
|--------------|-------------|---------|
| **D** Discover | `contexts/discover.md` | 先听后说、JTBD三层拆解、Clarity Gate |
| **S** Specify | `contexts/specify.md` | 问题先于方案、MVP≤7、不做清单≥10 |
| **P** Plan | `contexts/specify.md` | 同 Specify（Plan 与 Specify 共享上下文） |
| **B** Build | `contexts/build.md` | Simplicity First、Surgical Changes、TDD |
| **R** Review | `contexts/review.md` | 逐文件审查、安全门禁、完成标准5项 |
| **S** Ship | `contexts/ship.md` | 部署3确认、四步法、回滚方案 |
| **E** Evolve | — | 无专属 context（使用自进化闭环） |

### 加载规则

1. 阶段切换时，自动加载对应 context 文件
2. 每个 context < 30 行，仅注入核心约束
3. 同一会话内，context 仅首次加载（不重复注入）
4. 用户可通过 `AWKN_DISABLED_CONTEXTS` 环境变量禁用特定 context

---

## Exit Criteria（阶段退出标准）

> 新增：定义每个阶段何时允许流转到下一阶段

- 标准说明：`05_经验沉淀与资产库/references/phase-exit-criteria.md`

原则：

1. 不靠主观感觉结束阶段
2. 必须有最小产物
3. 必须能被下阶段直接消费

---

## 自进化闭环

> 融合 AWKN 质量保障 + AWKN 认知框架
> 详细定义：`03_证据与进化主链/evolution/evolution-engine.md`

```
操作日志 → corrections.jsonl → pattern 识别 → learned-rules.md → Preamble 注入
```

**触发条件与执行者**：

| 触发条件 | 执行者 | 动作 |
|---------|--------|------|
| 错误发生 | AI + 人类 | 记录到 corrections.jsonl |
| 同一错误 3 次 | AI | 晋升到 learned-rules.md |
| 月度复盘 | AI + 人类 | 更新 Constitution |
| 技能加载 | AI 宿主 | Preamble 注入 learned-rules |

### 已沉淀的工程经验（E 系列参考）

> 来自 `awkn-agent 90 天中期复盘` (2026-06-11) §五 → 沉淀日期 2026-06-13
> 完整证据链：`记忆系统/L1/项目复盘/awkn-agent-90天中期复盘-5方法论沉淀_E68-E72_2026-06-13.md`

| 编号 | 主题 | 适用情境 | L2 详情 |
|------|------|---------|---------|
| **E70** | 拆分大文件时，sibling > 子类 | ">1000 行 + 单类 + 10+ 字段" 拆分 | [E70](file:///C:/Users/10919/Desktop/AWKN-Lab/记忆系统/L2/行为偏好/awkn-agent-sibling优于子类_E70_2026-06-13.md) |

---

## 技能调度矩阵

| 用户说 | 阶段 | 调用技能 |
|--------|------|---------|
| "开始项目" | Discover | awkn-prd/user-insight |
| "写PRD" / "PRD" | Specify | awkn-prd/prd-prototype |
| "拆解任务" / "Epic拆解" | Plan | awkn-prd/prd-flow |
| "工程文档" | Build | awkn-工程文档 |
| "写代码" / "实现" | Build | awkn-工程师 |
| "代码审查" / "review" | Review | awkn-审核 |
| "部署" / "上线" | Ship | awkn-部署 |
| "复盘" / "经验沉淀" | Evolve | 本技能 |
| "继续项目" | 自动检测 | 根据项目状态自动选择 |

---

## 子技能索引

| 子技能 | 路径 | 用途 |
|--------|------|------|
| 七阶段定义 | `02_技术与交付主链/phases/` | 每个阶段的详细流程 |
| Build 铁律 | `02_技术与交付主链/phases/build.md` | Simplicity First + Surgical Changes + TDD |
| 系统调试 | `02_技术与交付主链/phases/debug.md` | fix Card 四阶段调试法 |
| 双阶段审查 | `02_技术与交付主链/phases/review.md` | 规格合规 → 代码质量 |
| Spec 归档 | `02_技术与交付主链/phases/evolve.md` | Delta 归档 + 主规范合并 |
| Constitution | `00_总控与宪法/constitution/` | 宪法模板和验证器 |
| Delta Specs | `00_总控与宪法/delta-specs/` | 增量变更流程 |
| 自进化 | `03_证据与进化主链/evolution/` | 进化引擎和学习规则 |
| 参考文档 | `05_经验沉淀与资产库/references/` | AWKN方法论参考 + PowerShell踩坑经验录 |
| 模板 | `04_武器库与模板库/templates/` | 各类文档模板 |
| 校验脚本 | `04_武器库与模板库/scripts/` | handoff 完整性校验 |
| 宿主适配 | `00_总控与宪法/adapters/` | Claude Code / Codex / Trae 适配层 |
| 质量规则 | `00_总控与宪法/core/quality-rules.md` | 4维度15条质量规则 |
| 行为规则 | `00_总控与宪法/core/behavior-rules.md` | 19条交互行为规则 |
| 流程规则 | `00_总控与宪法/core/process-rules.md` | 开发流程约束规则 |
| 安全规则 | `00_总控与宪法/core/safety-rules.md` | 安全红线规则 |
| Hooks 自动化 | `hooks/hooks.json` | 11个生命周期hook + 3级profile |
| Contexts 动态注入 | `contexts/*.md` | 7个DSPBRSE阶段上下文模板 |
| Handoff Schema | `hooks/handoff-schema.json` | 8必填+4可选字段的机器可读交接契约 |
| Handoff 校验 | `hooks/scripts/handoff-validator.js` | 交接包自动校验脚本 |
| MCP 统一管理 | `mcp-configs/mcp-servers.json` | 17个MCP服务 + 3级预设 |

---

## 关联技能

| 技能 | 定位 | 关系 |
|------|------|------|
| **awkn-工程师** | 工程师核心能力 | Build 阶段执行者 |
| **awkn-prd** | PRD全流程 | Discover/Specify/Plan 阶段 |
| **awkn-工程文档** | 工程文档生成 | Build 阶段文档 |
| **awkn-审核** | 质量保障 | Review 阶段 |
| **awkn-部署** | 部署交付 | Ship 阶段 |

---

## IPO 编排层

### DSPBRSE七阶段映射为IPO

| 阶段 | IPO角色 | Input | Output | 下游技能 |
|------|--------|-------|--------|---------|
| D-Discover | Input | 用户想法/问题 | 问题定义+用户洞察 | → awkn-创新经理.discovery |
| S-Specify | Process | 问题定义 | PRD+规格说明 | → awkn-prd |
| P-Plan | Process | PRD | 技术方案+任务拆分 | → awkn-工程师 |
| B-Build | Process | 技术方案 | 代码+测试 | → awkn-工程师 |
| R-Review | Process | 代码+文档 | 审查结论 | → awkn-审核 |
| S-Ship | Output | 审查通过 | 部署上线 | → awkn-部署 |
| E-Evolve | Output | 项目经验 | 规则更新+经验沉淀 | → (自进化) |

### 编排模式

| 流程名 | 流 | 触发场景 |
|--------|---|---------|
| 全流程 | D→S→P→B→R→S→E | 全新项目 |
| 继续开发 | P→B→R→S | 已有PRD继续开发 |
| 快速修复 | B→R→S | 紧急bug修复 |
| 只做规划 | D→S→P | 只需方案不需实现 |
| **并行模式** | B+Doc ‖ R+Security ‖ S+Monitor | 代码改动≤5文件/涉及API/部署生产 |

并行阶段冲突解决：共享文件修改权归主阶段，副阶段只读。

## MCP 统一管理

> 新增 v2.8.0：整合分散在各技能中的 MCP 服务器定义

- 配置文件：`mcp-configs/mcp-servers.json`（17 个 MCP 服务）
- 使用文档：`mcp-configs/README.md`
- 预设模式：minimal(2) / standard(5) / full(17)
- 上下文管理：总配置 ≤ 20 | 项目启用 ≤ 8 | 活动工具 ≤ 60
- 禁用机制：`AWKN_DISABLED_MCPS` 环境变量

### Workflow Handoff → IPO接口

现有 Workflow Handoff 契约（8字段）自然映射为 IPO 接口：
- `from_phase`/`to_phase` = IPO 数据流方向
- `summary`/`decisions` = Output 产物
- `artifacts`/`open_issues` = Output 附件
- `exit_criteria_met` = IPO 退出条件

## 跨技能IPO编排

本技能的跨技能数据流定义在共享文件中：[awkn-shared/cross-skill-ipo.md](../awkn-shared/cross-skill-ipo.md)
统一经验注册表：[awkn-shared/experience-registry.md](../awkn-shared/experience-registry.md)
统一方法卡片索引：[awkn-shared/method-cards-index.md](../awkn-shared/method-cards-index.md)
本地方法卡片：[method-cards/](05_经验沉淀与资产库/references/method-cards/)（4个：DSPBRSE/Clarity Gate/Workflow Handoff/Constitution）

调度角色：天阶功法是唯一的跨阶段调度技能，负责阶段检测、技能路由、Handoff管理和流程恢复。

## 文件保护等级

| 等级 | 含义 | 适用文件 |
|------|------|---------|
| 🔴 绝对保护 | 版本升级时才修改 | SKILL.md 核心定义、00_总控与宪法/constitution/ |
| 🟠 结构锁定 | 仅明确需求时修改结构 | 02_技术与交付主链/phases/、00_总控与宪法/delta-specs/、00_总控与宪法/adapters/、04_武器库与模板库/scripts/ |
| 🟡 追加增长 | 可追加新条目，不改已有 | 03_证据与进化主链/evolution/、05_经验沉淀与资产库/references/、04_武器库与模板库/templates/ |
| 🟢 自由生长 | 自由创建修改 | 04_武器库与模板库/examples/ |

## 原子讲解4层结构 → awkn-工程师

> 已下沉：4层结构 + 讲解流程 → [awkn-工程师/SKILL.md](../awkn-工程师/SKILL.md)

## 质量标准6条 → awkn-审核

> 已下沉：6条质量标准 → [awkn-审核/SKILL.md](../awkn-审核/SKILL.md)

## 吸收子技能库 → awkn-技能治理

> 已下沉：214个子技能分类索引 + 核心技能速查 → [awkn-技能治理/SKILL.md](../awkn-技能治理/SKILL.md)
> 215 个子技能定义（Azure AI、Slack、N8n、LangChain 等）已物理迁移至 awkn-技能治理/absorbed-skills/天阶功法-武器库/。本技能不再保留子技能文件。

## 已下沉的执行文档

> 以下文档已下沉至对应阶段技能，本技能只保留路由指针：
>
> | 原路径 | 现归属 | 说明 |
> |--------|--------|------|
> | ~~02_09_H5发布作战手册~~ | awkn-部署/02_H5发布/ | H5 发布手册已合并至部署技能 |
> | ~~02_10_小程序发布作战手册~~ | awkn-部署/03_小程序发布/ | 小程序发布手册已合并至部署技能 |
> | ~~02_11_代码审查规则~~ | awkn-审核/docs/from-天阶功法/ | 代码审查规则已合并至审核技能 |
> | ~~02_12_设计审查规则~~ | awkn-审核/docs/from-天阶功法/ | 设计审查规则已合并至审核技能 |
> | ~~02_13_安全审查规则~~ | awkn-审核/docs/from-天阶功法/ | 安全审查规则已合并至审核技能 |

## 版本历史

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v3.2.0 | 2026-06-14 | **能力下沉**：04_武器库 215 个子技能定义 → awkn-技能治理；02_09/10 H5+小程序发布手册删除（与 awkn-部署重复）；02_11-13 审查规则 → awkn-审核；05_经验沉淀经验日志归档。Active 文件从 1,309 → 934（-28.6%）。新增「已下沉执行文档」路由指针表 |
| v3.1.1 | 2026-06-14 | **审计报告修复**：版本号三处统一为 v3.1.1；references/ 173 个外部方法论归档至 .archive/（瘦身 11.7%）；新增附录F NestJS+Prisma+BullMQ 技术画像（含队列/异步任务 6 条规范）；DSPBRSE 路由表补 awkn-bug修复大法 + awkn-执行检查；method-cards 路径修复 |
| v3.1.0 | 2026-06-12 | **自治引擎 Phase 2-4**：新增 awkn-自治引擎技能（目标分解+任务队列+决策矩阵+进度追踪+伤疤协议+进化扫描+报告生成器）+ 自触发脚本 + Windows Task Scheduler 注册 |
| v3.0.0 | 2026-06-12 | **自治模式 Phase 1**：从 Meta_Kim 移植三大治理组件 — Compaction Packet（跨会话续接协议）+ DSPBRSE Stage Guard（PreToolUse 阶段守卫）+ Rhythm Conductor（8卡节奏编排+断路器）。天阶功法 v2.9→v3.0，新增自治模式入口 |
| v2.9.0 | 2026-05-30 | **瘦身执行**：Constitution→awkn-prd, Delta Specs→awkn-工程文档, 质量保障+质量标准6条→awkn-审核, 原子讲解4层结构→awkn-工程师, 吸收子技能库214个→awkn-技能治理。SKILL.md从602行瘦身至~490行 |
| v2.8.1 | 2026-05-30 | 新增 `@天阶` 激活名；明确瘦身原则：天阶功法只做跨阶段调度，具体执行能力下沉到对应工作流技能。 |
| v2.8.0 | 2026-05-25 | **ECC融合Phase2**：Handoff JSON Schema（8必填+4可选字段+校验脚本）+ MCP统一管理（17个服务+3级预设+上下文管理规则）+ 并行编排模式（B+Doc/R+Security/S+Monitor） |
| v2.7.0 | 2026-05-24 | **ECC融合Phase1**：引入Hooks自动化系统（10个hook+3级profile）+ Contexts动态注入（5个阶段context），基于ECC架构+AWKN铁律设计 |
| v2.6.0 | 2026-05-20 | 补全方法论索引 + 自进化执行者定义 + core/规则文件入口 + 审查三件套索引 |
| v2.5.0 | 2026-05-19 | **吸收子技能库**：从 antigravity-awesome-skills 吸收 199 个子技能，按 6 大类归入 skills/ |
| v2.4.0 | 2026-05-04 | **架构层升级**：triggers语义描述(14个)、IPO编排层(DSPBRSE→IPO映射+4种编排模式+Handoff→IPO映射)、文件保护等级 |
| v2.3.0 | 2026-05-02 | 新增阶段退出标准、handoff 示例与校验脚本，进一步补齐端到端流程约束 |
| v2.2.0 | 2026-05-02 | 新增跨宿主 adapters 分层，明确面向 Claude Code、Codex、Trae 的适配策略 |
| v2.1.1 | 2026-05-02 | 补齐 Review 根入口，新增跨阶段 handoff 契约与模板，统一总控层对 `awkn-审核` 的引用 |
| v2.1.0 | 2026-04-30 | 融合工程精华：Build铁律 + 系统调试 + 双阶段审查 + Spec归档+Delta格式 + 安全审查清单 |
| v2.0.0 | 2026-04-30 | 重构为工程大脑入口：DSPBRSE七阶段 + Constitution + Clarity Gate + Card Deck + 自进化闭环 |
| v1.1.0 | 2026-04-25 | 增加部署触发词 |
| v1.0.0 | 2026-04-22 | 初始版本，基于天火深度分析 |

---

## 融合入口（v1.0 追加）

### 来自 awkn-agent-architecture（引用入口）

- **触发词**：Agent架构, 智能体架构, 三进程架构, Agent数据流
- **能力描述**：Agent 架构设计参考。从 Alice 工程方法论提炼的三进程架构+分层架构+数据流+配置层级。
- **资产位置**：`awkn-agent-architecture/`（独立技能目录）
- **融合方式**：reference_entry
- **归属层级**：architecture
- **融合日期**：2026-05-25

### 来自 awkn-agent-design（引用入口）

- **触发词**：Agent设计, 智能体设计, Agent哲学, Agent工程范式
- **能力描述**：Agent 设计哲学与工程范式。从 Alice 工程方法论提炼的5大设计哲学+状态优先原则+可丢弃组件+可观测性。
- **资产位置**：`awkn-agent-design/`（独立技能目录）
- **融合方式**：reference_entry
- **归属层级**：architecture
- **融合日期**：2026-05-25
