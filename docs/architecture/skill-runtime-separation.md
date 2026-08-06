# Skill、自动流、执行包与运行数据边界

## 系统层

AWKN 技能平台拆分为五个独立层：

```text
AWKN-Lab/skills              正式可发现 Skill
awkn引擎/workflows           自动流与任务编排
awkn引擎/packages            执行实现与契约
awkn引擎/runtime/data        可变状态、Receipt、日志、遥测
D:/awkn-lab/skill-sources    外部来源、Marketplace、插件快照
```

## 组件层

### Skill 发布层

一个正式 Skill 对应一个一级目录和一个根 `SKILL.md`。目录只保存发现入口、静态说明和轻量 references。

### 自动流层

自动流负责任务顺序、错误传播、跨包调用和产物路径，不进入 Skill 仓。

### 执行包层

执行包保存评分、安全扫描、状态机、审批、事务、Schema 与测试。

### Runtime 数据层

所有可变数据写入 Runtime。任何执行不得向正式 Skill 目录写入状态和日志。

### 来源仓

原始插件和上游 Skill 只进入来源仓。经过测评和治理批准后，提取真 Skill 发布到正式 Skill 仓一级目录。

## 模块层

```text
packages/skill-evaluator/
├─ src/awkn_skill_evaluator/security.py
├─ src/awkn_skill_evaluator/scoring.py
├─ src/awkn_skill_evaluator/orchestrator.py
├─ contracts/assessment-result.schema.json
└─ tests/

packages/skill-governance/
├─ src/awkn_skill_governance/engine.py
├─ src/awkn_skill_governance/orchestrator.py
├─ contracts/governance-decision.schema.json
└─ tests/

workflows/skill-platform/
├─ evaluate.py
└─ govern.py
```

## 强制规则

正式 Skill 目录禁止新增：

```text
absorbed-skills/
scripts/
skills/
data/
logs/
telemetry/
receipts/
```

迁移期旧文件可以作为不可发现的 tombstone 或兼容转发器短暂存在；完成物理迁移后移入备份或来源仓。

## 验收

```bash
pytest -q scripts/test_skill_repository_boundary.py
pytest -q packages/skill-evaluator/tests/test_evaluator.py
pytest -q packages/skill-governance/tests/test_governance.py
```
