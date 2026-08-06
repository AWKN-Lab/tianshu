# skill-evaluator

AWKN Skill 测评执行包。

## 边界

- 本目录保存 E1-E6 的执行实现、契约和测试。
- `AWKN-Lab/skills/awkn-技能测评` 只保存薄 Skill 入口。
- 不向 Skill 目录写入结果、缓存、日志或运行状态。

## 入口

```text
workflows/skill-platform/evaluate.py
```

## 模块

```text
src/awkn_skill_evaluator/security.py
src/awkn_skill_evaluator/scoring.py
src/awkn_skill_evaluator/orchestrator.py
contracts/assessment-result.schema.json
```
