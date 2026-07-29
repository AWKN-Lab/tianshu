# 天阶阶段卡

按 `discover → specify → plan → build → review → ship → evolve` 单向推进，每次只判断当前阶段。

## Review 阶段

1. 接收 build 阶段冻结的仓库、base/head、Diff 指纹、PRD/Spec 与验收标准引用。
2. 调用 Runtime Review Service；技能层不得复制规划、Finding 校验或 Verdict 逻辑。
3. 校验 `awkn-review-receipt/v1`、目标指纹、Reviewer 独立性和 100% 覆盖率。
4. 只有结构化 Verdict `PASS` 可推进 ship；`FAIL/PARTIAL/STALE/INVALID` 全部退回 build 整改。
5. 交接记录 Receipt ID、目标指纹、阻断 Finding 与修复顺序。自由文本 PASS 无效。
