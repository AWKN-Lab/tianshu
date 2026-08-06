# Skill Governance Runtime Data

该目录保存技能治理运行时可变数据。

```text
state/governance-state.json
receipts/<decision-id>.json
logs/
telemetry/
transactions/
```

规则：

- 不把这些文件写入 `AWKN-Lab/skills`。
- 状态文件通过文件锁、版本号和原子替换更新。
- Receipt 提交失败时恢复旧状态。
- 生产环境应由备份和保留策略管理本目录。
