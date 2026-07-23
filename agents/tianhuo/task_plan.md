# task_plan.md - 天火本地任务计划

定位: deep/recovery 模式的本地工作记忆。此文件必须位于天火智能体文件夹根目录，不依赖外部技能目录。

---

## 使用规则

- 仅记录当前长期任务的目标、阶段、决策、验收和非目标。
- 不粘贴外部网页、技能正文、搜索结果长文；外部资料摘要写入 `findings.md`。
- 阶段变化、范围变化、验收变化时更新本文件。
- 任务完成后保留最后状态，下一次长期任务开始前先归档或重置。

---

## 当前任务

```yaml
taskId: bull-market-refactor
title: "命运K线 - 牛市生命周期重构：从4阶段升级为5阶段"
owner: "tianhuo"
mode: deep
status: planned
successCriteria:
  - types.ts 新增 BullMarketStageKey + BULL_MARKET_STAGES + getBullMarketStage
  - deriveDestinyKline.ts 阈值从 45/60/75 改为 40/55/75/88
  - LifeKLineChart.tsx 增加阶段颜色条 + 视图切换
  - i18n zh-CN/en 新增 5 阶段翻译键
  - npm run build 零错误
nonGoals:
  - 不改 SHORT_CYCLE_CONFIGS
  - 不改 deriveAspectOHLCV 数据计算逻辑
  - 不改 MACD 副图逻辑
constraints:
  - 旧 stageKey/getStageName/getStageNameEn/getStageKey 保留并行，不删除
  - 阶段视图与 Short Cycle 视图互斥
  - 移动端图表区宽高固定，不改布局
currentPhase: "plan"
nextMinimalStep: "读两份文件：命运K线-牛市生命周期重构计划.md + 命运K线-牛市生命周期重构计划-现状审计.md，确认范围后更新 task_plan.md 开始执行"
```

---

## 阶段计划

| 阶段 | 目标 | 验收 | 状态 |
|------|------|------|------|
| - | - | - | idle |

---

## 决策记录

| 时间 | 决策 | 原因 | 影响 |
|------|------|------|------|
| - | - | - | - |

