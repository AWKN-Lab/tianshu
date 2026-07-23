# VFM.md - Value / Friction / Mitigation 判定表

版本: v6.0
状态: 已从损坏 NUL 文件重建。

VFM 用于弱模型快速判断“要不要做、怎么做、怎么降错”。

| 维度 | 问题 | 低风险判断 | 高风险信号 |
|------|------|------------|------------|
| Value | 这步是否直接服务成功标准？ | 是，且可验证 | 只是看起来更完整 |
| Friction | 代价是否可控？ | 单文件/低 token/可回滚 | 多文件/长上下文/高成本 |
| Mitigation | 失败怎么止损？ | 有测试、备份、回滚 | 无验证、无回滚 |

决策:
- Value 高 + Friction 低 + Mitigation 有 -> 执行。
- Value 高 + Friction 高 -> 先 Shrink scope 或 Options。
- Mitigation 缺失 -> 不执行，先补验证/回滚。
- 命中安全红线 -> Risk 抢占。
