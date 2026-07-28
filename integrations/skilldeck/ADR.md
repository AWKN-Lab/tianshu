# ADR · SkillDeck 引擎内集成边界

**状态**：Accepted
**日期**：2026-07-28
**替代**：`docs/2026-07-28-授权确认书-skilldeck吸收方案.md`（原方案 B 仓库外独立工具）

## 决策

SkillDeck 后续可视化组件仅可放入 `integrations/skilldeck/`，禁止外部目录部署和外部仓库写入。

## 边界

- **允许**：
  - 在 `integrations/skilldeck/` 内放置 ADR、协议边界文档
  - 在 `integrations/skilldeck/` 内放置可视化组件（后续 PR）
  - 通过文件协议与 `skills/awkn-技能治理/registry.json` 交互（只读）
  - 通过 `skills/awkn-技能治理/skill-cli.py` 的 `cards/invoke-text/expert/auto-tag` 命令写入专家数据

- **禁止**：
  - 创建或修改外部项目（如 `D:\awkn-lab\TRAE练习\skilldeck`）
  - 上线未经批准的外部 LLM 链路
  - 在 `runtime/` 内引入 MCP SDK 或 HTTP 服务器
  - 在 `integrations/skilldeck/` 外创建 SkillDeck 相关文件

## 本阶段提交范围

- 本 ADR 文件
- 协议边界文档（如有）

## 后续 PR 范围

- 可视化组件（Web UI 或 MCP 插件形态）
- 但必须位于 `integrations/skilldeck/` 内
- 必须通过 Phase 6 PR 3 的独立审核

## 关联

- 规范：`.trae/specs/merge-phase6-mainline-series/spec.md`
- 原方案：`docs/2026-07-28-授权确认书-skilldeck吸收方案.md`（已改写为 ADR）
- 桥接过渡：`skills/.system/skilldeck-bridge/SKILL.md`（等待归档）
- skill-cli.py 命令：`skills/awkn-技能治理/skill-cli.py`（cards/invoke-text/expert/auto-tag）
