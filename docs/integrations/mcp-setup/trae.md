# TRAE MCP 接入

## 配置文件

`~/.trae/mcp.json`（Windows: `%USERPROFILE%\.trae\mcp.json`）

## 配置内容

```json
{
  "mcpServers": {
    "awkn-engine": {
      "command": "node",
      "args": ["<ENGINE_ROOT>/awkn引擎/runtime/bin/awkn-mcp-server.js"],
      "env": {
        "AWKN_ENGINE_ROOT": "<ENGINE_ROOT>/awkn引擎",
        "AWKN_LLM_BRIDGE_DIR": "<ENGINE_ROOT>/awkn引擎/runtime/data/llm-bridge"
      }
    }
  }
}
```

`<ENGINE_ROOT>` 替换为你的引擎根绝对路径。Windows 示例：`D:/awkn-lab`，macOS/Linux 示例：`/Users/you/work`。

## 自动安装

```bash
node awkn引擎/runtime/scripts/install-mcp-config.mjs --ide trae
```

## 验证

1. 重启 TRAE
2. 在对话中输入：`调用 awkn_goal_list 列出所有目标`
3. 期望看到目标列表（可能为空数组）

## 常见问题

**Q: Windows 路径反斜杠？**
A: 配置文件使用正斜杠或转义反斜杠。自动安装脚本已处理。

**Q: 多实例？**
A: 可配置多个 server（如 `awkn-engine-dev`），使用不同的 `AWKN_ENGINE_ROOT`。
