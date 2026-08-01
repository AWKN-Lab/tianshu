# 天枢｜AWKN Agent Engine

天枢是 AWKN-Lab 的持久化 Agent 工作流内核，围绕 Goal、Loop、Gate、Tool、Memory、Evidence 与 Evolve 组织智能体执行。

## 当前工程边界

- `runtime/`：轻量 Node.js 运行时，可独立启动；
- `agents/`：天火、cicd-tester 等 Agent 配置；
- `skills/`：外置资产，通过 `AWKN_SKILLS_ROOT` 或 `SKILLS_DIR` 指向本地技能库；
- `loop-engineering/`：循环工程方法与质量约束；
- `docs/agent-os-3.0/`：Agent OS 3.0 产品、架构、工程实施与总开发计划。

## Agent OS 3.0

天枢是 AWKN Agent OS 总框架、运行时协议、治理规则和进化闭环的权威项目。

Agent OS 3.0 主链：

```text
Trusted Input Gateway
→ Intent & Goal Router
→ Context Planner
→ Policy & Skill Compiler
→ Tool & Model Broker
→ Evidence-Gain Loop
→ Delivery Router
→ Evidence & Outcome
→ Memory Write Gate
→ Evolve
```

工程文档入口：[`docs/agent-os-3.0/README.md`](./docs/agent-os-3.0/README.md)  
总开发计划：[`docs/agent-os-3.0/21-Agent-OS-3.0总开发计划.md`](./docs/agent-os-3.0/21-Agent-OS-3.0总开发计划.md)

### 当前里程碑

```text
R0 Baseline                Done
→ R1 Contract Kernel       Done
→ R2 Trusted Decision Core Done (PR #90 merged 2026-07-29, main@9810bc0)
   WP02 Trusted Input       main@20c52409
   WP03 Intent / Goal       main@a461e408
   WP04 Claim Ledger        main@df174845，Migration v12
   WP05A Context Planner    main@b5c9c401
   WP05B Context Render     PR #64，机器验证已通过，等待语义 Review
   R2 Shadow Exit           GO (2026-07-28)，见 docs/2026-07-28-R2-Exit-Report.md
→ R3—R6                    Issue #67—#80，13 个 feat 分支待合并
```

当前 Agent OS 组件仍以 Mode `0` 为主。Engine v2 保持默认执行路径，Shadow 与 Enforce 必须按总计划逐组件推进。

AWKN Memory OS 作为独立记忆系统，通过 `MemoryBackend` 协议挂载到天枢。其他 AWKN 项目按照各自产品定位独立演进，不继承天枢数据库、Feature Flag 或发布生命周期。

## 快速验证

```bash
cd runtime
npm ci
npm run check
```

Runtime CI 当前覆盖：

- Ubuntu / Node 20；
- Ubuntu / Node 22；
- Windows / Node 20；
- Architecture Scan；
- Unit 与 Contract Tests；
- Dependency Manifest；
- CycloneDX SBOM；
- npm Audit Evidence。

## 外置 Skills

```bash
# Windows PowerShell
$env:AWKN_SKILLS_ROOT='D:\awkn-lab\skills'

# Linux/macOS
export AWKN_SKILLS_ROOT=/opt/awkn/skills
npm run dev -- skill list
```

仓库未包含 Skill 内容。`runtime/src/skills/manager.ts` 当前提供外置目录的索引、触发匹配与按需读取；Legacy Singleton 清理由 WP-AOS-07 / Issue #68 跟踪。

## 工具安全

带副作用的工具默认要求明确许可：

```bash
export AWKN_APPROVED_TOOLS=write,exec,skill
```

默认策略包括：

- 工具路径限制在工作区内；
- `.env`、`.git`、密钥文件和凭据目录禁止访问；
- 高危 Shell 命令直接阻断；
- 审批信息可由运行上下文传入。

兼容旧行为可临时设置 `AWKN_TOOL_POLICY_MODE=legacy`。正式环境应迁移到 WP-AOS-09 Tool Broker 的受控执行边界。

## 独立审核 MCP

Review Kernel 通过独立 stdio MCP 暴露，避免把完整引擎管理工具 schema 注入只需审核的会话：

```powershell
node runtime/bin/awkn-review-mcp-server.js
```

该服务只公开 `review_repository`。调用方必须传入待审核 Git 仓库的绝对路径；实现者身份由
IDE/MCP 主机通过 `AWKN_REVIEW_IMPLEMENTER_ACTOR_ID` 可信注入，调用方不能自报。仓库经
`realpath` 解析后还必须位于 `AWKN_REVIEW_ALLOWED_ROOTS` 白名单内。直接调用仅允许
`mode=enforce`，并返回完整的结构化 `awkn-review-receipt/v1`；只有合法 `PASS` Receipt
才能通过发布审核门禁。生产入口运行 `dist`，安装/发布前会由 `prepack` 执行构建。

主 MCP 独立包位于 `packages/awkn-engine-mcp`，保留自己的 Git 历史；Codex、TRAE 和通用
MCP 配置均从该引擎内路径启动。审核阶段必须把完整 Review Receipt 交给天火，纯文本
`audit=PASS` 不再允许推进。

## Engine v2 基础能力

- Canonical LLM Protocol：保留多轮 Function Calling 的 `tool_calls` 与 `tool_call_id`；
- Artifact Bundle：审核器读取 Git diff、状态、Gate 输出与最终产物；
- Schema Migrations：数据库结构按版本演进；
- Event Store：Run、Step、Event、Artifact、Approval、Model Call 基础表；
- GitHub Actions：主干和 Runtime PR 自动执行检查。
