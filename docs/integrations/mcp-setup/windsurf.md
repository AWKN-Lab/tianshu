# Windsurf MCP 接入

## 配置文件

`~/.codeium/windsurf/mcp_config.json`（Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`）

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
node awkn引擎/runtime/scripts/install-mcp-config.mjs --ide windsurf
```

## 验证

1. 重启 Windsurf
2. 打开 Cascade 面板
3. 输入：`@awkn awkn_goal_list`
4. 期望看到目标列表

## 注意

Windsurf 的 MCP 支持在快速迭代中，部分 tool schema 字段可能受限。建议优先用基础 tool（goal/loop/skill）。
