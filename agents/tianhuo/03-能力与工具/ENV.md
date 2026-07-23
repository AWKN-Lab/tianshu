# ENV.md - 环境变量索引

版本: v6.0
状态: 已从损坏 NUL 文件重建。

本文件只记录变量名和用途，不保存真实值。

| 变量 | 用途 | 必需 | 备注 |
|------|------|------|------|
| `WEMP_APP_ID` | 微信/小程序 app id | 按需 | 不默认加载 |
| `WEMP_APP_SECRET` | 微信/小程序 app secret | 按需 | 禁止写入仓库 |
| `EVOMAP_DEVICE_ID` | EvoMap 设备标识 | 按需 | 可用本地配置覆盖 |
| `EVOMAP_NODE_ID` | EvoMap 节点标识 | 按需 | 非默认启动必需 |
| `MCP_MEMORY_URL` | 记忆服务地址 | 可选 | 本机服务才使用 |
| `NODE_ENV` | Node 运行环境 | 可选 | development/production |

规则:
- 真实密钥只存在本地环境或未跟踪文件。
- 示例文件使用 `${VAR_NAME}` 占位。
- 发现明文 secret 时触发 `Risk` 牌和 `safetyGate`。
