# OpenCode MCP 接入

OpenCode 暂无自动安装脚本（`install-mcp-config.mjs` 不支持 `--ide opencode`），需手动配置。

## 配置文件

`~/.config/opencode/opencode.json`（Windows：`C:\Users\<user>\.config\opencode\opencode.json`）

## 配置内容

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "awkn-engine": {
      "type": "local",
      "command": [
        "node",
        "<ENGINE_ROOT>/awkn引擎/runtime/bin/awkn-mcp-server.js"
      ],
      "environment": {
        "AWKN_ENGINE_ROOT": "<ENGINE_ROOT>/awkn引擎"
      },
      "enabled": true
    }
  }
}
```

注意：Windows 路径在 JSON 中需用双反斜杠转义（`D:\\awkn-lab\\awkn引擎\\...`）。

## 验证

1. 重启 OpenCode 会话（MCP 在启动时加载）
2. 执行：`opencode mcp list`
3. 期望看到 `awkn-engine connected`

## 故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| 显示 not connected | 会话未重启 | 重启 opencode 会话 |
| 工具超时 | 引擎根标记缺失 | 确认 `AWKN_ENGINE_ROOT` 已设置 |
| `-c` unknown switch | 命令行顺序 | 配置只在 JSON 中生效，无需 CLI 参数 |

## 备注

- OpenCode 配置字段与 Codex TOML 不同：用 `command` 数组（非 `args`）、`environment`（非 `env`）、`type: "local"`。
- 已配置的 MCP 工具以 `awkn_<module>_<action>` 命名（如 `awkn_goal_list`）。
