# Codex CLI MCP 接入

## 配置文件

`~/.codex/config.toml`

## 配置内容

```toml
[mcp_servers.awkn-engine]
command = "node"
args = ["<ENGINE_ROOT>/awkn引擎/runtime/bin/awkn-mcp-server.js"]

[mcp_servers.awkn-engine.env]
AWKN_ENGINE_ROOT = "<ENGINE_ROOT>/awkn引擎"
```

## 自动安装

```bash
node awkn引擎/runtime/scripts/install-mcp-config.mjs --ide codex
```

## 验证

1. 重启 Codex CLI
2. 执行：`codex mcp list`
3. 期望看到 `awkn-engine` 列出

## TOML 语法注意

- 路径字符串建议用单引号包裹（避免 Windows 反斜杠转义问题）
- 多行 env 用 `[[mcp_servers.awkn-engine.env]]` 数组形式
- 已存在 `[mcp_servers]` section 时脚本会追加，不会覆盖
