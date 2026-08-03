# Cursor MCP 接入

## 配置文件

`~/.cursor/mcp.json`（Windows: `%USERPROFILE%\.cursor\mcp.json`）

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
node awkn引擎/runtime/scripts/install-mcp-config.mjs --ide cursor
```

## 验证

1. 重启 Cursor
2. 打开 Composer (Ctrl+I)
3. 在 Agent 模式下输入：`使用 awkn_engine 调用 awkn_skill_list`
4. 期望看到技能列表

## Cursor 特殊说明

Cursor 当前支持的 MCP tool schema 字段：
- ✅ `name`, `description`, `inputSchema`
- ⚠️ 部分 IDE-specific 字段（如 `annotations`）被忽略

AWKN 引擎仅使用标准字段，兼容良好。
