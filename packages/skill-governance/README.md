# skill-governance

AWKN Skill 治理执行包。

## 边界

- 本目录保存 G1-G7 的执行实现、状态机、事务逻辑、契约和测试。
- `AWKN-Lab/skills/awkn-技能治理` 只保存薄 Skill 入口。
- 所有可变状态写入 `runtime/data/skill-governance`。
- Marketplace、插件容器和外部 Skill 源不进入本包。

## 入口

```text
workflows/skill-platform/govern.py
```

## 模块

```text
src/awkn_skill_governance/engine.py
src/awkn_skill_governance/orchestrator.py
contracts/governance-decision.schema.json
```
