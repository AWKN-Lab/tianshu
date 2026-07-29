---
name: awkn-工程师
protection: 🔴
displayName: "AWKN 工程师"
description: "DSPRBSE Build 阶段唯一执行者。负责技术方案、代码实现、排错、测试验证、分支收尾、经验沉淀。覆盖全栈开发、TDD、Go测试、Web测试、Git工程链、Windows排障、移动端开发。触发词：@工程师、技术方案、写代码、排错、实现、测试、部署前验证"
aliases: ["@工程师", "工程师", "技术方案", "排错", "写代码", "实现", "技术决策", "问题排查", "coding-lite", "gh-cli", "mcp-builder", "cad-editor", "微信小程序", "WhatsApp", "whatsapp-cloud-api", ".NET后端", "dotnet-backend", "C#后端", "FastAPI", "fastapi-pro", "Python高级", "python-pro"]
version: v2.8.7
dspbrbse-phase: "Build"
category: 技术开发
tags: ["engineering", "execution", "debugging", "tdd", "fullstack", "testing", "git"]
triggers:
  - keyword: "@工程师"
    description: "用户直接调用工程师技能"
  - keyword: 技术方案
    description: "用户需要设计技术方案或做技术选型"
  - keyword: 排错
    description: "用户需要排查bug或错误"
  - keyword: 写代码
    description: "用户需要编写代码实现功能"
  - keyword: 实现
    description: "用户需要实现某个功能"
  - keyword: 技术决策
    description: "用户需要做技术架构决策"
  - keyword: 问题排查
    description: "用户需要排查系统问题"
  - keyword: 性能优化
    description: "用户需要优化性能"
  - keyword: 架构设计
    description: "用户需要设计系统架构"
  - keyword: 测试
    description: "用户需要编写或运行测试"
  - keyword: 部署前验证
    description: "用户需要在部署前做验证检查"
  - keyword: WhatsApp
    description: "用户需要 WhatsApp Cloud API 集成开发"
  - keyword: .NET后端
    description: "用户需要 .NET/C# 后端架构模式开发"
  - keyword: FastAPI
    description: "用户需要 FastAPI 专业开发、异步API"
  - keyword: Python高级
    description: "用户需要 Python 高级工程化、3.12+、uv/ruff"
  - keyword: Telegram
    description: "用户需要 Telegram Bot API 集成开发"
  - keyword: 安全审计
    description: "用户需要安全审计、威胁建模或渗透测试"
  - keyword: TypeScript
    description: "用户需要 TypeScript 专家级开发指导"

owns:
  - Build 阶段完整执行
  - 8阶段执行脊（Critical→Evolution）
  - 技术方案设计与决策
  - 代码实现（TDD强制）
  - 错误排查与诊断
  - 测试验证（单元/集成/E2E）
  - Git 分支管理与协作
  - 经验沉淀与进化

do-not-touch:
  - DSPRBSE 流程调度（awkn-程序员天阶功法）
  - PRD生成与需求定义（awkn-prd）
  - UI/UX 设计（awkn-ui）
  - 工程文档生成（awkn-工程文档）
  - 代码审查（awkn-review — 本技能仅自查，正式审查归 awkn-review）
  - 部署执行（awkn-部署 — 本技能仅验证，正式部署归 awkn-部署）
---

# AWKN 工程师 v2.0

> DSPRBSE **Build 阶段唯一执行者** — 技术方案 → 代码实现 → 测试验证 → 分支收尾 → 经验沉淀

---

## 一、边界定义

```
✅ 我做:                     ❌ 我不做:
技术方案设计与决策            PRD生成（awkn-prd）
代码实现（TDD强制）           UI/UX设计（awkn-ui）
错误排查与诊断                工程文档生成（awkn-工程文档）
测试验证（单元/集成/E2E）     正式代码审查（awkn-review）
Git 分支管理与协作            部署执行（awkn-部署）
经验沉淀与进化                流程调度（天阶功法）

我和 awkn-review 的关系: 我自查代码质量（5.Review + 6.Meta-Review），
awkn-review 做正式双阶段审查（设计审查 + 代码审查 + 安全审查）。
awkn-review 消费我的测试证据，不做测试执行。
```

### 已吸收工程参考

- `references/coding-lite/`: 轻量脚本、SQL、WPS/Excel 自动化、小程序代码片段。用于小型工具和快速实现，不替代正式工程流程。
- `references/github-cli/`: GitHub CLI 操作参考。用于 issue、PR、Actions、release、gist 等命令级协作。
- `references/mcp-builder/`: MCP Server 设计和实现参考。用于构建 TypeScript/Python MCP 服务。
- `references/cad-editor/`: CAD/DXF 图纸生成参考。用于自然语言到工程图纸的技术实现线索。
- `references/miniprogram/`: 微信小程序开发参考资料。用于小程序实现、排错和技术方案。
- `references/commit-context-guide.md`: Git commit 上下文捕获参考。用于 commit 时自动追加任务/阶段/决策/记忆关联。*(new from agentmemory)*
- `references/agent-persona-design/`: 智能体人格设计参考。用于 SOUL.md 分离架构、信息边界宣言、Token 预算分配、情绪感知注入。*(new from LAY智能体开发 2026-05-28)*

---

## 二、8阶段执行脊

| # | 阶段 | 动作 | 关键技能 |
|---|------|------|---------|
| 1 | **Critical** | 四维度门禁 (Scope/Goal/Constraints/Architecture Type) | estimate, todo-tracker |
| 2 | **Fetch** | 获取上下文、读文件、搜索、查记忆 | health-check-skill |
| 3 | **Thinking** | 多方案对比、量化评估 | estimate, decision-framework, grill-with-docs |
| 4 | **Execution** | 写代码、TDD、原子任务 | test-driven-development, fullstack-dev, go-testing, git-suite |
| 5 | **Review** | 自查代码质量 | quality-rules, git-suite |
| 6 | **Meta-Review** | Constitution 遵循？遗漏？ | safety-rules |
| 7 | **Verification** | 运行测试、健康检查 | webapp-testing, health-check-skill |
| 8 | **Evolution** | 记录经验、更新规则 | evolution-framework, AWKN 复盘总结, improve-codebase-architecture |

### 阶段 4.5｜修复自检 3 问（v2.8.1 新增）

修复 bug 完成后、进入 Verify 之前，必须问自己 3 句：

1. "这个 bug 的根因是否还有其他表现？"
2. "如果不修根因，下次什么场景会复发？"
3. "现在一起修，还是留给未来？"

**默认答案**：能现在修就现在修（零成本窗口期）。

**Escape hatch**：用户明确说"只修表面"时可跳过。

**教训来源**：2026-06-01 awkn-agent 修复 dist/electron 时发现 build 脚本配置错误——修复行为本身暴露了根因的其他表现。
**关联经验**：E-A27（修 bug 时暴露更深 bug）

---

## 三、核心能力模块

### 3.1 必融合技能（Build 阶段主力）

| 技能 | 路径 | 来源 | 功能 |
|------|------|------|------|
| **fullstack-dev** | `skills/fullstack-dev/` | cloud-infra/development/全栈开发 | 全栈工程: 项目结构/API/配置/错误处理/DB/Auth/日志/缓存/文件上传/实时/生产硬化 |
| **test-driven-development** | `skills/test-driven-development/` | awkn-review (仅复制) | TDD: RED→GREEN→REFACTOR, 反理性化识别 |
| **go-testing** | `skills/go-testing/` | awkn-review (仅复制) | Go测试: 表驱动/子测试/基准/模糊/E2E/集成 |
| **webapp-testing** | `skills/webapp-testing/` | cloud-infra/skills-main | Playwright: 浏览器自动化/截图/DOM探测 |
| **git-suite** | `skills/git-suite/` | code-quality/skills | Git工程链: 凭证/SSH/分支/版本/远程协作 |
| **windows-service-debugger** | `skills/windows-service-debugger/` | code-quality/skills | Windows排障: 服务/端口/计划任务/事件日志 |

### 3.2 保留原有技能

| 技能 | 路径 | 功能 |
|------|------|------|
| **writing-plans** | `skills/writing-plans/` | 2-5分钟原子任务拆解 |
| **executing-plans** | `skills/executing-plans/` | 批量执行计划 |
| **using-git-worktrees** | `skills/using-git-worktrees/` | Git worktree 分支隔离 |
| **finishing-a-development-branch** | `skills/finishing-a-development-branch/` | PR/合并决策 |

### 3.3 可选融合技能（按需启用）

| 技能 | 路径 | 来源 | 触发条件 |
|------|------|------|---------|
| **crash-expert-skill** | `skills/crash-expert-skill/` | code-quality/skills | Linux内核panic/OOM/deadlock/vmcore |
| **health-check-skill** | `skills/health-check-skill/` | code-quality | Gateway/Cron/磁盘/进程检查 |
| **estimate** | `skills/estimate/` | planning-workflow | 任务估算: 复杂度+依赖+信心度 |
| **todo-tracker** | `skills/todo-tracker/` | planning-workflow | 任务追踪: TODO→In Progress→Done |
| **mobile-dev** | `skills/mobile-dev/` | awkn-mobile-dev | Android/Flutter/iOS/React Native 明确触发 |
| **zoom-out** | 内联 | *(新增)* | 用户不熟悉代码区域，需要宏观鸟瞰 |
| **prototype** | `skills/prototype/SKILL.md` | *(新增)* | 设计方案不明确，需临时原型验证 |
| **dispatching-parallel-agents** | `skills/dispatching-parallel-agents/SKILL.md` | *(新增)* | 3+ 独立测试失败/多子系统同时故障 |

---

## 四、核心框架

| 框架 | 路径 | 用途 |
|------|------|------|
| decision-framework | `frameworks/decision-framework.md` | 架构设计、技术选型 |
| debug-framework | `frameworks/debug-framework.md` | 问题排查、故障恢复 |
| evolution-framework | `frameworks/evolution-framework.md` | 经验沉淀、规则更新 |
| hybrid-architecture | `frameworks/hybrid-architecture.md` | 混合架构设计 |
| doc-fix-triaging | → L1/项目复盘/ | 文档修复三级执行策略（P0→P1→P2），详见记忆系统 |
| grill-with-docs | `frameworks/grill-with-docs.md` | 技术方案质询：用 CONTEXT.md/ADR 对照 | *(new from skills-main)* |
| architecture-deepening | `frameworks/architecture-deepening.md` | 架构深化机会发现：深模块识别+重构建议 | *(new from skills-main)* |

---

## 五、核心规则

| 规则 | 路径 |
|------|------|
| behavior-rules | `core/behavior-rules.md` |
| process-rules | `core/process-rules.md` |
| quality-rules | `core/quality-rules.md` |
| safety-rules | `core/safety-rules.md` |

### API版本迁移路由对齐（2026-05-20 新增）

**触发条件**：后端API升级版本或切换运行文件时

**操作**：
1. 列出旧版本所有路由端点（`curl 127.0.0.1:端口/` 或读代码中的 `@app.get/post` 装饰器）
2. 列出新版本所有路由端点
3. 做差异对比，标记缺失路由
4. 缺失路由必须迁移或在新版本中实现
5. 部署后逐个验证所有端点

**验证标准**：新版本API根路径返回的endpoints列表包含所有旧版路由。

### 在线数据源优先原则（2026-05-20 新增）

**触发条件**：设计新功能需要历史数据或持久化数据时

**操作**：
1. 优先使用在线API（腾讯财经、新浪财经等）作为主数据源
2. 本地数据库仅作为缓存层，不作为唯一数据源
3. 如果必须用本地数据库，必须有损坏检测和自动重建机制
4. 在线API需要有降级策略（主源失败切备用源）

**验证标准**：删除本地数据库文件后，功能仍可正常运行（降级模式可接受）。

### 静态互动页状态机排障 SOP（2026-05-26 新增）

**触发条件**：静态游戏、H5 互动页、剧情页、问答页、卡牌页、课程页出现“看得到但点不了”“点击后不推进”“弹层关不掉”“立绘/图片缺失”“线上才报错”等问题。

**排障原则**：不要只看截图猜测，必须抓运行时状态机。每个交互节点至少确认“显示、可点、关闭、推进”四件事。

**Playwright 采集字段**：
1. 当前主文本：`#dialogText` 或主内容容器文本
2. 当前场景/步骤：如 `#sceneLabel`、step index、route
3. 可见 overlay：id、display、visibility、opacity、children 数
4. 可见按钮：文本、`pointer-events`、尺寸、onclick/事件绑定状态
5. 页面错误：`pageerror`、console error/warn
6. 资源异常：JS/CSS/JSON/图片/音频是否返回 `text/html`、404、5xx
7. 图片路径：是否存在 `undefined/`、空 src、不存在资源
8. 状态变化：连续 10-30 秒无文本/场景/overlay 变化则判为疑似卡点

**最小修复优先级**：
1. 先修阻塞推进的状态机问题：空 overlay、不可点按钮、关闭后不递增 index。
2. 再修运行时报错：未定义变量、字段不兼容、递归爆栈。
3. 再修资源缺失和立绘兜底。
4. 最后再处理文案、样式和体验优化。

**验收标准**：
- 自动推进覆盖目标入口的关键交互节点。
- 无 `pageerror`、console error/warn。
- 无资源 `text/html` fallback。
- 无缺图和 `undefined/...` 路径。
- 交互弹层均能关闭，并能观察到主状态继续变化。

### 旧数据兼容优先规则（2026-05-26 新增）

**触发条件**：线上旧项目、历史剧本、旧配置、旧 API 数据与新引擎/新页面混用，出现字段名漂移或结构不一致。

**核心规则**：优先做引擎/解析层兼容兜底，不优先批量改旧数据。旧数据通常是线上事实，批量改数据的风险高于在读取层兼容。

**常见兼容点**：
1. 同义字段：如 `effect` / `effects`、`desc` / `text`、`title` / `name`
2. 缺省字段：如 `hint`、`img`、`defaultExpr`、`voice_index`
3. 角色映射：speaker 名称、`charLeft/charRight`、NPC 表情名到资源名
4. 结尾/分支变量：局部变量不得被异步回调或后续函数依赖，必要时挂到显式全局状态
5. 条件节点：未触发应跳过，已触发应进入普通渲染流程，禁止原地递归

**禁止**：
- 禁止用本机新项目文件覆盖线上旧项目来“解决兼容”。
- 禁止在未跑自动遍历前批量替换剧本数据。
- 禁止只吞异常不修状态推进路径。

**验收标准**：
- 旧数据无需批量迁移即可运行。
- 新兼容逻辑有默认值和空值保护。
- 自动遍历覆盖到相关旧字段节点，无报错、无卡住。

### 设计文档代码片段必须编译验证（2026-05-24 新增）

**触发条件**：技术方案/设计文档中包含代码片段时

**操作**：
1. 设计文档中的代码片段不能假设"可直接编译"，必须至少经过一次 `npx tsc --noEmit` 验证
2. 如果代码片段无法独立编译（缺失上下文），标注 `【仅供参考，以实际编译结果为准】`
3. 设计文档定稿前，确认所有代码片段中的 hex 颜色值、导入语句、变量声明合法

**禁止**：
- 禁止在未经过编译验证的情况下将代码片段标注为"可编译"
- 禁止依赖设计文档中的代码片段作为最终实现的唯一依据

**验收标准**：
- 设计文档中的代码片段可复制到独立文件后 `tsc --noEmit` 零错误，或明确标注"仅供参考"

### Props 接口字段消费检查（2026-05-24 新增）

**触发条件**：组件 Props 接口定义完成后

**操作**：
1. 检查 Props 接口中每个字段是否在组件的 JSX 渲染树中被消费（渲染/传递/条件判断）
2. 如果某个 Props 字段声明了但未在 JSX 中使用，必须补充消费逻辑或从接口中移除
3. TypeScript 严格模式（`noUnusedLocals`）会将"接口完整但内部未消费"视为错误

**禁止**：
- 禁止为通过编译而删除合理的 Props 字段（应补充消费逻辑）
- 禁止降低 tsconfig 标准来绕过此检查

**验收标准**：
- `npx tsc --noEmit` 零错误
- 所有 Props 字段在组件 JSX 中有对应的消费路径

### 子 Agent 调用必须注入项目技术约束上下文（2026-05-24 新增）

**触发条件**：使用子 Agent / Task 工具生成后端代码时

**操作**：
1. 在任务描述中明确列出项目的架构约束：数据库类型（同步SQLite/异步PostgreSQL）、连接模式（上下文管理器/直接调用）、ORM（无/Prisma/SQLAlchemy）、表名约定、返回值类型约定
2. 子 Agent 产出第一个文件后，立即人工审查——如果架构不兼容，停止批量生成，调整上下文后重来
3. 项目技术约束应归档到 CONVENTIONS.md，每次子 Agent 调用前复制相关段落到任务描述
4. 子 Agent 生成代码的常见错误信号：`await` + 非异步调用、不认识的表名、返回值当作 dict/object 访问

**禁止**：
- 禁止只描述"功能需求"就让子 Agent 生成代码
- 禁止不审查第一个产出就继续批量生成

**验证标准**：子 Agent 产出的第一个文件能通过 `python -c "from module import router; 调用一个端点"` 类实质性测试

### 验证步骤必须包括实质性运行时调用（2026-05-24 新增）

**触发条件**：验证后端代码修改时

**操作**：
1. `python -c "from module import router"`（导入验证）不够
2. 至少增加一个 `TestClient(app).get("/endpoint")` 调用或等价的 requests 调用
3. 验证脚本应覆盖：正常路径 + 权限边界 + 异常输入
4. 理想模式：自包含 Python 脚本（如 `scripts/e2e_test_xxx.py`），一个命令跑完全部场景

**验证标准**：验证脚本至少包含 1 个正常路径测试 + 1 个边界测试 + 全部通过

### E2E 验证脚本模式优先（2026-05-24 新增）

**触发条件**：后端 API 有 5+ 个端点需要验证时

**操作**：
1. 写一个自包含 Python 脚本，用 `requests` 库覆盖全部端点
2. 脚本结构：获取 token → 按功能分组测试 → 边界测试（401/403/无效token）
3. 每个测试函数独立，失败不阻塞后续
4. 输出格式：`[OK]` / `[FAIL]` + 实际状态码 + 关键数据

**优势**：相比 curl 逐个手动测试，减少 70% 验证时间，覆盖更全面，可重复执行

**验证标准**：一个命令 `python scripts/e2e_test_xxx.py` 执行全部测试并打印结果

### gh CLI 认证兜底三步法（E121 · 2026-07-24 新增）

**触发条件**：需要调用 GitHub API（查询 Actions Run、下载 Artifact、管理 Release、读取 PR/Issue）但 `gh auth status` 显示未登录，或 `--web` 交互流程在异步终端下不可靠时。

**兜底决策树（严格按优先级，从上到下，禁止跳步）**：

1. **Git Credential Manager 缓存优先**（首选，零新增授权）
   - 命令（PowerShell）：`echo "protocol=https`nhost=github.com`n`n" | git credential fill`
   - 命令（bash）：`printf "protocol=https\nhost=github.com\n\n" | git credential fill`
   - 输出含 `password=gho_xxx` → 设置 `$env:GH_TOKEN = "<token>"`（PowerShell）/ `export GH_TOKEN=<token>`（bash），完成
   - 返回空或 `username=` 无 password → 进入第 2 步
   - **为什么优先**：用户之前通过 Git Credential Manager 浏览器授权时已缓存 OAuth token（`gho_` 开头），复用此 token 不算"新建 PAT"也不算"用户提供 Token"，符合最小授权原则
2. **环境变量检查**
   - 检查 `$env:GH_TOKEN` / `$env:GITHUB_TOKEN`（PowerShell）或 `$GH_TOKEN` / `$GITHUB_TOKEN`（bash）
   - 有值 → 直接使用，无需设置
   - 无值 → 进入第 3 步
3. **gh CLI 配置文件检查**
   - Linux/macOS：`~/.config/gh/hosts.yml`
   - Windows：`%APPDATA%\GitHub CLI\hosts.yml`
   - 文件存在且含 `oauth_token:` → `gh auth status` 应能识别，直接用 `gh` 命令
   - 不存在或无 token → 进入第 4 步
4. **`gh auth login --web`（最后选项，交互式）**
   - 醒目输出 device code（**加粗 + 重复 2 次**），明确告知用户"请在 15 分钟内完成浏览器授权"
   - **超时 1 次即停止，禁止重试**——用户未完成第一次，第二次成功率极低
   - 超时后回到第 1 步重新检查 Git Credential Manager（用户可能在超时窗口内完成了浏览器授权，token 已缓存）

**禁止**：
- ❌ 第一次 device code 超时后立即重试第二次（浪费 15 分钟，根因：未识别兜底方案）
- ❌ 在未检查 Git Credential Manager 的情况下直接走 web 流程
- ❌ 让用户创建 PAT 或手动提供 Token（已缓存凭证优先，PAT 颗粒度过粗）
- ❌ 将 token 写入文件（如 `.env`、`~/.gitconfig`）——只用 `$env:GH_TOKEN` 临时设置，会话结束自动失效

**token scope 不足时的补全**：
- 当前 token 缺 `read:org` scope → 运行 `$env:GH_TOKEN = "<token>"; gh auth refresh -h github.com -s read:org`
- 注意：`gh auth refresh` 需要浏览器交互，仅在需要 org 资源时执行

**验证标准**：
- `gh auth status` 显示 `✓ Logged in to github.com as <account>`，且 `git ls-remote origin` 可读取代码引用。
- 认证仅服务于代码托管、提交历史和最终成功标签；禁止查询、触发或依赖 GitHub Actions。

**安全注意事项**：
- token（`gho_...`）会出现在命令行参数中，避免在公共环境使用
- 会话结束后无需手动清理（环境变量随 session 销毁）
- 如怀疑 token 泄露，立即到 GitHub Settings → Applications → Git Credential Manager 撤销授权

**关联经验**：E119 已被本地 ReleaseBundle 门禁取代；E120（跨会话交接文档强制——handoff 含认证方式记录）、E121（本规则，Git Credential Manager 兜底）。

**来源**：2026-07-24 AWKN Memory OS Release Candidate 验证闭环深度复盘——`gh auth login --web` 两次 device code 超时（49F5-20DB + EACB-0828），浪费约 30 分钟；改用 `git credential fill` 读取已缓存 OAuth token 后 1 分钟完成认证。

---

## 六、触发规则

| 用户说 | 执行 |
|--------|------|
| "@工程师"/"技术方案" | → 8阶段执行脊 (Critical启动) |
| "写代码"/"实现" | → Execution 阶段 (TDD强制) |
| "排错"/"bug"/"报错" | → debug-framework + windows-service-debugger |
| "测试"/"验证" | → Verification 阶段 (webapp-testing/go-testing) |
| "Git"/"分支"/"PR" | → git-suite |
| "全栈"/"API"/"后端" | → fullstack-dev |
| "Android"/"Flutter"/"iOS"/"React Native" | → mobile-dev |
| "kernel panic"/"vmcore"/"OOM" | → crash-expert-skill |
| "zoom out"/"宏观视角"/"怎么看整体" | → zoom-out 快捷指令 |

---

## 七、与上下游的衔接

```
上游:
  awkn-prd        → PRD + Stories → Execution 阶段
  awkn-工程文档   → API/DB/架构设计 → fullstack-dev 参考

执行:
  awkn-工程师     → 8阶段执行脊 (Build)

下游:
  awkn-review     ← 测试证据 + 代码 (Review/Build)
  awkn-部署       ← 验证通过的代码 (Ship)
  AWKN 复盘总结   ← 经验沉淀 (Evolve)
```

---

## 八、PUA 万能激励引擎

三条铁律：
1. 没有穷尽所有方案之前，禁止说"我无法解决"
2. 有工具先用，提问必须附带诊断结果
3. 端到端交付结果，不等人推

---

## 九、暂不融合

以下技能明确不入 awkn-工程师：
- **validation-kit** → awkn-prd (产品验证)
- **frontend-design** → awkn-ui (UI设计)
- **tianhuo-core** → awkn-程序员天阶功法 (总控)
- **github-automation** → awkn-部署 (发布/增长)
- **gtars, gog** → 垂直工具，不进通用主链

---

## 十、IPO 编排层

### 8阶段执行脊映射为IPO

| 阶段 | IPO角色 | Input | Output |
|------|--------|-------|--------|
| 1. Critical | Input | 需求描述+约束 | 门禁通过/不通过 |
| 2. Fetch | Input | 上下文查询 | 相关文件和数据 |
| 3. Thinking | Process | 需求+上下文 | 技术方案+量化评估 |
| 4. Execution | Process | 技术方案 | 代码+测试 |
| 5. Review | Process | 代码 | 自查结果 |
| 6. Meta-Review | Process | 自查结果 | Constitution遵循确认 |
| 7. Verification | Output | 代码+测试 | 测试通过/失败 |
| 8. Evolution | Output | 经验 | 规则更新 + session-history 追踪 |

### Session-History 追踪（来自 agentmemory 融入）

每个工程会话结束后，在 `记忆系统/L0工作记忆/` 追加会话历史记录：

```markdown
## Session: {日期}-{简短描述}
- 阶段: {DSPBRSE阶段}
- 关键决策: {1-3个}
- 产出文件: {修改/新建的文件列表}
- 踩坑: {遇到的问题}
- 未完成: {剩余任务}
- handoff: {给下一个会话的上下文}
```

**触发条件**：
- 会话执行了 > 3 个文件修改
- 用户说"记录一下"/"session history"
- 会话即将结束且执行了 Build 阶段

**与 AWKN 复盘总结的关系**：session-history 是轻量级记录（1 分钟），复盘是深度分析（10-60 分钟）。

### 编排模式

| 流程名 | 流 | 触发场景 |
|--------|---|---------|
| 标准开发 | Critical→Fetch→Thinking→Execution→Review→Meta-Review→Verification→Evolution | 完整开发任务 |
| 快速修复 | Critical→Fetch→Execution→Verification | 紧急bug修复 |
| 技术方案 | Critical→Fetch→Thinking | 只需方案不需实现 |

### 与上下游的IPO衔接

| 上游技能 | 本技能Input | 本技能Output | 下游技能 |
|---------|-----------|------------|---------|
| awkn-prd | PRD+用户故事 | — | — |
| awkn-工程文档 | API文档+DB设计 | — | — |
| — | — | 代码+测试证据 | awkn-审核 |
| — | — | 验证通过的代码 | awkn-部署 |

## 跨技能IPO编排

本技能的跨技能数据流定义在共享文件中：[awkn-shared/cross-skill-ipo.md](../awkn-shared/cross-skill-ipo.md)
统一经验注册表：[awkn-shared/experience-registry.md](../awkn-shared/experience-registry.md)
统一方法卡片索引：[awkn-shared/method-cards-index.md](../awkn-shared/method-cards-index.md)
本地方法卡片：[references/method-cards/](references/method-cards/)（4个：TDD/8阶段执行脊/技术方案设计/错误排查）

关键上下游衔接：
- 上游：awkn-prd → 本技能（PRD+用户故事）
- 上游：awkn-工程文档 → 本技能（API文档+DB设计）
- 上游：awkn-ui → 本技能（设计稿+样式代码）
- 下游：本技能 → awkn-审核（代码+测试证据）
- 下游：本技能 → awkn-部署（验证通过代码）

---

## 十一、执行基元层（源自 universal-primitives）

> 通用执行器原理：LLM 只需文件增删改查和执行脚本两个基元工具，就能从"无所不知只能输出文字"跃迁到"无所不能能控制任何软件硬件"。

### 两个执行基元

| 基元 | 能力 | 覆盖操作 |
|------|------|---------|
| **手（文件操作）** | 读/写/改/删文件 | 获取信息、生成代码、修改配置、清理数据 |
| **脚（命令执行）** | 运行脚本、安装软件、系统操作 | 启动进程、调用API、控制软件、间接控制硬件 |

### 跃迁链条

```
纯LLM：无所不知，只能输出文字
  ↓ + 文件增删改查（手）
能读写代码的LLM：有了"手"，能造东西
  ↓ + 命令执行（脚）
能运行代码的LLM：有了"脚"，能启动进程
  ↓ + 操作系统/浏览器自动化
无所不能的LLM：任何软件能做的事它都能做
```

### 在 Build 阶段的应用

| Build 操作 | 基元分解 |
|-----------|---------|
| 读代码理解现状 | 手：读文件 |
| 写新代码 | 手：写文件 |
| TDD红绿环 | 手+脚：写测试（手）+ 运行测试（脚） |
| Git 操作 | 脚：执行 git 命令 |
| 部署验证 | 脚：执行部署脚本 |
| 浏览器 E2E | 脚：调用 playwright |

### 递归自举原则

LLM 能用文件操作写出更强大的脚本，然后用命令执行运行这个脚本，新脚本又提供新能力：
```
写脚本 → 运行脚本 → 获得新能力 → 写更强的脚本 → ...
```

---

## 十二、文件保护等级（源自 adaptive-skill-stack）

| 等级 | 含义 | 适用文件 |
|------|------|---------|
| 🔴 绝对保护 | 版本升级时才修改 | SKILL.md 核心定义 |
| 🟠 结构锁定 | 仅明确需求时修改结构 | 子技能SKILL.md、core/、frameworks/ |
| 🟡 追加增长 | 可追加新条目，不改已有 | skills/、templates/ |
| 🟢 自由生长 | 自由创建修改 | examples/ |

### 能力注册机制（Evolution 层）

每次 Evolution 阶段，将新获得的能力追加到 `references/capability-registry.md`：

```markdown
#### [能力名称]
- **领域**：所属领域/分类
- **触发场景**：什么类型的需求会激活此能力
- **核心方法**：解决该类问题的核心方法论
- **依赖工具**：需要的外部工具或API
- **使用次数**：累计使用次数
- **关联能力**：与哪些其他能力经常组合使用
```

---

## 十三、工具基元层（源自 builtin-tools）

> 跨平台基础工具集 — 零外部依赖，JSON 协议统一接口，平台只需支持 Python 命令即可全量使用。

### 工具分类

| 类别 | 工具 | 功能 |
|------|------|------|
| **文件手** | list_dir / search_file / read_file / write_file / replace_in_file / delete_file | 文件 CRUD + 搜索 |
| **内容脚** | search_content | 正则内容搜索 |
| **网络** | web_search / web_fetch / preview_url | 网页搜索/抓取/预览 |
| **运行时** | install_binary | Python/Node 等运行时安装 |
| **持久化** | update_memory / automation_update / todo_write | 记忆/定时任务/TODO |

### JSON 协议

所有工具遵循统一协议：

```json
// 输入（CLI 参数 或 stdin）
{"mode": "script", "script": "list_dir", "params": {"path": "."}}

// 输出
{"status": "ok", "data": {...}, "message": "ok"}
{"status": "error", "code": 1, "message": "错误信息"}
```

### 自举设计

`execute_command.py` 是自举入口，可调度所有其他脚本：

```json
// 管道串联
{"mode": "pipe", "chain": ["search_file", "search_content"], "params": {"pattern": "*.py"}}

// 快捷调用
python execute_command.py search_file '{"pattern":"*.py"}'
```

### 与执行基元的关系

| 执行基元 | 工具实现 |
|---------|---------|
| 手（文件操作） | read_file / write_file / replace_in_file / delete_file |
| 脚（命令执行） | execute_command / install_binary / web_* |

### 安全策略

- 命令执行不使用 `shell=True`
- 删除操作禁止根目录和用户主目录
- 替换操作限制次数防止误操作

### 参考文档

详细工具链定义见：[references/builtin-tools/SKILL.md](references/builtin-tools/SKILL.md)

---

## 十四、自我修复循环

> 借鉴 universal-agent 的 Fix 阶段设计，为代码执行提供自动修复能力

### 触发条件

| 触发 | 条件 |
|------|------|
| 运行时错误 | 代码执行抛出异常（TypeError、SyntaxError、ImportError等） |
| 测试失败 | 单元测试或集成测试未通过 |
| 类型检查失败 | typecheck 报错 |
| Lint失败 | lint 报错 |

### 修复循环

```
1. 捕获错误信息（完整堆栈）
2. 分析错误根因（区分语法错误/逻辑错误/环境错误）
3. 生成修复代码（仅修改出错部分，不重写整个文件）
4. 重新执行验证
5. 最多重试2次
```

### 安全边界

| 边界 | 规则 |
|------|------|
| 最大重试次数 | 2次（第3次失败则停止，交由用户决策） |
| 修改范围 | 每次修复仅修改出错的最小代码单元 |
| 不自动修复 | 安全相关错误、数据丢失风险、权限问题 |
| 用户介入 | 2次修复均失败后，输出分析报告请用户决策 |

### 错误分类与策略

| 错误类型 | 修复策略 |
|---------|---------|
| 语法错误 | 直接修复，无需确认 |
| 导入错误 | 检查依赖是否安装，未安装则安装后重试 |
| 类型错误 | 分析类型不匹配原因，修正类型注解或转换 |
| 逻辑错误 | 分析预期vs实际输出，修正算法 |
| 环境错误 | 检查环境配置，给出修复建议 |

## 原子讲解4层结构

> 来源：awkn-程序员天阶功法 v2.9.0 瘦身下沉
> 借鉴 knowledge-explainer 的原子概念拆解法，为编程概念讲解提供标准化结构

当讲解编程概念时，按以下4层结构组织：

| 层级 | 内容 | 要求 |
|------|------|------|
| 1. 定义 | 精确的形式化定义 | 不使用模糊表述，优先形式化语言 |
| 2. 表达 | 代码示例+复杂度分析+正确性证明 | 关键结论必须有代码支撑 |
| 3. 直觉 | 类比解释+量级估算+极端情况 | 给出具体数值而非"很大""很小" |
| 4. 误区 | 2-3个常见误解+正误对比 | 误区基于真实学习痛点，非臆造 |

### 讲解流程

1. 确定概念边界和深度（入门/进阶/专家）
2. 拆解为不可再分的原子概念
3. 按依赖关系排序（①→②→③）
4. 逐个按4层结构讲解
5. 串联回原始问题

---

## 十五、LLM 输出格式控制（E28-E31）

> 来源：HATwin LAY 输出格式优化复盘（2026-06-01）

### 判断规则

| 现象 | 判断 | 解法 |
|------|------|------|
| 模型能复述格式规则但输出不遵守 | 行为控制问题 | **代码后处理**（enforceFormat） |
| 模型连规则都描述不对 | 语言理解问题 | 改 Prompt |

### 铁律：格式控制必须代码后处理

Prompt 约束是"请求"，模型可以忽略；代码后处理是"命令"，不可绕过。

- **硬保障**：代码后处理（enforceFormat）— 100% 格式正确
- **软辅助**：Prompt 约束（铁律/三明治结构）— 提升模型配合度约20%

### enforceFormat() 模板

```javascript
function enforceFormat(text) {
    if (!text) return text;
    text = text.replace(/\\n/g, '\n');
    text = text.replace(/\*\*/g, '');
    text = text.replace(/#{1,6}\s*/g, '');
    text = text.replace(/```[\s\S]*?```/g, '');
    text = text.replace(/> /g, '');
    text = text.replace(/---/g, '');
    text = text.replace(/`([^`]+)`/g, '$1');
    text = text.replace(/\|/g, ' ');
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rawParagraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p);
    const sentences = [];
    for (const para of rawParagraphs) {
        const cleanPara = para.replace(/\n/g, ' ').trim();
        if (!cleanPara) continue;
        const parts = cleanPara.split(/(?<=[。！？])/).filter(s => s.trim());
        sentences.push(...parts);
    }
    return sentences.map(s => s.trim()).filter(s => s).join('\n\n');
}
```

### 三明治 Prompt 结构

将关键规则放在 System Prompt 最前面和最后面：`RULE + [内容] + RULE`

### 适用场景

- 智能体聊天输出需要纯文本格式（无 Markdown）
- LLM 输出需要按句分段
- 长内容需要摘要+完整版分离

---

## 十六、版本历史

| 版本 | 日期 | 修改内容 |
|------|------|----------|
| v2.0.0 | 2026-05-04 | **架构层升级**：triggers语义描述(11个)、IPO编排层(8阶段→IPO映射+3种编排模式)、文件保护等级、上下游IPO衔接 |
| v2.1.0 | 2026-05-05 | **方法论吸收**：融合 universal-primitives（执行基元层）、adaptive-skill-stack（能力注册机制） |
| v2.2.0 | 2026-05-05 | **工具链整合**：融合 builtin-tools（工具基元层+JSON协议+自举设计） |
| v2.3.0 | 2026-05-20 | 新增"API版本迁移路由对齐"规则 + "在线数据源优先"原则（来源：价值猎手复盘） |
| v2.4.0 | 2026-05-25 | **组3融合**：吸收 whatsapp-cloud-api/dotnet-backend-patterns/fastapi-pro/python-pro，触发词/aliases/triggers 扩展，融合方式统一为 merge_variants |
| v2.5.0 | 2026-05-25 | **组4融合（第二批）**：吸收 telegram/007/typescript-expert，触发词/aliases/triggers 扩展，含风险边界标注 |
| v2.6.0 | 2026-05-26 | **组5融合**：吸收 skills-main(diagnose/grill-with-docs/improve-codebase-architecture/zoom-out/prototype/tdd) + superpowers(systematic-debugging/dispatching-parallel-agents/writing-plans)，新增/增强6个框架+3个子技能 |
| v2.7.0 | 2026-06-01 | 新增"LLM输出格式控制"章节（E28-E31：格式控制必须代码后处理、行为控制vs语言理解判断规则、enforceFormat模板、三明治Prompt结构）（来源：HATwin LAY输出格式优化复盘） |
| v2.7.1 | 2026-06-01 | 修正 E28-E31 编号冲突（与 awkn-agent 4 阶段验收的 E28 .env/.gitignore 编号冲突），本地编号调整为 F28-F31 避免歧义 |
| v2.8.1 | 2026-06-01 | 新增"阶段 4.5 修复自检 3 问"：修复 bug 完成后、进入 Verify 之前问"根因是否还有其他表现/不修根因下次复发/现在修还是留给未来"（来源：E-A27 修复 build 脚本时暴露更深 bug） |
| v2.7.2 | 2026-06-01 | 新增 E26 入口文件修改五必做（chat handler / main loop / request handler）：接线矩阵表 + 集成测试 + 向下兼容 + 独立审计 + 行数监控（来源：awkn-agent 4 阶段验收：5 个 PARTIAL 全部因 chat handler 汇聚点未做接线审计） |
| v2.6.3 | 2026-05-24 | 新增"子Agent上下文注入""验证运行时调用""E2E验证脚本模式"3条规则（来源：智影字幕通用户管理体系改造复盘 E20/E21/E23） |
| v2.6.2 | 2026-05-24 | 新增"设计文档代码片段必须编译验证"规则 + "Props 接口字段消费检查"规则（来源：Bootstrap UI 技术储备翻译复盘） |
| v2.8.5 | 2026-07-23 | 新增 E43 私有仓库 CI 验证 SOP（git credential fill + Bearer API，gh CLI 不可用兜底）+ E44 PowerShell heredoc 陷阱（来源：annie-codex-H5 上线闭环深度复盘） |

---

## 融合入口（v1.0 追加）

### 来自 whatsapp-cloud-api

- **触发词**：WhatsApp, whatsapp-cloud-api, WhatsApp API, whatsapp business, chatbot whatsapp
- **能力描述**：WhatsApp Cloud API 集成开发、消息发送、Webhook HMAC-SHA256 处理、模板管理、自动化
- **资产位置**：`absorbed-skills/antigravity-awesome-skills/skills/whatsapp-cloud-api/`
- **融合方式**：merge_variants（3 变体合并）
- **融合日期**：2026-05-25

### 来自 dotnet-backend-patterns

- **触发词**：.NET后端, dotnet-backend, C#后端, .NET Web API, MCP servers
- **能力描述**：.NET 后端架构模式、依赖注入、中间件、仓储模式、EF Core/Dapper、Redis 缓存
- **资产位置**：`absorbed-skills/antigravity-awesome-skills/skills/dotnet-backend-patterns/`
- **融合方式**：merge_variants
- **融合日期**：2026-05-25

### 来自 fastapi-pro

- **触发词**：FastAPI, fastapi-pro, Python API, async API, Pydantic V2
- **能力描述**：FastAPI 专业开发、异步处理、SQLAlchemy 2.0、Pydantic V2、WebSocket、微服务架构、OpenAPI
- **资产位置**：`absorbed-skills/antigravity-awesome-skills/skills/fastapi-pro/`
- **融合方式**：merge_variants
- **融合日期**：2026-05-25

### 来自 python-pro

- **触发词**：Python高级, python-pro, Python工程化, Python 3.12+, uv, ruff
- **能力描述**：Python 高级工程化、类型系统、异步编程、uv/ruff 工具链、生产级实践
- **资产位置**：`absorbed-skills/antigravity-awesome-skills/skills/python-pro/`
- **融合方式**：merge_variants
- **融合日期**：2026-05-25

### 来自 mcp-builder（共享入口）

- **触发词**：MCP Server, mcp-builder, MCP服务
- **能力描述**：MCP Server 设计与实现、TypeScript/Python MCP 服务构建
- **资产位置**：`absorbed-skills/antigravity-awesome-skills/skills/mcp-builder/`
- **边界说明**：本技能同时服务于 awkn-工程师 和 awkn-ui，两边均可触发。另一入口在 awkn-ui。
- **融合方式**：split_by_owner
- **融合日期**：2026-05-23

### 来自 webapp-testing（共享入口）

- **触发词**：Web测试, webapp-testing, Playwright
- **能力描述**：Web 应用测试、Playwright 自动化、E2E 测试
- **资产位置**：`absorbed-skills/antigravity-awesome-skills/skills/webapp-testing/`
- **边界说明**：本技能同时服务于 awkn-工程师 和 awkn-审核，两边均可触发。另一入口在 awkn-审核。
- **融合方式**：split_by_owner
- **融合日期**：2026-05-23

### 来自 mcp-builder（共享技能）

- **触发词**：MCP Server, mcp-builder, MCP协议, Model Context Protocol
- **能力描述**：MCP Server 设计和实现参考。用于构建 TypeScript/Python MCP 服务。
- **资产位置**：`references/mcp-builder/`
- **融合方式**：boundary_note
- **边界说明**：共享技能，另一入口在 awkn-ui
- **融合日期**：2026-05-25

### 来自 webapp-testing（共享技能）

- **触发词**：Web测试, webapp-testing, Playwright, E2E测试, 浏览器自动化
- **能力描述**：Playwright 浏览器自动化测试：截图、DOM探测、表单交互、响应式布局验证
- **资产位置**：`skills/webapp-testing/`
- **融合方式**：boundary_note
- **边界说明**：共享技能，另一入口在 awkn-审核
- **融合日期**：2026-05-25

---

## E21｜Bun 专有 API 在 vitest 环境下的兼容层模式

### 触发条件
- 项目使用 Bun 运行时（bun:sqlite、Bun.hash、Bun.file 等）
- 需要在 vitest（Node.js 环境）下运行测试

### 兼容层模式

\\\	ypescript
function computeXxx(input: string): SomeType {
  if (typeof Bun !== 'undefined' && Bun.xxx) {
    return Bun.xxx(input)
  }
  // Node.js 等效实现
  const { someModule } = require('node:crypto') as typeof import('node:crypto')
  return someNodeEquivalent(input)
}
\\\

### 已知 Bun API → Node.js 等效映射

| Bun API | Node.js 等效 |
|---------|-------------|
| Bun.hash(s) | crypto.createHash('sha256').digest() + parseInt(hex, 16) |
| bun:sqlite | better-sqlite3（需 mock） |
| Bun.file() | fs.readFile() (Promise wrapper) |
| Bun.serve() | http.createServer() |

### 教训来源
2026-06-01 awkn-agent 项目：immutable-prefix.ts 7 个测试 ReferenceError → 加 computeHash 兼容层后全过。
\\\	ypescript
// 兼容层模板（已验证）
function computeHash(input: string): number {
  if (typeof Bun !== 'undefined' && Bun.hash) {
    return Bun.hash(input)
  }
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const hex = createHash('sha256').update(input).digest('hex')
  return parseInt(hex.slice(0, 16), 16)
}
\\\

---

## E22｜Electron + vite-plugin-electron 构建产物路径三方对齐

### 触发条件
- 项目使用 vite-plugin-electron 构建 Electron 主进程 + preload
- 涉及 vite outDir、package.json main、electron-builder.yml files 三处配置

### 必须三方对齐

1. **vite.config.ts** → \lectron([...]).vite.build.outDir\
2. **package.json** → \"main": "..."\
3. **electron-builder.yml** → \iles: [dist/**/*, ...]\

### 配置模板

\\\	ypescript
import { resolve } from 'node:path'

const __root = resolve(__dirname, '..')

electron([
  {
    entry: resolve(__root, 'electron/main.ts'),
    vite: {
      build: {
        outDir: resolve(__root, 'dist/electron'),
        rollupOptions: {
          external: Object.keys(require(resolve(__root, 'package.json')).dependencies || {}),
        },
      },
    },
  },
  {
    entry: resolve(__root, 'electron/preload.ts'),
    onstart: false,
    vite: {
      build: {
        outDir: resolve(__root, 'dist/electron'),
      },
    },
  },
])
\\\

### 常见错误

- 相对路径 \ntry: 'electron/main.ts'\ 会基于 frontend/ 解析 → 找不到文件
- 省略 outDir 时 vite-plugin-electron v1.0.0 默认输出到 \rontend/dist-electron/\ → 与 package.json 的 \dist/electron/main.js\ 不匹配
- 第三方依赖（如 unzipper → @aws-sdk/client-s3）未 externalize → Rolldown 打包失败

### 外部化所有生产依赖（一行解法）

\\\	ypescript
rollupOptions: {
  external: Object.keys(require(resolve(__root, 'package.json')).dependencies || {}),
}
\\\

### 教训来源
2026-06-01 awkn-agent 项目：3 轮修改解决 entry 路径、external 依赖、outDir 对齐 3 个问题，最终产物在 dist/electron/ 与 package.json main 完全对齐。

---

## E28｜Bun test 兼容性陷阱集：vitest 全局变量必须显式 import（2026-06-01）

### 触发条件
- 在 Bun test 中运行原本为 vitest 编写的测试
- 测试使用 `beforeEach` / `afterEach` / `beforeAll` / `afterAll` / `describe` / `it` / `expect`
- 从 `'vitest'` 导入测试 API

### 问题
Bun test **不会**自动注入 vitest 全局变量。测试文件中用到的每个 vitest API 都必须从 `'vitest'` 显式 import：

```typescript
// ❌ ReferenceError: beforeEach is not defined
import { describe, it, expect } from 'vitest'
beforeEach(() => { ... })  // 报错！

// ✅ 正确
import { describe, it, expect, beforeEach } from 'vitest'
beforeEach(() => { ... })
```

### Bun test 与 vitest 的其他差异

| 维度 | vitest | bun test |
|------|--------|----------|
| 全局变量 | 自动注入（with globals: true） | 必须显式 import |
| mock 配置 | 读 `vitest.config.ts` | **不读**，用真实模块 |
| 数据库 mock | `vi.mock()` 替换 | 必须用真实 bun:sqlite |
| `expect().rejects` 同步 reject | 异步处理 | **unhandled rejection** |
| `toThrow()` 对 console.error | 正常 | 可能误判 |

### 强制操作

#### 新测试文件模板（bun test + vitest 写法）
```typescript
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
// 任何用到的钩子都必须显式 import

describe('xxx', () => {
  beforeEach(() => { /* setup */ })
  afterEach(() => { /* cleanup */ })
  // ...
})
```

#### `expect().rejects` 替代为 `Promise.allSettled`
```typescript
// ❌ 同步 reject 导致 unhandled rejection
await expect(promise).rejects.toThrow('error')

// ✅ 用 allSettled 避免 unhandled
const results = await Promise.allSettled([promise])
expect(results[0].status).toBe('rejected')
expect((results[0] as PromiseRejectedResult).reason).toBe('error')
```

#### `not.toThrow()` 替代为 try-catch
```typescript
// ❌ bun test 全量运行时可能误判
expect(() => logger.error('test', new Error('boom'))).not.toThrow()

// ✅ 用 try-catch 替代
let threw = false
try {
  logger.error('test', new Error('boom'))
} catch {
  threw = true
}
expect(threw).toBe(false)
```

### 核心原则
> **Bun test 用 vitest 写法时，每个 API 都要从 'vitest' 显式 import；用真实模块而非 mock 配置。**

### 教训来源
2026-06-01 awkn-agent：4 个测试文件因未 import beforeEach/afterEach/afterAll 而 ReferenceError；单独运行通过但全量运行 fail 1 + errors 5。

### 防复发机制
1. **新测试文件用完整 import 模板**：`{ describe, it, expect, beforeEach, afterEach, beforeAll, afterAll }`
2. **代码审查时检查 import 完整性**：用到任何 vitest API 都必须出现在 import 中
3. **跨 runner 测试时全量跑 + 单独跑双向验证**：单通 ≠ 全通

---

## E29｜Bun 专有 API 类型签名兼容性预检（2026-06-01）

### 触发条件
- 使用 Bun.* 专有 API（Bun.hash / Bun.file / Bun.serve / Bun.password / Bun.spawn 等）
- 项目开启 TypeScript `strict: true`
- 函数声明返回类型与 Bun API 实际返回类型不匹配

### 问题
Bun 专有 API 的 TypeScript 类型签名可能返回联合类型（如 `number | bigint`），与函数声明的类型不匹配：

```typescript
// ❌ TS2322: Type 'number | bigint' is not assignable to type 'number'
function computeHash(input: string): number {
  if (typeof Bun !== 'undefined' && Bun.hash) {
    return Bun.hash(input)  // 报错
  }
  // ...
}

// ✅ 修复 1: 类型断言
return Bun.hash(input) as number

// ✅ 修复 2: 返回类型改为 bigint | number
function computeHash(input: string): number | bigint {
  return Bun.hash(input)
}
```

### 高频 Bun API 类型陷阱表

| API | TS 类型 | 实际返回 | 风险等级 |
|-----|---------|---------|---------|
| `Bun.hash(input)` | `number \| bigint` | 字符串小输入 → number | 🟡 中 |
| `Bun.file(path)` | ` BunFile \| undefined` | 始终返回 BunFile | 🟢 低 |
| `Bun.serve({...})` | `Server` | 实际类型完整 | 🟢 低 |
| `Bun.password.hash()` | `Promise<string>` | 同 | 🟢 低 |
| `Bun.$` shell | `ShellPromise` | 异步 | 🟢 低 |

### 强制操作

#### 用 Bun API 前先 tsc 验证
```bash
# 每次新增 Bun.* API 调用后立即跑
npx tsc --noEmit 2>&1 | grep "error TS"
```

#### 修复模式
```typescript
// 模式 1: 类型断言（适用于已知运行时类型）
return Bun.hash(input) as number

// 模式 2: 联合类型返回（适用于不确定运行时类型）
function computeHash(input: string): number | bigint {
  return Bun.hash(input)
}
// 调用方用 toString() 兼容
const result = computeHash(input).toString(16)

// 模式 3: 兼容层（适用于多环境）
function computeHash(input: string): number {
  if (typeof Bun !== 'undefined' && Bun.hash) {
    return Number(Bun.hash(input))  // 显式 Number() 转换
  }
  // Node fallback
  const { createHash } = require('node:crypto')
  return parseInt(createHash('sha256').update(input).digest('hex').slice(0, 16), 16)
}
```

### 核心原则
> **Bun API 用前先 tsc 验证类型；优先用类型断言或联合类型返回，兼容层作为最后选择。**

### 教训来源
2026-06-01 awkn-agent：`Bun.hash(input)` 在 strict 模式下报 TS2322，函数声明返回 number 实际是 `number | bigint`。修复：`as number` 断言。

### 防复发机制
1. **新增 Bun API 后立即 tsc**：`npx tsc --noEmit` 作为每次 Bun API 引入的强制验证
2. **函数返回类型与 Bun API 类型对齐**：要么 union 接收，要么 as 断言
3. **CI 加 Bun API 类型专项检查**：扫 `Bun\.[a-zA-Z]+` 出现后检查 tsc 输出

---

## E26：入口文件修改五必做（chat handler / main loop / request handler）

**触发条件**：任何"单一入口 + 多 service"架构的入口文件修改

**五必做清单**：

1. **必做接线矩阵表**：在入口文件头部注释列出"已接入的 phase × service"对照表
2. **必做集成测试**：入口文件修改后必须新增/更新对应的集成测试（覆盖 service 调用路径）
3. **必做向下兼容**：新增参数必须可空，老调用路径不破坏（加性扩展 > 破坏性重构）
4. **必做独立审计**：入口文件须列入 awkn-审核 的"独立审计对象"，每季度审计
5. **必做行数监控**：入口文件 > 2000 行时强制拆分（按 phase 切分 router/handler）

**反例**（2026-06-01 awkn-agent chat.ts）：
- 4 phase 在 chat 流中都有逻辑要执行
- 实际 chat.ts 只调旧 4 参数 buildSystemPrompt
- 5 个 PARTIAL 全部因 chat handler 未调用对应 service

**正例**（修复后）：
- 7 参数 buildSystemPrompt 调用，新增 role/addressInfo/reflectionAdjustments 全部 optional
- 加性扩展，老调用路径不破坏
- 已新增 reflection/ReactExtractor/letter 触发逻辑

**防复发**：
- awkn-执行检查 在入口文件修改时强制跑"接线矩阵表存在性"检查
- awkn-审核 在 PR 中强制要求入口文件附"接线矩阵表"截图

### 教训来源
2026-06-01 awkn-agent 4 阶段验收：5 个 PARTIAL 全部因 chat handler 汇聚点未做接线审计。

---

## E30｜biome --write 渐进式修复模式（v2.8.2 新增，2026-06-02）

> **核心断言**：biome 大量错误时，先 `--write` 自动修 safe fix，再手修真 lint 错误
> 来源：2026-06-02 awkn-agent V4 收尾：67 错误 → `--write` 修 53 文件 → 手修 4 个真 lint

### 30.1 触发条件

- biome 报告 > 20 个错误
- 错误类型混杂（format + lint + organizeImports + ...）
- 不想一次性 `biome check --write --unsafe`（风险高）

### 30.2 强制流程

```
biome 错误数 > 20：
  1. bunx biome check --no-errors-on-unmatched --max-diagnostics=200 .
     → 列出全部错误类型（format / lint/...）
  2. bunx biome check --write --no-errors-on-unmatched .
     → 应用 SAFE fix（format + organizeImports）
  3. bunx biome check --no-errors-on-unmatched --diagnostic-level=error .
     → 列出剩余真 lint 错误
  4. 逐一手修剩余错误（每修一个跑一次 biome check 确认）
  5. 最终 biome check EXIT 0
```

### 30.3 渐进式 vs 一次性

| 策略 | 优点 | 缺点 | 适用 |
|------|------|------|------|
| `--write` + 手修（渐进式） | 风险低，每步可回滚 | 耗时长（30-60 分钟） | 错误多 + 改动大 |
| `--write --unsafe`（一次性） | 快（5 分钟） | 风险高，unsafe 改代码逻辑 | 错误少 + 改动小 |
| 仅 format `--write` | 极安全 | 仍需手修 lint | 第一次接 biome 项目 |

### 30.4 反模式（禁止）

- ❌ 一次性 `--write --unsafe` 不复查
- ❌ 看到 67 错误就放弃手修，全部 `--unsafe` 跳过
- ❌ biome EXIT 0 后不看 warning（warning 可能掩藏真正的 bug）

### 30.5 反例（2026-06-02 V4 收尾）

```
biome check → 67 错误（53 format + 14 lint）
   ↓
biome --write → 53 文件 format/imports 自动修（safe fix）
   ↓
剩余 4 个真 lint 错误：
  - compression-parser.ts: while 循环赋值（noAssignInExpressions）
  - state-declaration.ts: constructor 阴影（noShadowRestrictedNames）
  - useStreamRender.ts × 2: useEffect 依赖（useExhaustiveDependencies）
   ↓
逐一手修 4 个文件 → biome EXIT 0
```

### 30.6 防复发

- biome 升级时先跑 dry-run（`--write --unsafe` 之前先看 diff）
- 大型项目（> 100 文件）按目录分批 biome 修复
- biome config 改了之后必须重跑整个项目

### 教训来源
2026-06-02 awkn-agent V4 收尾：67 错误用渐进式 30 分钟搞定，且**没有破坏性改动**（因为 unsafe fix 没启用）。

---

## E36：ESM 环境禁止 lazy require 跨模块引用（v2.8.3 新增，2026-06-02，迁移自 E30）

> **核心断言**：vitest 是 ESM 环境，CommonJS `require()` 会失败
> 来源：awkn-agent persona.ts 改 ESM import 修复 7 个 vitest 失败（v4 P0 收口复盘）

### E30.1 触发条件

- TypeScript ESM 项目（package.json `"type": "module"` 或 .mts/.mjs 文件）
- vitest 测试套件（vitest 0.x 起 ESM 优先）
- 代码中出现 `const { x } = require('../path.js')` 模式
- 报错信息：`Error: Cannot find module '../core/x.js' Require stack: ...`

### E30.2 反例（2026-06-02 awkn-agent）

```typescript
// ❌ 错误：CommonJS require 模式
export function buildSystemPrompt(...) {
  const { buildLayeredSystemPrompt, layeredToFlatString } =
    require('../core/prompt-layers.js') as typeof import('../core/prompt-layers.js')
  // ...
}
```

**症状**：
- ✅ `npx tsc --noEmit` 通过
- ❌ `npx vitest run` 失败：`Error: Cannot find module '../core/prompt-layers.js'`
- 原因：vitest 是 ESM 环境，`require()` 未定义或解析失败

**根因**：
1. 历史代码用 `require()` 是为了避免循环依赖
2. ESM 项目的依赖图可被静态分析，循环依赖更早暴露
3. 正确的解法不是 `require()`，而是：
   - 拆分子模块（消除循环）
   - 顶层 `import`（现代 ESM 支持循环依赖的"惰性绑定"）

### E30.3 正例（修复后）

```typescript
// ✅ 正确：ESM 顶层 import
import {
  buildLayeredSystemPrompt,
  layeredToFlatString,
  type DynamicLayerOptions,
} from '../core/prompt-layers.js'

export function buildSystemPrompt(...) {
  const layered = buildLayeredSystemPrompt(...)
  return layeredToFlatString(layered)
}
```

**验证**：
- ✅ `npx tsc --noEmit` 通过
- ✅ `npx vitest run` 18/23 persona 测试通过（修复 7 个失败）

### E30.4 教训（按 3 写格式）

- **写 1 教训**：ESM 项目禁止 `require()` 跨模块引用，必须顶层 `import`
- **写 2 反例**：`const { x } = require('../core/x.js')` 在 TS ESM 项目里 tsc 通过但 vitest 失败
- **写 3 触发词**：lazy import / require / ESM / vitest 失败 / 模块解析 / Cannot find module

### E30.5 防复发

- Step 04 Patch 后立即跑 `npx vitest run <受影响文件>` 验证
- ESLint 规则 `no-restricted-syntax` 禁止 `require()` 在 .ts 文件中出现
- Code review 检查所有 `require(` 出现位置，确认是否在 ESM 项目

### 教训来源
2026-06-02 awkn-agent v4 P0 收口：persona.ts 改 ESM import 修复 7 个 persona 测试，验证 19 失败 → 12 失败

---

## E37：冷启动降级三阶段法（v2.8.4 新增，2026-06-08）

> **核心断言**：AI 评估系统在样本不足时不能装作有统计意义，必须按样本量降级输出
> 来源：真本事 Veris PRD v5.1 §11 冷启动降级机制实现

### E37.1 触发条件
- AI 评估/评分/推荐系统上线初期
- 同岗位/同品类历史样本量不足
- 系统需要输出评分但缺乏统计基础

### E37.2 三阶段策略
- **模板基线期（0-10 样本）**：不做归一化/聚类，评分=能力向量直接映射，雷达图绝对值展示，不展示百分位/行业对比，加降级提示
- **小样本基线期（10-100 样本）**：启动聚类，加 1 句行业对比，雷达图叠加行业均值虚线
- **充分样本期（>100 样本）**：完整归一化（百分位/Z-score），雷达图叠加 3 条参考线（行业均值+同岗位均值+候选人趋势）

### E37.3 教训
- **写 1 教训**：0 样本时评分仍可输出，但不能装作有统计意义
- **写 2 反例**：上线第一天就展示百分位和行业对比 → 误导用户
- **写 3 触发词**：冷启动 / 样本不足 / 评分可信度 / 归一化 / 百分位 / 基线期

### E37.4 防复发
- ColdstartManager.get_stage() 在评分前强制查询
- 前端根据 cold_start_info 的 should_* 标志控制展示粒度
- 模板基线期必须显示降级提示

---

## E38：AI 协作三层分析架构（v2.8.4 新增，2026-06-08）

> **核心断言**：AI 协作分析必须分三层——实时分类 → 任务级模式聚合 → 境界推断，不能跳层
> 来源：真本事 Veris C1/C2 分类器实现

### E38.1 触发条件
- 需要分析用户与 AI 的协作模式
- 需要从行为数据推断用户能力境界
- 需要区分"用了 AI"和"驾驭了 AI"

### E38.2 三层架构
1. **C1 实时分类**：每次 AI 交互实时分类 3 维（action_type / question_focus / ai_output_usage），延迟 P95 < 1.5s
2. **C2 模式聚合**：任务完成后从 C1 结果聚合 5 字段（ai_dependency_index / questioning_pattern / autonomy_index / collaboration_efficiency / summary）
3. **境界推断**：从 C2 字段推断 L1-L4 境界（工具使用→任务协作→主动挑战→框架共建）

### E38.3 教训
- **写 1 教训**：不能直接从单次交互推断境界，必须经过分类→聚合→推断三层
- **写 2 反例**：只看 adopt 次数就判断 AI 依赖度 → 忽略了 reject/revise 同样是有效协作
- **写 3 触发词**：AI 协作 / 协同分类 / 行为模式 / 境界推断 / C1/C2

### E38.4 防复发
- C1 分类结果必须写入事件流，不能只存在内存
- C2 分析必须在任务完成后触发，不能在中间步骤触发
- 境界推断必须基于 C2 聚合结果，不能基于 C1 原始分类

---

## E39：评分确定性门禁法（v2.8.4 新增，2026-06-08）

> **核心断言**：评分系统必须有确定性验证——同一份数据评 3 次，一致性 < 95% 标记低置信度
> 来源：真本事 Veris PRD v5.1 §5.2 第三层

### E39.1 触发条件
- LLM 驱动的评分系统（非规则引擎）
- 评分结果用于辅助录用决策
- 需要向用户解释评分可信度

### E39.2 验证方法
- 同一份数据执行 3 次评分（temperature=0 + 同一 prompt + 同一模型）
- 一致性 = 1 - (平均标准差 / 满分)
- 一致性 ≥ 95% → high（可信）
- 一致性 85%-95% → medium（需注意）
- 一致性 < 85% → low（建议人工复核）

### E39.3 教训
- **写 1 教训**：基于规则的评分确定性 100%，但 LLM 评分必须做确定性验证
- **写 2 反例**：LLM 评分直接输出，不检查一致性 → 用户看到矛盾结果
- **写 3 触发词**：评分确定性 / 一致性 / 置信度 / 3 次评分 / 低置信度

### E39.4 防复发
- 基于规则的评分：verify_rule_based() 直接返回 100%
- LLM 评分：verify() 执行 3 次评分并计算一致性
- 低置信度案例：requires_expert_review=True，优先进入人工抽检队列

---

## E40：并行 sub-agent 安全上限 ≤ 3（v2.8.4 新增，2026-06-08）

> **核心断言**：并行 sub-agent 超过 3 个时结果丢失概率显著上升
> 来源：真本事 Veris PRD v5.0/v5.1 工程落地（4 个并行中 2 个结果丢失）

### E40.1 触发条件
- 使用 Task tool 并行启动多个 sub-agent
- 单次消息中调用 > 3 个 Task tool

### E40.2 规则
- 并行 sub-agent 数量 ≤ 3
- 超过 3 个时分批执行
- 每批完成后立即验证结果，不要等全部完成

### E40.3 教训
- **写 1 教训**：4 个并行 sub-agent 中 2 个结果丢失，需要重跑
- **写 2 反例**：一次启动 4 个 sub-agent → 2 个结果丢失 → 延迟 5 分钟重跑
- **写 3 触发词**：并行 / sub-agent / Task tool / 结果丢失 / 分批执行

### E40.4 防复发
- 单次消息中 Task tool 调用 ≤ 3 个
- 每批完成后检查结果完整性
- 丢失的结果立即重跑，不要累积

---

## E41：证据引用三级降级法（v2.8.4 新增，2026-06-08）

> **核心断言**：证据引用必须支持多级降级定位，保证向后兼容
> 来源：真本事 Veris evidence_ref 从简化格式升级到 UUID

### E41.1 触发条件
- 评分/报告中的证据引用需要定位到具体事件
- 数据格式从旧版升级到新版
- 需要同时支持新旧两种数据

### E41.2 三级降级
1. **UUID 定位**（最新）：通过 data-event-id 属性精确定位到具体事件实例
2. **行为编码定位**（兼容）：通过 data-behavior-code 属性定位到事件类型（同类型多个事件可能共享编码）
3. **索引定位**（兜底）：通过 evt:{index} 格式按数组索引定位

### E41.3 教训
- **写 1 教训**：数据格式升级时必须保留旧格式的定位能力
- **写 2 反例**：evidence_ref 从 evt:0 改为 UUID 后，旧数据的引用全部失效
- **写 3 触发词**：evidence_ref / 证据引用 / 向后兼容 / UUID / 行为编码 / 降级定位

### E41.4 防复发
- scrollToEvent() 三级降级：UUID → behavior_code → evt:index
- 新数据优先写 UUID，旧数据自动降级
- EvidenceCard 新增 behavior_code_label 字段保留可读标签

---

## E42：延迟反馈自动触发模式（v2.8.4 新增，2026-06-08）

> **核心断言**：验证系统的价值在于闭环——入职后绩效必须回流校准录用前判断，但 HR 不会主动回传，必须自动触发
> 来源：真本事 Veris PRD v5.1 §5.2 Day 120 自动 ping

### E42.1 触发条件
- 系统输出预测/评估/推荐，但真实结果延迟到达
- 需要真实结果回流校准系统
- 人工回传率低（< 30%）

### E42.2 模式
1. **定时扫描**：cron_scheduler 每日检查条件是否满足
2. **条件匹配**：入职满 120 天 + 无绩效回传 + hire_decision=hired
3. **事件记录**：day120_pinged=True + day120_ping_date=当前日期
4. **看板提醒**：HR 看板展示待回传列表，可点击跳转

### E42.3 教训
- **写 1 教训**：不要指望用户主动回传数据，必须自动触发提醒
- **写 2 反例**：只提供手动回传入口 → 回传率 < 10% → 验证飞轮转不起来
- **写 3 触发词**：延迟反馈 / 自动 ping / 绩效回传 / 验证飞轮 / 闭环 / Day 120

### E42.4 防复发
- cron_scheduler 每日 3:30 自动检查
- ping 事件写入 session_events，不可篡改
- HR 看板实时展示待回传数量和列表

---

## E43：本地 ReleaseBundle 验证 SOP（v3.0.0 修订，2026-07-25）

> **核心断言**：push 成功只代表代码已托管；质量结论来自 Windows 本地门禁和不可变 ReleaseBundle，GitHub Actions 不参与。

### E43.1 强制证据

1. 本地 lint/typecheck/compile、测试、安全检查和构建命令均有退出码与日志；
2. 产物只构建一次，并记录绝对路径和 SHA-256；
3. 生成 `ReleaseBundle v1`，其中 `pipeline.result=PASS`；
4. `git push` 可在上述步骤前后用于保存提交，但不能充当测试或部署证据。

### E43.2 禁止

- 禁止 `gh workflow`、`gh run` 和 GitHub Actions REST API；
- 禁止把 `ci-passed/<SHA>`、runner、Actions Secrets 或 workflow 状态作为发布门；
- 禁止把“本地测试通过”写成“部署成功”；生产结果必须由 `DeployResult v1` 证明。

---

## E44：PowerShell heredoc 陷阱（v2.8.5 新增，2026-07-23）

> **核心断言**：PowerShell 不支持 bash 风格 heredoc `<<EOF`，会报 ParserError
> 来源：annie-codex-H5 上线闭环 amend commit 时

### E44.1 触发条件
- 在 Windows PowerShell 环境执行 git commit --amend 需要多行 message
- 套用 bash 习惯写 `git commit -m "$(cat <<'EOF' ... EOF)"`

### E44.2 反例与正例

**反例（PowerShell 报错）**：
```powershell
git commit --amend -m "$(cat <<'EOF'
title
body
EOF
)"
# ParserError: Missing file specification after redirection operator.
```

**正例 1：多 -m 参数**（最简单，每个 -m 是一段，空行分隔）：
```powershell
git commit --amend -m "title" -m "body line 1" -m "body line 2"
```

**正例 2：PowerShell here-string**（`@'...'@` 必须行首闭合，不能有前导空格）：
```powershell
$msg = @'
title

body
'@
git commit --amend -m $msg
```

### E44.3 教训（按 3 写格式）
- **写 1 教训**：bash heredoc 语法在 PowerShell 是非法的，PowerShell 用 here-string `@'...'@`
- **写 2 反例**：直接套 `<<'EOF'` → ParserError → amend 失败 → 误以为提交有问题
- **写 3 触发词**：PowerShell / heredoc / EOF / here-string / 多行 commit message / amend / ParserError

### E44.4 防复发
- 多行 commit message 默认用多 `-m` 参数（跨 shell 兼容）
- 必须用 here-string 时，确认是 PowerShell 环境再用 `@'...'@`

---

## E45：本地交付闭环检查清单 SOP（v3.0.0 修订，2026-07-25）

> **核心断言**：代码完成、代码推送、CICD 完成和生产部署是四个不同状态，不得互相冒充。

### E45.1 完成清单

1. 代码完成：相关变更与本地测试证据齐全；
2. 代码托管：若用户要求，commit 已推送；这一项不触发质量结论；
3. CICD 完成：本地 `ReleaseBundle v1`、产物路径和 SHA-256 齐全；
4. 部署完成：同一产物已在阿里云通过灰度、健康和业务验证，并生成 `DeployResult v1`；
5. 最终标签：只在 `DeployResult.status=RELEASED` 后写入 GitHub。

### E45.2 防复发

- GitHub Actions 失败、未配置 Secrets、runner 不可用均不是 AWKN 发布阻塞；
- Todo 和最终报告禁止出现“GitHub CI 全绿”“等待 runner”“配置 Actions Secrets”作为下一步；
- 缺 ReleaseBundle 时只能报告 CICD 未完成；缺 DeployResult 时只能报告部署未完成；
- `git push` 成功最多标记“代码已托管”，不得标记“部署成功”。

