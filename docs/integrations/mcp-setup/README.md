# AWKN MCP Server 跨 IDE 适配指南

> Spiral 6 选项 A — 让 AWKN 引擎在主流 IDE 中开箱即用。

## 概述

AWKN 引擎通过 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) stdio 传输暴露 7 大模块能力：

- `goal` — L2 目标管理
- `loop` — L1/L2 循环执行
- `skill` — 技能管理
- `hook` — 事件钩子
- `cron` — 定时任务
- `orchestrate` — 多 Agent 编排
- `evolve` — 自进化

任何支持 MCP stdio 的 IDE 都可一键接入。

## 支持的 IDE

| IDE | 文档 | 配置格式 |
|---|---|---|
| TRAE | [trae.md](./trae.md) | JSON |
| Claude Code | [claude-code.md](./claude-code.md) | JSON |
| Cursor | [cursor.md](./cursor.md) | JSON |
| Windsurf | [windsurf.md](./windsurf.md) | JSON |
| Codex CLI | [codex.md](./codex.md) | TOML |

## 快速开始（自动安装）

```bash
cd awkn引擎/runtime
node scripts/install-mcp-config.mjs --ide trae
```

支持的 `--ide`：`trae` / `claude-code` / `cursor` / `windsurf` / `codex`

不传 `--ide` 时脚本自动检测已安装的 IDE 并逐一安装。

## 手动配置（5 分钟）

每个 IDE 文档均提供：

1. 配置文件路径
2. 完整 JSON/TOML 片段
3. 环境变量注入方式
4. 验证步骤（启动后调用 `awkn_goal_list` 等）

## 跨平台路径解析

`awkn-mcp-server.js` 自动从入口向上解析引擎根目录，Windows/macOS/Linux 行为一致：

- 引擎根检测：`skills/` + `capabilities/project/manifest.yaml` 双标记
- 环境变量回退：`AWKN_ENGINE_ROOT`

无需在 IDE 配置中硬编码绝对路径。

## 入口协议

```
node <engine-root>/awkn引擎/runtime/bin/awkn-mcp-server.js
```

stdio 通信：stdout = JSON-RPC，stderr = 日志。

## 工具命名约定

`awkn_<module>_<action>`（如 `awkn_goal_create`、`awkn_loop_l1`）

详细工具列表参见 [MCP 工具参考](../../runtime/src/mcp/server.ts) 或运行 `awkn-mcp-server.js` 后调用 `tools/list`。

## 故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| IDE 无法启动 MCP | `tsx` 未安装 | 在 `awkn引擎/runtime` 执行 `npm install` |
| 工具调用超时 | LLM 路由未配置 | 检查 `AWKN_LLM_*` 环境变量或运行 `bridge-daemon` |
| 路径解析失败 | 引擎根标记缺失 | 设置 `AWKN_ENGINE_ROOT` 环境变量 |
| stdio 通信异常 | 日志污染 stdout | 引擎已自动重定向 console.log → console.error |

## 不在本轮范围

- HTTP/SSE 传输（Web IDE / 远程 IDE）— 留待 Phase 6.3
- OAuth / Token 认证 — 留待 Phase 7
- VS Code / JetBrains 原生扩展 — 不在 Spiral 6 范围
