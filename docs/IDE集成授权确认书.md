# IDE 集成授权确认书

> 目标：将 `D:\awkn-lab\awkn引擎` 工作流配置到 TRAE CN 和 TRAE SOLO CN 两个 IDE
> 日期：2026-07-24
> 模式：CLI + Rules + Hooks（TRAE CN） / CLI + Rules（SOLO CN）

---

## 一、环境现状核实（已通过文件系统验证）

| 项目 | 现状 | 问题 |
|------|------|------|
| `c:\Users\10919\.trae-cn\mcp.json` | 含 `awkn-engine` 条目，指向不存在的 `awkn-mcp-server.js` | 失效配置，需删除 |
| `d:\awkn-lab\.mcp.json` | 同上 | 失效配置，需删除 |
| `c:\Users\10919\.trae-cn\hooks.json` | 已配置 5 个 hook 点，引用 `.trae/hooks/tianshu-hook.mjs` | 脚本文件不存在 |
| `d:\awkn-lab\.trae\` 目录 | 不存在 | 需创建 |
| `d:\awkn-lab\awkn引擎\runtime\node_modules\` | 不存在 | **依赖未安装，引擎无法运行** |
| `d:\awkn-lab\awkn引擎\引擎2.md` | 仅含标题，无实际规则内容 | tianshu-dispatch 规则需从零编写 |
| `d:\awkn-lab\skills\` 目录 | 不存在 | 需创建 |
| `d:\awkn-lab\CLAUDE.md` | 不存在 | SOLO CN 无规则文件可读 |
| SOLO CN `mcp.json` | 含 hermes-bridge、windows-mcp，无 awkn-engine | 无需改动 |
| SOLO CN `settings.json` | `AI.rules.importClaudeMd: true` | 已配置读取 CLAUDE.md |
| SOLO CN hooks 支持 | 无 `hooks.json` | 确认不支持 IDE 级 hooks |

---

## 二、授权操作清单

### 操作 1：安装 runtime 依赖【前置必需】

- **路径**：`d:\awkn-lab\awkn引擎\runtime\`
- **命令**：`npm install`
- **原因**：`node_modules` 不存在，`awkn-engine.js` 依赖 `tsx` 运行 TypeScript，`better-sqlite3` 提供数据库
- **风险**：无，标准 npm 安装
- **安全措施**：安装前已确认 `package.json` 仅含 3 个运行时依赖（better-sqlite3、cron-parser、zod），均为成熟开源库

---

### 操作 2：删除失效 MCP 配置

#### 2a. 修改 `c:\Users\10919\.trae-cn\mcp.json`

- **变更**：删除 `mcpServers.awkn-engine` 条目
- **变更后内容**：
```json
{
  "mcpServers": {}
}
```
- **原因**：指向的 `awkn-mcp-server.js` 文件不存在，MCP 模式已被 CLI+Rules+Hooks 模式替代

#### 2b. 修改 `d:\awkn-lab\.mcp.json`

- **变更**：删除 `mcpServers.awkn-engine` 条目
- **变更后内容**：
```json
{
  "mcpServers": {}
}
```
- **原因**：同上

---

### 操作 3：创建 tianshu-hook.mjs（TRAE CN 专用）

- **路径**：`d:\awkn-lab\.trae\hooks\tianshu-hook.mjs`
- **原因**：`hooks.json` 已引用此文件但不存在，5 个 hook 点全部失效
- **实现 5 个 hook 点**：

| Hook 点 | 子命令 | 行为 | 超时 |
|---------|--------|------|------|
| SessionStart | `session-start` | 注入 awkn-engine 上下文摘要（可用命令、当前 goal 列表） | 10s |
| UserPromptSubmit | `dispatch` | 检测 `/goal`、`/loop`、`/skill`、`/hook`、`/schedule` 命令前缀，匹配时注入路由提示告诉 AI 使用 awkn-engine CLI；不匹配则透传 | 10s |
| PreToolUse | `pre-tool` | 安全门禁：对 RunCommand/Write/DeleteFile 检查是否在 awkn-engine 管控范围内，记录审计日志 | 10s |
| PostToolUse | `post-tool` | 工具后处理：记录操作轨迹到 awkn-engine trace | 15s |
| Stop | `stop` | Loop 续跑检查：查询 awkn-engine 是否有活跃 goal/loop，有则注入续跑提示 | 180s |

- **dispatch 机制设计**（安全优先）：
  - hook **不直接调用** awkn-engine CLI（避免阻塞 prompt、避免副作用）
  - hook 只**注入路由提示**到 AI 上下文，由 AI 自主决定是否调用 CLI
  - 这是"CLI+Rules+Hooks"模式的核心：hook 引导 + rules 规范 + AI 执行
- **安全措施**：
  - hook 脚本只读不写（除审计日志外）
  - 所有 awkn-engine 路径硬编码为绝对路径 `d:\awkn-lab\awkn引擎\runtime\bin\awkn-engine.js`
  - 超时后静默退出，不阻塞 IDE

---

### 操作 4：追加 tianshu-dispatch 规则到 AGENTS.md

- **路径**：`d:\awkn-lab\AGENTS.md`
- **变更**：在文件末尾追加 `## tianshu-dispatch` 章节
- **规则内容**（基于 `loop-commands.md` 和 `README.md` 编写）：

```markdown
## tianshu-dispatch

### 何时路由到 awkn-engine（天枢）

当用户输入匹配以下模式时，使用 awkn-engine CLI 执行：

| 命令前缀 | CLI 调用 | 用途 |
|---------|---------|------|
| /goal | `node awkn-engine.js goal create/list/show/pause/resume/check-done` | L2 目标管理 |
| /loop | `node awkn-engine.js loop l1/l2/list-checkpoints/clear-checkpoint` | L1/L2 循环执行 |
| /skill | `node awkn-engine.js skill list/match/show` | 技能管理 |
| /hook | `node awkn-engine.js hook list/trigger/register` | 钩子管理 |
| /schedule | `node awkn-engine.js cron add/list/show/remove/enable/disable/start/stop/trigger` | 定时任务 |
| /orchestrate | `node awkn-engine.js orchestrate tianhuo-cicd/prd-centric` | 多 agent 编排 |
| /evolve | `node awkn-engine.js evolve detect/list/resolve/stats` | 自进化 |

### CLI 调用约定

- 引擎路径：`d:\awkn-lab\awkn引擎\runtime\bin\awkn-engine.js`
- 工作目录：`d:\awkn-lab\awkn引擎\runtime\`（确保 bridge dir、db 路径正确）
- LLM 桥接目录：`d:\awkn-lab\awkn引擎\runtime\data\llm-bridge`（AWKN_LLM_BRIDGE_DIR）
- 当引擎使用 trae provider 时，需启动 bridge-daemon 处理 LLM 请求

### 安全门禁

- 破坏性操作（delete/pause/clear-checkpoint）执行前必须向用户确认
- /goal 启动前必须明确停止条件和预算上限
- /orchestrate 启动前必须确认 goal 已创建
- /evolve detect 不会修改代码，只检测模式并写经验文件

### bridge-daemon 启动

当引擎需要 LLM 能力且使用 trae provider 时：
手动启动：`cd d:\awkn-lab\awkn引擎\runtime && npx tsx scripts/bridge-daemon.ts`
mock 模式：`AWKN_BRIDGE_MOCK=1 npx tsx scripts/bridge-daemon.ts`
```

- **安全措施**：追加在末尾，不修改现有 OpenClaw workspace 规则

---

### 操作 5：创建 CLAUDE.md（SOLO CN 专用）

- **路径**：`d:\awkn-lab\CLAUDE.md`
- **内容**：复制 AGENTS.md 的完整内容（含 tianshu-dispatch 章节）
- **原因**：SOLO CN 配置了 `AI.rules.importClaudeMd: true`，读取 CLAUDE.md 作为规则
- **同步策略**：每次 AGENTS.md 变更后，复制覆盖 CLAUDE.md
- **安全措施**：内容与 AGENTS.md 完全一致，无独立逻辑

---

### 操作 6：创建 skills 目录和 awkn-llm-bridge skill

- **路径**：`d:\awkn-lab\skills\awkn-llm-bridge\SKILL.md`
- **用途**：当 bridge-daemon 未运行时，IDE AI 可手动响应 runtime 的 LLM 请求
- **SKILL.md 内容摘要**：
  - 名称：awkn-llm-bridge
  - 触发条件：检测到 `runtime/data/llm-bridge/req-*.json` 文件存在
  - 执行步骤：读取 req 文件 → 调用 AI 自身能力处理 messages → 写回 resp 文件
  - 清理：resp 写入后由 runtime 自动清理 req+resp
- **安全措施**：skill 只读写 bridge 目录，不触碰其他文件

---

### 操作 7：配置环境变量（写入 runtime/.env）

- **路径**：`d:\awkn-lab\awkn引擎\runtime\.env`（从 `.env.example` 创建）
- **必需变量**：
```
AWKN_LLM_BRIDGE_DIR=d:\awkn-lab\awkn引擎\runtime\data\llm-bridge
AWKN_SKILLS_ROOT=d:\awkn-lab\skills
```
- **原因**：
  - `AWKN_LLM_BRIDGE_DIR`：解决 cwd 不一致问题（IDE hook cwd ≠ runtime cwd），使用绝对路径
  - `AWKN_SKILLS_ROOT`：指向新建的 skills 目录
- **安全措施**：不写入 API key（key 由 IDE 环境变量或用户手动配置）

---

## 三、操作依赖顺序

```
操作1（npm install）  ← 前置必需，否则引擎无法运行
    ↓
操作7（创建 .env）    ← 引擎配置
    ↓
操作2（删除失效 MCP）  ← 清理，可并行
操作3（创建 hook 脚本） ← 可并行
操作4（追加 AGENTS.md） ← 可并行
操作6（创建 skill）    ← 可并行
    ↓
操作5（创建 CLAUDE.md） ← 依赖操作4完成（复制 AGENTS.md）
```

---

## 四、不修改的文件（确认不动）

| 文件 | 原因 |
|------|------|
| `c:\Users\10919\.trae-cn\hooks.json` | 已正确配置 5 个 hook 点，无需修改 |
| `c:\Users\10919\AppData\Roaming\TRAE SOLO CN\User\mcp.json` | 不含 awkn-engine，无需修改 |
| `c:\Users\10919\AppData\Roaming\TRAE SOLO CN\User\settings.json` | 已配置 importClaudeMd，无需修改 |
| `d:\awkn-lab\awkn引擎\runtime\*` 源码 | 本次只配置 IDE 集成，不改引擎代码 |
| `d:\awkn-lab\awkn引擎\agents\*` | 不改 agent 配置 |

---

## 五、风险与回滚

| 风险 | 概率 | 影响 | 回滚方式 |
|------|------|------|---------|
| npm install 失败 | 低 | 引擎无法运行 | 检查网络/代理，重试 |
| hook 脚本超时阻塞 IDE | 低 | IDE 卡顿 | hooks.json 已设超时（10-180s），超时自动跳过 |
| bridge-daemon 未启动时引擎 LLM 调用超时 | 中 | L2 loop 失败 | 120s 后超时报错，不影响 IDE |
| AGENTS.md 追加内容过长影响上下文 | 低 | AI 上下文占用增加 | 后续可缩减（用户已确认"先追加再缩减"） |
| CLAUDE.md 与 AGENTS.md 不同步 | 中 | SOLO CN 规则过期 | 每次改 AGENTS.md 后复制覆盖 |

---

## 六、确认事项

请逐项确认：

- [ ] 操作1：执行 `npm install`（runtime 依赖安装）
- [ ] 操作2a：删除 `.trae-cn/mcp.json` 中的 awkn-engine 条目
- [ ] 操作2b：删除 `d:\awkn-lab\.mcp.json` 中的 awkn-engine 条目
- [ ] 操作3：创建 `d:\awkn-lab\.trae\hooks\tianshu-hook.mjs`（5 个 hook 点）
- [ ] 操作4：追加 tianshu-dispatch 章节到 `d:\awkn-lab\AGENTS.md`
- [ ] 操作5：创建 `d:\awkn-lab\CLAUDE.md`（复制 AGENTS.md）
- [ ] 操作6：创建 `d:\awkn-lab\skills\awkn-llm-bridge\SKILL.md`
- [ ] 操作7：创建 `d:\awkn-lab\awkn引擎\runtime\.env`

全部确认后开始执行。如有任何项需要调整，请标注。
