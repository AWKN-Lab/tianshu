# Claude Code MCP 接入

## 配置文件

`~/.claude/mcp.json`（Windows: `%USERPROFILE%\.claude\mcp.json`）

## 配置内容

```json
{
  "mcpServers": {
    "awkn-engine": {
      "command": "node",
      "args": ["<ENGINE_ROOT>/awkn引擎/runtime/bin/awkn-mcp-server.js"],
      "env": {
        "AWKN_ENGINE_ROOT": "<ENGINE_ROOT>/awkn引擎"
      }
    }
  }
}
```

## 自动安装

```bash
node awkn引擎/runtime/scripts/install-mcp-config.mjs --ide claude-code
```

## 验证

1. 重启 Claude Code
2. 在对话中输入：`/mcp` 查看可用 MCP server
3. 期望看到 `awkn-engine` 列出且 25+ tools 可用

## 作用域

Claude Code 支持三层作用域（写入位置不同）：

| 作用域 | 配置位置 | 适用 |
|---|---|---|
| user | `~/.claude/mcp.json` | 个人所有项目 |
| project | `<project>/.mcp.json` | 当前项目团队 |
| local | `<project>/.mcp.local.json` | 个人当前项目 |

`install-mcp-config.mjs --ide claude-code` 默认安装到 user 作用域。

## 注意

Claude Code 的 stdio MCP server 需 `command` 可执行。Windows 上需使用 `node` 完整路径或 PATH 中能找到 `node`。
