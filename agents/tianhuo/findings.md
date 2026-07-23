# findings.md - 天火本地发现记录

定位: deep/recovery 模式的本地发现库。用于保存研究发现、外部资料摘要、风险证据和验证依据。

---

## 使用规则

- 每 2 次重要探索后，记录关键发现。
- 只写摘要和结论，不复制长篇外部正文。
- 每条发现必须标注来源类型: local_file、command、user_feedback、web、external_skill_source、inference。
- 发现进入核心规则前，必须经过 review/verify 和 evolutionGate。

---

## 发现模板

```yaml
findingId: FND-YYYYMMDD-001
sourceType: local_file | command | user_feedback | web | external_skill_source | inference
source: ""
claim: ""
evidence: ""
confidence: low | medium | high
implication: ""
nextAction: ""
```

---

## 当前发现

| ID | 来源 | 发现 | 置信度 | 下一步 |
|----|------|------|--------|--------|
| FND-20250530-001 | local_file | types.ts：旧4阶段函数 getStageKey/getStageName/getStageNameEn 仍在被 deriveDestinyKline.ts 引用；新增 BULL_MARKET_STAGES 为并行，不覆盖旧函数 | high | Step 1 新增类型时不删除旧函数 |
| FND-20250530-002 | local_file | deriveDestinyKline.ts 第 469 行调用 getStageKey(currentScore)；第 548-564 行 currentStage 对象硬编码分数段描述 | high | 改阈值同时更新 i18n key 格式 |
| FND-20250530-003 | local_file | LifeKLineChart.tsx：已有分页/Short Cycle/MACD；阶段颜色条参考现有 ReferenceLine 方案（大运分割线，第 635-639 行）实现 | high | 加阶段视图时注意状态隔离 |
| FND-20250530-004 | inference | 分数阈值 45→40 边界变化：原 40-44 归 recovery，改后归 stage1；需验证旧数据在此区间的渲染是否正确 | medium | 重构后跑一遍历史数据验证 |

