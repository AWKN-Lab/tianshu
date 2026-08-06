# 2026-08-06 Skill 运行时解耦迁移回执

## 已完成

### 正式 Skill

- `awkn-技能测评` 升级为 4.0.0 薄入口。
- `awkn-技能治理` 升级为 3.0.0 薄入口。
- 两个根 Skill 只声明意图、输入输出、运行时服务和工作流入口。
- 13 个嵌套组件 `SKILL.md` 已移除 frontmatter，停止作为独立 Skill 发现。

### 执行包

```text
packages/skill-evaluator
packages/skill-governance
```

已迁移：

- E1-E6 编排。
- 15 条安全预检。
- 证据约束评分。
- AssessmentResult Schema。
- G1-G7 编排。
- 生命周期状态机。
- 测评新鲜度检查。
- 独立审批。
- 原子状态与 Receipt。
- GovernanceDecision Schema。

### 自动流

```text
workflows/skill-platform/evaluate.py
workflows/skill-platform/govern.py
```

### Runtime 数据

默认位置：

```text
runtime/data/skill-governance
```

### 来源仓

目标位置已建立：

```text
D:/awkn-lab/skill-sources
```

已写入 `migration-manifest.json`。

### 防污染门禁

- Skill 仓 `.gitignore` 已阻止自动流、运行数据和来源仓继续进入两个正式 Skill。
- 新增 `scripts/test_skill_repository_boundary.py`。
- 新执行包不得引用旧 Skill 脚本和 absorbed-skills。
- 新治理巡检会把 `absorbed-skills/data/logs/telemetry` 判定为 `SKILL_REPOSITORY_POLLUTION`。

## 验证

新执行包与边界：

```text
15 passed
```

旧入口兼容回归：

```text
17 passed
```

合计：

```text
32 passed
```

## 物理迁移待执行

当前 MCP 提供文件读取和覆盖能力，没有移动、删除或 PowerShell 执行权限。因此下列目录仍物理存在，但已停止作为权威入口：

```text
skills/awkn-技能治理/absorbed-skills
skills/awkn-技能治理/scripts
skills/awkn-技能治理/skills
skills/awkn-技能治理/data
skills/awkn-技能治理/logs
skills/awkn-技能治理/telemetry
skills/awkn-技能治理/skill-cli.py
skills/awkn-技能测评/scripts
skills/awkn-技能测评/skills
```

已生成安全迁移脚本：

```text
scripts/migrate-skill-boundaries.ps1
```

脚本默认 dry-run；`-Apply` 时：

1. 将 absorbed sources 移入 `D:/awkn-lab/skill-sources`。
2. 将旧自动流、数据和组件目录移入 `D:/awkn-lab/_backup/skill-boundary-20260806`。
3. 更新来源仓迁移状态。

## 工作区隔离说明

`AWKN-Lab/skills` 当前相对 HEAD 存在大量第三方来源删除，尤其是 Qoder Marketplace 文件。这些删除在本轮之前已经存在，不属于本轮写入，提交时必须和本轮 Skill 边界迁移分开审查。
