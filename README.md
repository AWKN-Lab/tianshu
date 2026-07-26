# 天枢｜AWKN Agent Engine

天枢是 AWKN-Lab 的持久化 Agent 工作流内核，围绕 Goal、Loop、Gate、Tool、Memory、Evidence 与 Evolve 组织智能体执行。

## 当前工程边界

- `runtime/`：轻量 Node.js 运行时，可独立启动。
- `agents/`：天火、cicd-tester 等 Agent 配置。
- `skills/`：外置资产，不进入本仓库。通过 `AWKN_SKILLS_ROOT` 或 `SKILLS_DIR` 指向本地技能库。
- `loop-engineering/`：循环工程方法与质量约束。

## Agent OS 3.0 工程规划

天枢是 AWKN Agent OS 总框架、运行时协议、治理规则和进化闭环的权威项目。

Agent OS 3.0 在现有 `Goal / Loop / Gate / Tool / Memory / Evidence / Evolve` 基础上增加：

- Trusted Input Gateway；
- Intent & Goal Router；
- Context Planner 与 Claim Ledger；
- Policy & Skill Compiler；
- Tool & Model Broker；
- Evidence-Gain Loop；
- Delivery Router；
- Evidence & Outcome；
- Memory Write Gate；
- Evolve v2。

工程文档入口：[`docs/agent-os-3.0/README.md`](./docs/agent-os-3.0/README.md)

AWKN Memory OS保持独立项目，通过 `MemoryBackend` 协议挂载到天枢；GUNDAM和各垂直项目按组件吸收天枢能力并保留领域实现。

## 快速验证

```bash
cd runtime
npm ci
npm run check
```

## 外置 Skills

```bash
# Windows PowerShell
$env:AWKN_SKILLS_ROOT='D:\\awkn-lab\\skills'

# Linux/macOS
export AWKN_SKILLS_ROOT=/opt/awkn/skills
npm run dev -- skill list
```

仓库未包含任何 Skill 内容。`runtime/src/skills/manager.ts` 只提供外置目录的索引、触发匹配与按需读取。

## 工具安全

带副作用的工具默认要求明确授权：

```bash
export AWKN_APPROVED_TOOLS=write,exec,skill
```

默认策略包括：

- 工具路径限制在工作区内；
- `.env`、`.git`、密钥文件和凭据目录禁止访问；
- 高危 Shell 命令直接阻断；
- 审批信息可由运行上下文传入。

兼容旧行为可临时设置 `AWKN_TOOL_POLICY_MODE=legacy`，该模式不建议用于正式环境。

## Engine v2 基础能力

- Canonical LLM Protocol：保留多轮 Function Calling 的 `tool_calls` 与 `tool_call_id`；
- Artifact Bundle：审核器读取 Git diff、状态、Gate 输出与最终产物；
- Schema Migrations：数据库结构按版本演进；
- Event Store：新增 Run、Step、Event、Artifact、Approval、Model Call 基础表；
- GitHub Actions：主干和 PR 自动执行 runtime 检查。
