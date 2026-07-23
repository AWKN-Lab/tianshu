# modes/README.md - 天火模式索引

版本: v6.0
定位: deep/review/recovery 模式入口。默认 P0 不读取本目录。

| 模式 | 入口 | 触发 |
|------|------|------|
| deep | `deep-mode.prompt` | 复杂、长期、多轮、3+ 步、用户要求深度 |
| review | `review-mode.prompt` | 用户纠正、验收前自审、方向偏差 |
| recovery | `recovery-mode.prompt` | 卡住、连续失败、上下文恢复 |

模式文件只定义按需规则，不替代 `agent.prompt`。

